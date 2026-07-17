// ─── src/routes/revenuecat.ts ────────────────────────────────────────────────
// Webhook RevenueCat → source de vérité du plan dans PostgreSQL.
//
// CONFIGURATION (RevenueCat → Project Settings → Integrations → Webhooks) :
//   URL   : https://safetychecksback-production-c616.up.railway.app/webhooks/revenuecat
//   Auth  : valeur EXACTE de la variable Railway REVENUECAT_WEBHOOK_SECRET
//           (RevenueCat l'envoie telle quelle dans le header Authorization)
//
// CÔTÉ APP : Purchases.logIn(userId) OBLIGATOIRE après le register — ainsi
// event.app_user_id = notre cuid User.id et le mapping est direct.
//
// MAPPING DES ÉVÉNEMENTS :
//   INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE
//     → plan = BASIC, planExpiresAt = expiration_at_ms
//   EXPIRATION
//     → plan = FREE (fin réelle de l'accès)
//   CANCELLATION / BILLING_ISSUE
//     → AUCUN changement immédiat : l'utilisateur garde Basic jusqu'à
//       l'expiration de la période payée (comportement standard des stores).
//       resolveUserPlan() sert de filet si EXPIRATION n'arrive jamais.
//   Tout événement est journalisé dans SubscriptionEvent (support + stats MRR).

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/client.js";

const router = Router();

const UPGRADE_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "NON_RENEWING_PURCHASE",
]);

router.post("/", async (req: Request, res: Response) => {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    const auth = (req.headers.authorization as string) ?? "";

    if (!secret) {
      console.error("❌ REVENUECAT_WEBHOOK_SECRET not set — rejecting webhook");
      return res.status(500).json({ error: "Webhook not configured" });
    }
    if (auth !== secret && auth !== `Bearer ${secret}`) {
      console.warn("⚠️ RevenueCat webhook: invalid Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Payload ───────────────────────────────────────────────────────────
    const event = (req.body as any)?.event;
    if (!event?.type) {
      return res.status(400).json({ error: "Missing event in payload" });
    }

    const appUserId: string | undefined = event.app_user_id;
    // Les IDs anonymes ($RCAnonymousID:...) apparaissent si l'app n'a pas
    // encore fait Purchases.logIn(userId) — on journalise sans lier.
    const userId =
      appUserId && !appUserId.startsWith("$RCAnonymousID") ? appUserId : null;

    const expiresAt = event.expiration_at_ms
      ? new Date(Number(event.expiration_at_ms))
      : null;

    // ── Audit systématique (dashboard : MRR, conversions, churn) ─────────
    await db.subscriptionEvent.create({
      data: {
        userId,
        type: String(event.type),
        store: event.store ?? null,
        productId: event.product_id ?? null,
        environment: event.environment ?? null,
        expirationAt: expiresAt,
        payload: req.body as object,
      },
    });

    console.log(
      `💳 RevenueCat: ${event.type} — user=${userId ?? "anonymous"} ` +
        `product=${event.product_id ?? "?"} env=${event.environment ?? "?"}`,
    );

    // ── Mise à jour du plan ───────────────────────────────────────────────
    if (userId) {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!user) {
        console.warn(
          `⚠️ RevenueCat: user ${userId} not found in DB — event logged only`,
        );
      } else if (UPGRADE_EVENTS.has(event.type)) {
        await db.user.update({
          where: { id: userId },
          data: {
            plan: "BASIC",
            planExpiresAt: expiresAt,
            revenueCatUserId: event.original_app_user_id ?? appUserId ?? null,
          },
        });
        console.log(
          `✅ User ${userId} → BASIC (expires ${expiresAt?.toISOString() ?? "never"})`,
        );
      } else if (event.type === "EXPIRATION") {
        await db.user.update({
          where: { id: userId },
          data: { plan: "FREE", planExpiresAt: null },
        });
        console.log(`⬇️ User ${userId} → FREE (subscription expired)`);
      }
      // CANCELLATION / BILLING_ISSUE / TRANSFER / autres → audit seul
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ /webhooks/revenuecat error:", err);
    // 500 → RevenueCat réessaie automatiquement (retry avec backoff)
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
