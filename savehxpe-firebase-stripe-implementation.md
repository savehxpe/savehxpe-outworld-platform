---
exported: 2026-03-01T17:00:13.748Z
source: NotebookLM
type: chat
title: "# savehxpe_FIREBASE_STRIPE_IMPLEMENTATION.md

## 1..."
---

# # savehxpe_FIREBASE_STRIPE_IMPLEMENTATION.md

## 1...

导出时间: 01/03/2026, 19:00:13

---

````
# savehxpe_FIREBASE_STRIPE_IMPLEMENTATION.md

## 1. FIREBASE SETUP

### 1.1 Authentication Configuration
Firebase Authentication is implemented to handle identity management securely [1]. The system utilizes Email/Password authentication as the primary provider, with Google Sign-In as a federated fallback.
*   **Provider:** Email/Password (Enabled)
*   **Provider:** Google (Enabled)
*   **Action URL:** `https://app.savehxpe.com/__/auth/action`
*   **Token Expiration:** 1 hour (Default Firebase JWT lifecycle)

### 1.2 Firestore Collections Schema
The database operates on a NoSQL document model, optimized for mobile-first reads and fast synchronized state updates across clients [2].

*   `users`: Primary collection. Keyed by Firebase Auth `uid`.
*   `users/{uid}/transactions`: Subcollection tracking individual Stripe charges.
*   `users/{uid}/analytics`: Subcollection tracking login history and session telemetry.
*   `system_config`: Global read-only settings (e.g., current XP multiplier, global maintenance flags).
*   `stripe_webhooks_deadletter`: Collection for failed webhook payload processing.

### 1.3 User Document Structure
The user document schema is strictly defined. Nested objects are utilized for related states (XP, Tier, Subscriptions).

#### Actual JSON Example for User Document
```json
{
  "uid": "hxpe_abc123xyz890",
  "email": "fan@domain.com",
  "createdAt": {
    "_seconds": 1678123456,
    "_nanoseconds": 0
  },
  "lastLogin": {
    "_seconds": 1678209876,
    "_nanoseconds": 0
  },
  "stripeCustomerId": "cus_N2xYzaBcdE",
  "tier": {
    "current": "STANDARD",
    "previous": "FREE",
    "updatedAt": {
      "_seconds": 1678150000,
      "_nanoseconds": 0
    },
    "manualApprovalFlag": false
  },
  "subscriptionStatus": {
    "id": "sub_1MqwAbCdE",
    "status": "trialing",
    "cancelAtPeriodEnd": false,
    "currentPeriodEnd": {
      "_seconds": 1678728256,
      "_nanoseconds": 0
    }
  },
  "trialEndsAt": {
    "_seconds": 1678728256,
    "_nanoseconds": 0
  },
  "xp": {
    "total": 4500,
    "multiplier": 1.5,
    "lastUpdated": {
      "_seconds": 1678150500,
      "_nanoseconds": 0
    }
  },
  "collectibles": [
    {
      "id": "item_gen1_001",
      "acquiredAt": {
        "_seconds": 1678130000,
        "_nanoseconds": 0
      },
      "type": "audio_stem"
    }
  ],
  "engagementScore": 87.5
}
````
## 2\. STRIPE SETUP

Stripe is integrated to handle the financial layer, specifically managing recurring subscriptions and trial states.

### 2.1 Identifier Definitions

**Product ID (Standard Tier):**`prod_SaveHxpeStd01`

**Price ID (Standard Tier Monthly):**`price_1NxyZ2SaveHxpeStdMo`

**Price ID (Standard Tier Annual):**`price_1NxyZ2SaveHxpeStdYr`

**Trial Configuration:** Set to exactly 7 days on the Price object in the Stripe Dashboard. No credit card required upfront if utilizing the trial-without-payment-method flow, though capturing card data during checkout is strictly enforced to reduce friction at trial conversion\[1\]\[2\].

### 2.2 Required Webhook Events

Webhooks are essential to reflect changes executed on the Stripe console back into the Firebase environment automatically\[3\]\[4\].

`customer.subscription.created`: Fires when the 7-day trial begins.

`customer.subscription.updated`: Fires upon trial conversion to active, or if a user cancels mid-cycle.

`customer.subscription.deleted`: Fires when a subscription is explicitly canceled and the billing period ends.

`invoice.payment_failed`: Fires when the automated charge post-trial fails.

### 2.3 End-to-End Execution Flow

**Checkout:** User selects "Upgrade to Standard" in the mobile app. The app calls a Firebase Cloud Function `createCheckoutSession`.

**Session Creation:** Cloud function requests a Stripe Checkout Session using `stripeCustomerId` and `price_1NxyZ2SaveHxpeStdMo`.

**Redirect:** App redirects to the Stripe-hosted checkout URL.

**Conversion:** User inputs payment details and initiates the trial.

**Webhook Dispatch:** Stripe fires `customer.subscription.created` to `https://us-central1-savehxpe.cloudfunctions.net/stripeWebhook`.

**Firestore Update:** The webhook handler verifies the Stripe signature, extracts the customer ID, queries Firestore for the matching user, and updates the `tier.current` to `STANDARD` and sets `trialEndsAt`.

## 3\. CLOUD FUNCTION LOGIC

Server-side execution logic is deployed via Firebase Cloud Functions (Node.js/TypeScript)\[5\].

```
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

admin.initializeApp();
const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// 1. onUserCreate()
export const onUserCreate = functions.auth.user().onCreate(async (user) => {
    // Create Stripe Customer
    const customer = await stripe.customers.create({
        email: user.email,
        metadata: { firebaseUid: user.uid }
    });

    // Initialize Firestore Document
    const userRef = db.collection('users').doc(user.uid);
    await userRef.set({
        uid: user.uid,
        email: user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        stripeCustomerId: customer.id,
        tier: { current: 'FREE', previous: null, manualApprovalFlag: false },
        subscriptionStatus: { status: 'none' },
        xp: { total: 0, multiplier: 1.0 },
        collectibles: [],
        engagementScore: 0
    });
});

// 2. handleStripeWebhook()
export const handleStripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const data = event.data.object;
    const customerId = data.customer;

    // Locate user by Stripe Customer ID
    const userQuery = await db.collection('users').where('stripeCustomerId', '==', customerId).get();
    if (userQuery.empty) return res.status(404).send('User not found');
    const userDoc = userQuery.docs;

    switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
            await updateUserTier(userDoc.ref, data);
            if (data.status === 'trialing') {
                await grantTrialXPBonus(userDoc.ref);
            }
            break;
        case 'customer.subscription.deleted':
        case 'invoice.payment_failed':
            await revertToFreeTier(userDoc.ref, data);
            break;
    }
    res.json({received: true});
});

// 3. updateUserTier()
async function updateUserTier(userRef, subscriptionData) {
    const isTrial = subscriptionData.status === 'trialing';
    await userRef.update({
        'tier.current': 'STANDARD',
        'subscriptionStatus.id': subscriptionData.id,
        'subscriptionStatus.status': subscriptionData.status,
        'subscriptionStatus.currentPeriodEnd': new admin.firestore.Timestamp(subscriptionData.current_period_end, 0),
        'trialEndsAt': isTrial ? new admin.firestore.Timestamp(subscriptionData.trial_end, 0) : null,
        'xp.multiplier': 1.5 // Standard tier XP multiplier
    });
}

// 4. revertToFreeTier()
async function revertToFreeTier(userRef, subscriptionData) {
    await userRef.update({
        'tier.previous': 'STANDARD',
        'tier.current': 'FREE',
        'subscriptionStatus.status': subscriptionData.status === 'canceled' ? 'canceled' : 'past_due',
        'xp.multiplier': 1.0
    });
}

// 5. grantTrialXPBonus()
async function grantTrialXPBonus(userRef) {
    // Only grant if they haven't received it before (requires checking a subcollection log in production)
    await userRef.update({
        'xp.total': admin.firestore.FieldValue.increment(500)
    });
}
```
## 4\. TIER LOGIC

Tier state dictates component rendering and vault decryption paths on the client device.

### 4.1 Tier Definitions

**Free Tier:** Base state. `xp.multiplier = 1.0`. Vault access is restricted to items explicitly tagged "public".

**Standard Tier:** Triggered via Stripe subscription. 7-day trial period attached. `xp.multiplier = 1.5`. Unlocks full vault access.

**Premium Tier:** Gated via `manualApprovalFlag`. Contact-only upgrade. Represents VIP or "True Fan" access\[6\]. `xp.multiplier = 3.0`.

### 4.2 UI Verification Logic (React/Next.js)

```
// VaultRouter.jsx
import { useAuth } from '../hooks/useAuth';
import { Redirect } from 'react-router-dom';

const VaultOverlay = ({ tier, children }) => {
    if (tier === 'FREE') {
        return (
            <div className="vault-locked-overlay">
                <h2>Vault Access Restricted</h2>
                <p>Start your 7-day free trial to unlock exclusive stems and early access tracks.</p>
                <UpgradePromptButton targetTier="STANDARD" />
            </div>
        );
    }
    
    // Standard and Premium bypass overlay
    return <>{children}</>;
};

export const VaultSection = () => {
    const { user } = useAuth(); // Fetches live Firestore doc sync
    
    return (
        <section className="vault-container">
            <VaultOverlay tier={user.tier.current}>
                <UnlockedVaultContent data={user.collectibles} />
            </VaultOverlay>
        </section>
    );
};
```
## 5\. FIRESTORE SECURITY RULES

Security rules must act as the ultimate choke point, preventing client-side manipulation of state (like XP inflation or unauthorized tier upgrades)\[7\]\[8\].

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper Functions
    function isSignedIn() {
      return request.auth != null;
    }
    function isOwner(userId) {
      return isSignedIn() && request.auth.uid == userId;
    }

    match /users/{userId} {
      // Allow user to read their own data
      allow read: if isOwner(userId);
      
      // Allow user to update specific fields ONLY
      allow update: if isOwner(userId)
                    // PREVENT tier editing
                    && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['tier'])
                    // PREVENT xp inflation
                    && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['xp'])
                    // PREVENT trial manipulation
                    && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['trialEndsAt'])
                    // PREVENT manual collectible insertion
                    && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['collectibles'])
                    // PREVENT Stripe ID manipulation
                    && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['stripeCustomerId']);
                    
      // Prevent client-side document creation (Cloud Functions handle this)
      allow create: if false;
      allow delete: if false;
    }
    
    match /system_config/{configId} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```
## 6\. MOBILE-FIRST ARCHITECTURE

The client application is built with a mobile-first philosophy, utilizing responsive CSS grids and touch-optimized target areas.

### 6.1 App Routing Logic

`/login`: Choke point for sensitive operations. Handled via standalone view to aggregate user interaction telemetry (gyro, touch) for bot mitigation\[9\].

`/dashboard`: Primary authenticated route. Retrieves `user` document from Firestore.

`/vault`: Protected route. Renders `VaultOverlay` if `tier.current == 'FREE'`.

`/upgrade`: Handles Stripe Checkout redirects.

### 6.2 Dashboard Layout per Tier

**FREE:** Displays `UpgradePrompt` prominently in the header. Shows limited `collectibles` array (public items).

**STANDARD (Trial):** Renders `TrialCountdown` component.

_Logic:_ Calculates `trialEndsAt._seconds - current_time`. Shows urgent styling (Red/Bold) when `< 48 hours`.

**PREMIUM:** Renders custom UI themes. Renders direct contact/concierge widget.

### 6.3 Upgrade Prompt & Locked Content Logic

The `LockedContentOverlay` uses a blurred CSS backdrop (`backdrop-filter: blur(8px)`) over the `UnlockedVaultContent`. The `UpgradePrompt` button triggers a Firebase Callable Function that returns the Stripe Checkout URL, maintaining the user in the same cookie space until the absolute moment of transaction\[10\].

## 7\. DATA CAPTURE STRATEGY

To bypass algorithmic gatekeepers and establish a direct-to-fan (D2F) connection\[11\], data ownership is paramount.

### 7.1 Fields Stored

`email`: Primary contact mechanism for CRM marketing\[12\].

`createdAt`: Cohort analysis metric.

`tier`: Determines lifetime value (LTV) and segmentation.

`xp`: Gamification metric driving retention.

`collectibles`: Proof of fan engagement and potential Web3/NFT metadata mapping.

`stripeCustomerId`: Link to financial identity.

`trialEndsAt`: Trigger mechanism for automated email flows ("Your trial ends tomorrow!").

`engagementScore`: Algorithmic float value combining session frequency and interaction depth.

`lastLogin`: Identifies churn risk.

### 7.2 Long-Term Owned Data Execution

By capturing this data in Firestore rather than relying exclusively on social media APIs or external ticketing CRMs, the platform secures a first-party data asset. This allows the system to build a "time capsule" of fan history\[13\]\[14\], target highly specific email/SMS marketing campaigns, and map precise LTV without third-party cookie restrictions.

## FINAL SECTION: DEPLOYMENT CHECKLIST

**\[ \] Create Firebase Project:** Initialize project in Firebase Console.

**\[ \] Enable Auth:** Activate Email/Password provider in Firebase Authentication.

**\[ \] Set up Firestore:** Initialize database in native mode, set location to `us-central`.

**\[ \] Deploy Security Rules:** Push the `firestore.rules` file to production using Firebase CLI.

**\[ \] Create Stripe Products:** Create "SaveHxpe Standard" product and a recurring Price in Stripe Dashboard.

**\[ \] Set Trial Configuration:** Apply the 7-day trial flag to the Stripe Price object.

**\[ \] Register Webhook Endpoint:** Obtain Cloud Function URL, add it to Stripe Developers -> Webhooks.

**\[ \] Configure Secrets:** Store `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Firebase Secret Manager.

**\[ \] Deploy Cloud Functions:** Run `firebase deploy --only functions`.

**\[ \] Test Trial Flow:** Complete a signup using a Stripe test card, verify `trialEndsAt` is populated in Firestore.

**\[ \] Test Payment Failure:** Use Stripe CLI to simulate `invoice.payment_failed` event. Verify Firestore downgrades `tier.current` to `FREE`.

**\[ \] Test Tier Downgrade:** Ensure frontend UI re-locks the Vault immediately upon tier change.

**\[ \] Connect to Antigravity Hosting:** Map the compiled Next.js/React static build to Google Antigravity edge nodes. Set up custom domain routing.
---

## 引用来源

[1] Payment-methods-guide.pdf
[2] Payment-methods-guide.pdf
[3] 24.2.0 PayPal Integration guide.pdf
[4] 24.2.0 PayPal Integration guide.pdf
[5] L-G-0010466065-0024172313.pdf
[6] The-Buddy-System-PDF.pdf
[7] defending-against-bots-from-the-beginning.pdf
[8] defending-against-bots-from-the-beginning.pdf
[9] defending-against-bots-from-the-beginning.pdf
[10] defending-against-bots-from-the-beginning.pdf
[11] Owning-Your-Audience_WhitePaper_Fame-House.pdf
[12] The-Buddy-System-PDF.pdf
[13] switching-to-music-streaming-services-understanding-college-students-music-listening-habits-on-music-16556.pdf
[14] switching-to-music-streaming-services-understanding-college-students-music-listening-habits-on-music-16556.pdf
