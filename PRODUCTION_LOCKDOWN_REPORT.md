# SAVEHXPE — Production Lockdown Report
**Date:** 2026-03-01 21:42 SAST  
**Role:** Lead DevOps & Systems Engineer  
**Status:** ✅ ALL SYSTEMS GREEN — Ready for Team Push

---

## 1. GitHub Lock (.gitignore)

| Blocked Category | Patterns | Status |
|---|---|---|
| Environment Files | `.env`, `.env.*`, `.env.local`, `.env.production` | ✅ Blocked |
| Firebase Service Keys | `service-account*.json`, `firebase-adminsdk*.json`, `*-credentials.json` | ✅ Blocked |
| Private Keys | `*.pem`, `*.key`, `*.secret` | ✅ Blocked |
| Firebase Debug Logs | `firebase-debug.log`, `*-debug.log` | ✅ Blocked |
| Compiled Functions | `functions/lib/`, `functions/node_modules/` | ✅ Blocked |
| OS Artifacts | `.DS_Store`, `._*`, `Thumbs.db` | ✅ Blocked |

**Scan Result:** Zero `.env`, zero service account, zero credential files found in working directory.

---

## 2. Webhook Health Check (handleStripeWebhook)

### Signature Chain
```
Stripe Dashboard → POST /handleStripeWebhook
  → Header: stripe-signature
  → stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)
  → ✅ Cryptographic validation via whsec_ key in Secret Manager
  → ❌ Invalid sig → Dead-lettered to stripe_webhooks_deadletter collection
```

### Customer → UID Mapping
```
event.data.object.customer (Stripe Customer ID)
  → db.collection("users").where("stripeCustomerId", "==", customerId)
  → ✅ Exact match on stripeCustomerId field
  → Field written by onUserCreate at sign-up time (line 35)
  → No composite index required (single equality query)
```

### Tier Promotion Path
```
checkout.session.completed OR customer.subscription.created
  → userRef.update({ "tier.current": "STANDARD" })
  → userRef.update({ "xp.total": increment(500) })
  → ✅ Instant conversion, real-time sync to dashboard via onSnapshot
```

---

## 3. Security Posture

| Layer | Rule | Status |
|---|---|---|
| Firestore: `/users/{uid}` | Read: owner only. Write: owner only (tier/xp/stripe fields blocked). Create/Delete: server only. | ✅ |
| Firestore: `/stripe_webhooks_deadletter` | Read/Write: denied to all clients | ✅ |
| Storage: `/previews/**` | Public read | ✅ |
| Storage: `/handout/**` | Auth required | ✅ |
| Storage: `/**` (Vault) | Auth + STANDARD tier | ✅ |
| Cloud Functions | All secrets via `runWith({ secrets })` — no hardcoded keys | ✅ |

---

## 4. Runtime & Deployment

| Component | Version | Status |
|---|---|---|
| Node.js Runtime | 22 | ✅ |
| firebase-functions | 4.9.0 | ✅ (upgrade to 5.x recommended post-launch) |
| firebase-admin | 12.x | ✅ |
| stripe | 14.x | ✅ |

---

**GitHub repository is primed for the team push.**
