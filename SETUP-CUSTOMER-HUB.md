# Customer Hub — Guide d'activation

Ce document explique comment activer le hub sécurisé après paiement. Tout le code est déjà écrit, il reste uniquement de la configuration (5-10 minutes).

## Vue d'ensemble du flow

```
Client clique "Payer" → Stripe Payment Link → Stripe paiement
                                                    ↓
                                         Redirection automatique
                                                    ↓
                          /success.html?session_id=cs_live_xxxxx
                                                    ↓
                            success.html appelle /api/verify-payment
                                                    ↓
                       API vérifie le paiement auprès de Stripe
                                                    ↓
                  Si OK → Hub affiché avec lien de téléchargement
                  Si KO → Page d'erreur
```

## Étape 1 — Déployer sur Vercel (5 min)

GitHub Pages ne supporte pas les fonctions serverless. On passe sur Vercel (gratuit, intégration GitHub native).

1. Aller sur https://vercel.com → "Sign up with GitHub"
2. "Add New Project" → choisir le repo PetReady → Deploy (laisser les options par défaut)
3. À la fin, Vercel donne une URL `https://petready-xxx.vercel.app` qui fonctionne déjà
4. Pour brancher `petready.fr` : Settings → Domains → Add → suivre les instructions DNS

À partir de là, chaque `git push` redéploie automatiquement (comme GitHub Pages, en mieux).

## Étape 2 — Configurer les variables d'environnement Vercel

Dans le projet Vercel → Settings → Environment Variables, ajouter :

| Nom                        | Valeur (exemple)                                            | Où la trouver                                                |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`        | `sk_live_51AbCd...`                                         | dashboard.stripe.com → Développeurs → Clés API → "Clé secrète" (en mode Live) |
| `DOWNLOAD_STANDARD_URL`    | `https://drive.google.com/drive/folders/XXXXX?usp=sharing` | Lien partagé du dossier Drive du pack Standard               |
| `DOWNLOAD_MULTI_URL`       | `https://drive.google.com/drive/folders/YYYYY?usp=sharing` | Lien partagé du dossier Drive du pack Multi                  |
| `DOWNLOAD_PREMIUM_URL`     | `https://drive.google.com/drive/folders/ZZZZZ?usp=sharing` | Lien partagé du dossier Drive du pack Premium                |

**Pour chaque variable, cocher les 3 environnements** : Production, Preview, Development.

⚠️ Important : la `STRIPE_SECRET_KEY` ne doit JAMAIS apparaître dans le code GitHub. Toujours dans les env vars Vercel.

## Étape 3 — Configurer les Payment Links Stripe

Pour chacun des 3 Payment Links (Standard 49€, Multi 79€, Premium 149€) :

1. dashboard.stripe.com → mode **Live** → Catalogue → Liens de paiement → cliquer sur le lien
2. Onglet "Après le paiement" → choisir **"Ne pas afficher la page de confirmation Stripe — Rediriger vers votre site"**
3. Renseigner l'URL de redirection :
   ```
   https://petready.fr/success.html?session_id={CHECKOUT_SESSION_ID}
   ```
   ⚠️ Le `{CHECKOUT_SESSION_ID}` est un placeholder Stripe — laissez-le tel quel, Stripe le remplace automatiquement par le vrai ID.

4. Sauvegarder.

Faire cela pour les 3 liens.

## Étape 4 — Optionnel : récupérer les Price IDs pour plus de robustesse

Dans `api/verify-payment.js`, l'objet `PRICE_TO_PLAN` est vide. Sans ça, la détection du plan se fait via le montant (4900 = standard, 7900 = multi, 14900 = premium), ce qui marche déjà.

Si un jour vous changez les prix ou faites des promos, mieux vaut détecter le plan via le Price ID :

1. Pour chaque produit dans Stripe → "Prix" → copier l'ID `price_xxx`
2. Compléter dans `api/verify-payment.js` :
   ```js
   const PRICE_TO_PLAN = {
     'price_1ABCDxxxxStandard': 'standard',
     'price_1ABCDxxxxMulti':    'multi',
     'price_1ABCDxxxxPremium':  'premium',
   };
   ```
3. Commit + push → Vercel redéploie automatiquement.

## Étape 5 — Tester de bout en bout

1. Mode **Test** dans Stripe → utiliser les liens `test_xxx` avec la carte de test `4242 4242 4242 4242` (date future, CVC 123)
2. Après paiement, vous devez être redirigé sur `success.html?session_id=cs_test_xxx`
3. Le spinner tourne 2-3 secondes → "Merci [prénom] !" + bouton de téléchargement
4. Cliquer le bouton → s'ouvre sur Google Drive

Si quelque chose ne marche pas, ouvrez la console du navigateur (F12) — les erreurs y sont logguées.

## Sécurité — Comment c'est protégé

- ❌ Quelqu'un qui tape `petready.fr/success.html` sans session_id → page d'erreur
- ❌ Quelqu'un qui tape un faux session_id (`cs_test_fake`) → Stripe répond 404 → page d'erreur
- ❌ Quelqu'un qui devine le session_id d'un autre client → impossible, c'est un token cryptographique
- ✅ Un client qui revient 6 mois plus tard via son email Stripe → ça marche
- ✅ Un client qui partage son URL avec un ami → l'ami a accès aussi (c'est le compromis du modèle sans signup)

Pour empêcher le partage d'URL, on pourrait ajouter une expiration (genre 7 jours) — à voir plus tard si c'est un problème.

## Ce qui reste à faire avant la mise en prod réelle

- [ ] Déployer sur Vercel (étape 1)
- [ ] Renseigner les 4 env vars (étape 2)
- [ ] Configurer la redirection sur les 3 Payment Links (étape 3)
- [ ] Tester avec un paiement test (étape 5)
- [ ] Décocher "noindex" dans success.html si on veut indexer (non recommandé — c'est une page client)
