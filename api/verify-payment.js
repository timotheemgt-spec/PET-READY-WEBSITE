// Vercel Serverless Function: /api/verify-payment
// Vérifie auprès de Stripe qu'un session_id correspond à un paiement RÉEL ET RÉUSSI,
// puis renvoie le plan acheté + les liens de téléchargement.
//
// Variables d'environnement à configurer dans Vercel (Settings → Environment Variables) :
//   STRIPE_SECRET_KEY     = sk_live_xxxxxxxxxxxxx   (récupérée dans dashboard.stripe.com → Développeurs → Clés API)
//   DOWNLOAD_STANDARD_URL = https://drive.google.com/...
//   DOWNLOAD_MULTI_URL    = https://drive.google.com/...
//   DOWNLOAD_PREMIUM_URL  = https://drive.google.com/...

const Stripe = require('stripe');

// Map Stripe Price ID → plan key. À renseigner depuis vos vrais Price IDs Stripe.
// Vous les trouvez dans dashboard.stripe.com → Produits → cliquez sur le produit → l'ID du prix (commence par "price_")
const PRICE_TO_PLAN = {
  // Exemple :
  // 'price_1Q...standard': 'standard',
  // 'price_1Q...multi':    'multi',
  // 'price_1Q...premium':  'premium',
};

// Fallback : détecter le plan via le montant (en centimes EUR)
const AMOUNT_TO_PLAN = {
  4900:  'standard',
  7900:  'multi',
  14900: 'premium',
};

module.exports = async (req, res) => {
  // CORS minimal (utile si jamais on appelle depuis un autre domaine)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const sessionId = (req.query && req.query.session_id) || (req.body && req.body.session_id);
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Missing or invalid session_id' });
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.error('STRIPE_SECRET_KEY is not configured');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const stripe = Stripe(secretKey);

    // Récupère la session avec ses line items pour détecter le plan
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'line_items.data.price'],
    });

    // Vérifier que le paiement est bien réussi
    if (session.payment_status !== 'paid') {
      return res.status(402).json({
        verified: false,
        reason: `payment_status=${session.payment_status}`,
      });
    }

    // Détecter le plan
    let plan = null;
    const lineItem = session.line_items && session.line_items.data && session.line_items.data[0];
    if (lineItem && lineItem.price) {
      plan = PRICE_TO_PLAN[lineItem.price.id] || null;
    }
    if (!plan && session.amount_total) {
      plan = AMOUNT_TO_PLAN[session.amount_total] || null;
    }
    if (!plan) {
      console.warn('Could not determine plan for session', sessionId, session.amount_total);
      plan = 'standard'; // fallback prudent
    }

    // Liens de téléchargement (depuis env vars, sinon placeholder)
    const downloads = {
      standard: process.env.DOWNLOAD_STANDARD_URL || '',
      multi:    process.env.DOWNLOAD_MULTI_URL || '',
      premium:  process.env.DOWNLOAD_PREMIUM_URL || '',
    };

    return res.status(200).json({
      verified: true,
      plan,
      email: session.customer_details && session.customer_details.email,
      firstname: (session.customer_details && session.customer_details.name) || null,
      amount_total: session.amount_total,
      currency: session.currency,
      download_url: downloads[plan] || '',
      // Les liens des plans supérieurs ne sont pas exposés
      // (le client a payé pour son plan, pas pour les autres)
    });
  } catch (err) {
    console.error('verify-payment error:', err);
    // Si Stripe renvoie 404 (session_id inconnu), c'est probablement une URL bidouillée
    if (err && err.statusCode === 404) {
      return res.status(404).json({ verified: false, reason: 'unknown_session' });
    }
    return res.status(500).json({ error: 'Internal error' });
  }
};
