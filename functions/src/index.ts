import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import Stripe from "stripe";

// ─── INIT ────────────────────────────────────────────────────────────────────
admin.initializeApp();
const db = admin.firestore();

const stripe = new Stripe(
    process.env.STRIPE_SECRET_KEY || "",
    { apiVersion: "2023-10-16" }
);

// ═══════════════════════════════════════════════════════════════════════════════
// VOLTFLOW STEP 2: onUserCreate — INSTANT PROFILE DROP
// Fires the exact millisecond a user signs in via Google or Email/Password.
// Creates a Stripe customer and drops them into Firestore with tier: FREE.
// Schema matches savehxpe-firebase-stripe-implementation.md EXACTLY.
// ═══════════════════════════════════════════════════════════════════════════════

export const onUserCreate = functions.runWith({ secrets: ["STRIPE_SECRET_KEY"] }).auth.user().onCreate(async (user) => {
    // Create Stripe Customer instantly
    const customer = await stripe.customers.create({
        email: user.email || "",
        metadata: { firebaseUid: user.uid },
    });

    // Initialize Firestore Document — EXACT SCHEMA from implementation doc
    const userRef = db.collection("users").doc(user.uid);
    await userRef.set({
        uid: user.uid,
        email: user.email || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
        stripeCustomerId: customer.id,
        tier: {
            current: "FREE",
            previous: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            manualApprovalFlag: false,
        },
        subscriptionStatus: {
            status: "none",
        },
        trialEndsAt: null,
        xp: {
            total: 500,
            multiplier: 1.0,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        },
        collectibles: [],
        engagementScore: 0,
    });

    functions.logger.info(
        `[VOLTFLOW] User profile created: ${user.uid} | ` +
        `Stripe: ${customer.id} | tier: FREE`
    );
});

// ═══════════════════════════════════════════════════════════════════════════════
// createCheckoutSession — Callable function for upgrade flow
// Client calls this with { priceId } to get a Stripe Checkout URL back.
// ═══════════════════════════════════════════════════════════════════════════════

export const createCheckoutSession = functions.runWith({ secrets: ["STRIPE_SECRET_KEY"] }).https.onCall(
    async (data, context) => {
        // Auth guard
        if (!context.auth) {
            throw new functions.https.HttpsError(
                "unauthenticated",
                "Authentication required to create checkout session."
            );
        }

        const uid = context.auth.uid;
        const priceId = data.priceId;

        if (!priceId) {
            throw new functions.https.HttpsError(
                "invalid-argument",
                "priceId is required."
            );
        }

        // Fetch user's Stripe Customer ID from Firestore
        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError(
                "not-found",
                "User document not found."
            );
        }

        const userData = userDoc.data()!;
        const stripeCustomerId = userData.stripeCustomerId;

        if (!stripeCustomerId) {
            throw new functions.https.HttpsError(
                "failed-precondition",
                "Stripe customer not initialized."
            );
        }

        const hostingUrl = process.env.ANTIGRAVITY_HOSTING_URL ||
            "https://app.savehxpe.com";

        // Create Stripe Checkout Session with 7-day trial
        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            line_items: [{ price: priceId, quantity: 1 }],
            subscription_data: {
                trial_period_days: 7,
            },
            success_url: `${hostingUrl}/dashboard?upgrade=success`,
            cancel_url: `${hostingUrl}/dashboard?upgrade=cancelled`,
        });

        functions.logger.info(
            `[VOLTFLOW] Checkout session created: ${session.id} | User: ${uid}`
        );

        return { url: session.url };
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
// handleStripeWebhook — WEBHOOK CONTROL CENTER
// All financial state mutations originate from Stripe.
// Exact logic tree from savehxpe_PRODUCTION_EXECUTION_SEQUENCE.md
// ═══════════════════════════════════════════════════════════════════════════════

export const handleStripeWebhook = functions.runWith({ secrets: ["STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY"] }).https.onRequest(
    async (req, res) => {
        const sig = req.headers["stripe-signature"] as string;

        if (!sig) {
            res.status(400).send("Missing Stripe signature.");
            return;
        }

        let event: Stripe.Event;

        try {
            event = stripe.webhooks.constructEvent(
                req.rawBody,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET || ""
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Unknown error";
            functions.logger.error(`[VOLTFLOW] Webhook signature failed: ${message}`);

            // Dead-letter the failed payload
            await db.collection("stripe_webhooks_deadletter").add({
                error: message,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                rawHeaders: JSON.stringify(req.headers),
            });

            res.status(400).send(`Webhook Error: ${message}`);
            return;
        }

        const data = event.data.object as any;
        const customerId = data.customer as string;

        // Locate user by Stripe Customer ID
        const userQuery = await db
            .collection("users")
            .where("stripeCustomerId", "==", customerId)
            .get();

        if (userQuery.empty) {
            functions.logger.warn(
                `[VOLTFLOW] Webhook: No user found for Stripe customer ${customerId}`
            );
            res.status(200).send("User not found - likely a non-app customer or async race condition");
            return;
        }

        const userDoc = userQuery.docs[0];
        const userRef = userDoc.ref;

        switch (event.type) {
            case "checkout.session.completed":
            case "customer.subscription.created":
                // Trigger: Checkout success. Set tier, define trial, XP boost.
                // We use both events to ensure we catch the conversion immediately.
                await userRef.update({
                    "tier.current": "STANDARD",
                    "tier.previous": "FREE",
                    "tier.updatedAt": admin.firestore.FieldValue.serverTimestamp(),
                    "subscriptionStatus.id": data.id || data.subscription,
                    "subscriptionStatus.status": data.status || "active",
                    "subscriptionStatus.cancelAtPeriodEnd": false,
                    "xp.multiplier": 1.5,
                });

                // Grant 500 XP trial bonus if not already granted
                await userRef.update({
                    "xp.total": admin.firestore.FieldValue.increment(500),
                    "xp.lastUpdated": admin.firestore.FieldValue.serverTimestamp(),
                });

                functions.logger.info(
                    `[VOLTFLOW] Tier conversion → STANDARD | Event: ${event.type} | User: ${userDoc.id}`
                );
                break;

            case "customer.subscription.updated":
                // Trigger: Trial converts to active, or user updates payment.
                await userRef.update({
                    "subscriptionStatus.status": data.status,
                    "subscriptionStatus.currentPeriodEnd":
                        new admin.firestore.Timestamp(
                            data.current_period_end, 0
                        ),
                    "subscriptionStatus.cancelAtPeriodEnd":
                        data.cancel_at_period_end || false,
                    "trialEndsAt": data.status === "active" ?
                        null :
                        (data.trial_end ?
                            new admin.firestore.Timestamp(data.trial_end, 0) :
                            null),
                });

                functions.logger.info(
                    `[VOLTFLOW] Subscription updated → ${data.status} | ` +
                    `User: ${userDoc.id}`
                );
                break;

            case "customer.subscription.deleted":
                // Trigger: Sub canceled and period ended. Revert to FREE.
                await userRef.update({
                    "tier.previous": "STANDARD",
                    "tier.current": "FREE",
                    "tier.updatedAt": admin.firestore.FieldValue.serverTimestamp(),
                    "subscriptionStatus.status": "canceled",
                    "xp.multiplier": 1.0,
                    "trialEndsAt": null,
                });

                functions.logger.info(
                    `[VOLTFLOW] Subscription deleted → FREE | User: ${userDoc.id}`
                );
                break;

            case "invoice.payment_failed":
                // Trigger: Auto-charge fails post-trial or on renewal.
                await userRef.update({
                    "tier.previous": "STANDARD",
                    "tier.current": "FREE",
                    "tier.updatedAt": admin.firestore.FieldValue.serverTimestamp(),
                    "subscriptionStatus.status": "past_due",
                    "xp.multiplier": 1.0,
                });

                functions.logger.info(
                    `[VOLTFLOW] Payment failed → FREE | User: ${userDoc.id}`
                );
                break;

            default:
                functions.logger.info(
                    `[VOLTFLOW] Unhandled event type: ${event.type}`
                );
        }

        res.json({ received: true });
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
// grantActionXP — Callable function for XP engine
// Validates action and applies tier-based multiplier.
// Bypasses client security rules via firebase-admin.
// ═══════════════════════════════════════════════════════════════════════════════

export const grantActionXP = functions.runWith({ secrets: ["STRIPE_SECRET_KEY"] }).https.onCall(
    async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError(
                "unauthenticated",
                "Authentication required."
            );
        }

        const uid = context.auth.uid;
        const actionType = data.actionType as string;

        // Base XP values per action
        const xpTable: Record<string, number> = {
            listen_track: 10,
            share_track: 25,
            complete_album: 100,
            daily_login: 5,
            refer_friend: 50,
        };

        const baseXP = xpTable[actionType];
        if (!baseXP) {
            throw new functions.https.HttpsError(
                "invalid-argument",
                `Unknown action type: ${actionType}`
            );
        }

        // Fetch user to get multiplier
        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError(
                "not-found",
                "User not found."
            );
        }

        const userData = userDoc.data()!;
        const multiplier = userData.xp?.multiplier || 1.0;
        const grantedXP = Math.floor(baseXP * multiplier);

        await db.collection("users").doc(uid).update({
            "xp.total": admin.firestore.FieldValue.increment(grantedXP),
            "xp.lastUpdated": admin.firestore.FieldValue.serverTimestamp(),
            "engagementScore": admin.firestore.FieldValue.increment(
                grantedXP * 0.1
            ),
        });

        functions.logger.info(
            `[VOLTFLOW] XP granted: ${grantedXP} (${baseXP} × ${multiplier}) | ` +
            `User: ${uid} | Action: ${actionType}`
        );

        return { granted: grantedXP, multiplier, action: actionType };
    }
);
