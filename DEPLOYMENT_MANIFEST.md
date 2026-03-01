# 'HANDOUT' Launch Deployment Manifest
**Role:** Lead DevOps & Systems Engineer
**Status:** Pre-Flight Checks Complete

## 1. Secrets & Security Audit
- [x] **Firebase Admin SDK**: Initialized server-side using `admin.initializeApp()`. No service account JSON exposed in source.
- [x] **Stripe Private Key**: Moved to server-side `process.env.STRIPE_SECRET_KEY`. **CRITICAL:** Do not commit `.env` files to GitHub.
- [x] **Stripe Webhook Secret**: Moved to server-side `process.env.STRIPE_WEBHOOK_SECRET`.
- [x] **Client-Side Sanitization**: `firebase.js` and all HTML includes contain only public Firebase Configuration (API Key, Project ID). No secret parameters found.
- [x] **Storage Security Rules**: 
    - `/previews/**`: Public Read (Unlocked)
    - `/handout/**`: Auth Required (Unlocked for all logged-in fans)
    - `/**` (Vault): Auth + STANDARD Tier Required (Locked)

## 2. Webhook Control Center
- **Production Webhook URL**: `https://us-central1-savehxpe-prod.cloudfunctions.net/handleStripeWebhook`
- **Registration**: This URL must be added to the [Stripe Dashboard](https://dashboard.stripe.com/webhooks) for your production account.
- **Events to Listen For**:
    - `checkout.session.completed`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `invoice.payment_succeeded`

## 3. Domain Guard (Authorized Redirects)
- **Authorized Domain**: `savehxpe.com`
- **White-listing**: Ensure `savehxpe.com` is added to the [Firebase Authentication > Settings > Authorized Domains](https://console.firebase.google.com/project/savehxpe-prod/authentication/settings) list.
- **Fail-safe**: Mobile Google Sign-In will loop or error if this is not exactly matched.

## 4. Environment Variables Checklist
Before running `firebase deploy`, ensure the following are set via the Firebase CLI:
```bash
firebase functions:config:set stripe.secret="sk_live_..." stripe.webhook_secret="whsec_..." antigravity.hosting_url="https://savehxpe.com"
```
*Note: If using Firebase V2 functions, use `.env` files or Secret Manager.*

## 5. Deployment Step-by-Step
1. `firebase deploy --only functions` (Deploys onUserCreate, createCheckoutSession, handleStripeWebhook)
2. `firebase deploy --only firestore:rules,storage:rules` (Enforces the paywall/vault logic)
3. `firebase deploy --only hosting` (Pushes the Black Gateway and White Dashboard)

**Ready for GitHub Push and Production Deployment.**
