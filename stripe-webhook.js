// Vercel Serverless Function: /api/stripe-webhook
// Reçoit les événements Stripe (checkout.session.completed) et envoie un email
// de confirmation au client avec son lien magique vers le customer hub + lien Drive.
//
// Variables d'environnement requises (Vercel → Settings → Environment Variables) :
//   STRIPE_SECRET_KEY        = sk_live_xxx (déjà configurée pour verify-payment)
//   STRIPE_WEBHOOK_SECRET    = whsec_xxx (généré quand on crée le webhook dans Stripe)
//   RESEND_API_KEY           = re_xxx (depuis resend.com → API Keys)
//   FROM_EMAIL               = hello@petready.fr (l'expéditeur — doit être un domaine vérifié dans Resend)
//   SITE_URL                 = https://petready.fr (le domaine sur lequel pointe success.html)
//   DOWNLOAD_STANDARD_URL, DOWNLOAD_MULTI_URL, DOWNLOAD_PREMIUM_URL (déjà configurés)

const Stripe = require('stripe');

const PLAN_LABELS = {
  standard: 'Standard',
  multi:    'Multi-destinations',
  premium:  'Premium',
};

// Map montants en centimes → plan key (fallback si Price ID inconnu)
const AMOUNT_TO_PLAN = {
  4900:  'standard',
  7900:  'multi',
  14900: 'premium',
};

// IMPORTANT : Stripe envoie un body brut (raw bytes) qu'il faut lire intact pour la vérif de signature.
// On désactive le bodyParser par défaut de Vercel.
module.exports.config = {
  api: { bodyParser: false },
};

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    console.error('Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const stripe = Stripe(secretKey);

  // Vérifier la signature Stripe
  let event;
  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Ne réagit qu'à checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = event.data.object;

  // Re-fetch avec line_items pour identifier le plan
  let fullSession;
  try {
    fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items', 'line_items.data.price'],
    });
  } catch (err) {
    console.error('Failed to retrieve full session:', err);
    return res.status(500).json({ error: 'Failed to retrieve session' });
  }

  // Détecter le plan
  let plan = null;
  if (fullSession.amount_total && AMOUNT_TO_PLAN[fullSession.amount_total]) {
    plan = AMOUNT_TO_PLAN[fullSession.amount_total];
  }
  if (!plan) plan = 'standard';

  const email = fullSession.customer_details && fullSession.customer_details.email;
  const name = (fullSession.customer_details && fullSession.customer_details.name) || '';
  const firstname = name ? name.split(' ')[0] : 'vous';

  if (!email) {
    console.warn('No email on session', session.id);
    return res.status(200).json({ received: true, warn: 'no_email' });
  }

  const downloads = {
    standard: process.env.DOWNLOAD_STANDARD_URL || '',
    multi:    process.env.DOWNLOAD_MULTI_URL || '',
    premium:  process.env.DOWNLOAD_PREMIUM_URL || '',
  };
  const downloadUrl = downloads[plan] || downloads.standard;
  const siteUrl = process.env.SITE_URL || 'https://petready.fr';
  const hubUrl = `${siteUrl}/success.html?session_id=${encodeURIComponent(session.id)}`;
  const planLabel = PLAN_LABELS[plan];

  // Envoyer l'email via Resend
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'hello@petready.fr';
  if (!resendKey) {
    console.error('Missing RESEND_API_KEY — skipping email');
    return res.status(200).json({ received: true, warn: 'no_resend_key' });
  }

  const html = renderEmail({ firstname, planLabel, hubUrl, downloadUrl });
  const text = renderEmailText({ firstname, planLabel, hubUrl, downloadUrl });

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `PetReady <${fromEmail}>`,
        to: [email],
        subject: `Votre pack PetReady ${planLabel} est prêt 🐾`,
        html,
        text,
        reply_to: 'hello@petready.fr',
      }),
    });

    if (!resendRes.ok) {
      const body = await resendRes.text();
      console.error('Resend failed:', resendRes.status, body);
      return res.status(200).json({ received: true, email_error: resendRes.status });
    }
    const data = await resendRes.json();
    console.log('Email sent:', data.id, 'to', email);
  } catch (err) {
    console.error('Email send error:', err);
    return res.status(200).json({ received: true, email_exception: String(err) });
  }

  return res.status(200).json({ received: true, email_sent: true, plan });
};

// ============ EMAIL TEMPLATE (branded PetReady) ============

function renderEmail({ firstname, planLabel, hubUrl, downloadUrl }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Votre pack PetReady est prêt</title>
</head>
<body style="margin:0;padding:0;background:#F5EFE6;font-family:-apple-system,BlinkMacSystemFont,'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;color:#0E2A47;line-height:1.55;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE6;padding:32px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(14,42,71,0.08);">

        <!-- Header navy with eyebrow -->
        <tr>
          <td style="background:linear-gradient(135deg,#13314F 0%,#06182E 100%);padding:36px 40px 32px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:3px;color:#FF6B5B;text-transform:uppercase;margin-bottom:10px;">— PASSEPORT DIGITAL · ANIMAL</div>
            <div style="font-size:32px;font-family:'DM Serif Display',Georgia,serif;color:white;letter-spacing:-0.5px;line-height:1;">PetReady</div>
          </td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td style="padding:40px 40px 12px;">
            <h1 style="margin:0 0 12px;font-family:'DM Serif Display',Georgia,serif;font-size:32px;line-height:1.15;letter-spacing:-0.8px;color:#0E2A47;font-weight:400;">Merci ${escapeHtml(firstname)} 🐾</h1>
            <p style="margin:0;font-size:16px;color:#0E2A47;">
              Votre commande <strong>PetReady ${escapeHtml(planLabel)}</strong> est confirmée. Vous trouverez ci-dessous votre lien d'accès personnel et le téléchargement du pack.
            </p>
          </td>
        </tr>

        <!-- Primary CTA: hub link -->
        <tr>
          <td style="padding:24px 40px 12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="center" style="background:#FFF5F3;border:1.5px solid #FF6B5B;border-radius:14px;padding:24px 24px 20px;">
                  <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#FF6B5B;text-transform:uppercase;margin-bottom:8px;">VOTRE ACCÈS PERSONNEL</div>
                  <div style="font-size:14px;color:#0E2A47;margin-bottom:18px;">Ce lien reste actif. Sauvegardez cet email pour y revenir.</div>
                  <a href="${escapeAttr(hubUrl)}" style="display:inline-block;background:#FF6B5B;color:white;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600;font-size:15px;letter-spacing:0.3px;">Accéder à mon pack →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Backup download link -->
        <tr>
          <td style="padding:12px 40px 8px;">
            <p style="margin:0;font-size:13px;color:#6B7A8F;">
              <strong style="color:#0E2A47;">Lien direct de téléchargement</strong> (au cas où) :<br>
              <a href="${escapeAttr(downloadUrl)}" style="color:#E8554A;word-break:break-all;">${escapeHtml(downloadUrl)}</a>
            </p>
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:24px 40px 0;"><hr style="border:none;border-top:1px solid #E2D9C8;margin:0;"></td></tr>

        <!-- Next steps -->
        <tr>
          <td style="padding:24px 40px 8px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#FF6B5B;text-transform:uppercase;margin-bottom:14px;">— LES 3 PROCHAINES ÉTAPES</div>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="32" valign="top" style="padding:6px 0;"><div style="background:#FF6B5B;color:white;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:13px;">1</div></td>
                <td valign="top" style="padding:6px 0 14px;">
                  <div style="font-weight:600;font-size:15px;color:#0E2A47;margin-bottom:2px;">Ouvrez le PDF et lisez l'introduction</div>
                  <div style="font-size:13px;color:#6B7A8F;">~10 min. Elle vous explique l'ordre dans lequel attaquer les démarches.</div>
                </td>
              </tr>
              <tr>
                <td width="32" valign="top" style="padding:6px 0;"><div style="background:#FF6B5B;color:white;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:13px;">2</div></td>
                <td valign="top" style="padding:6px 0 14px;">
                  <div style="font-weight:600;font-size:15px;color:#0E2A47;margin-bottom:2px;">Dupliquez le Google Sheet "compteur de jours"</div>
                  <div style="font-size:13px;color:#6B7A8F;">Entrez votre date de voyage → il calcule toutes vos deadlines.</div>
                </td>
              </tr>
              <tr>
                <td width="32" valign="top" style="padding:6px 0;"><div style="background:#FF6B5B;color:white;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:13px;">3</div></td>
                <td valign="top" style="padding:6px 0 14px;">
                  <div style="font-weight:600;font-size:15px;color:#0E2A47;margin-bottom:2px;">Prenez RDV avec votre vétérinaire</div>
                  <div style="font-size:13px;color:#6B7A8F;">Utilisez le modèle de courrier #1 du pack — fait gagner du temps.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Support -->
        <tr>
          <td style="padding:8px 40px 32px;">
            <p style="margin:0;font-size:13px;color:#6B7A8F;">
              Une question ? Écrivez à <a href="mailto:hello@petready.fr" style="color:#E8554A;font-weight:600;">hello@petready.fr</a> — réponse sous 24h.<br>
              Garantie 14 jours satisfait ou remboursé.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0E2A47;padding:20px 40px;text-align:center;">
            <div style="font-size:11px;color:#8896AB;letter-spacing:0.5px;">© 2026 PetReady · Maison de voyage animal</div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function renderEmailText({ firstname, planLabel, hubUrl, downloadUrl }) {
  return `Merci ${firstname} !

Votre commande PetReady ${planLabel} est confirmée.

── VOTRE ACCÈS PERSONNEL ──
Ce lien reste actif, gardez-le précieusement :
${hubUrl}

── LIEN DIRECT DE TÉLÉCHARGEMENT ──
${downloadUrl}

── LES 3 PROCHAINES ÉTAPES ──
1. Ouvrez le PDF et lisez l'introduction (~10 min)
2. Dupliquez le Google Sheet "compteur de jours" et entrez votre date de voyage
3. Prenez RDV avec votre vétérinaire (utilisez le modèle de courrier #1 du pack)

Une question ? Écrivez à hello@petready.fr — réponse sous 24h.
Garantie 14 jours satisfait ou remboursé.

— L'équipe PetReady
https://petready.fr`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
