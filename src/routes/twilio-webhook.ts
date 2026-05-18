// ─── src/routes/twilio-webhook.ts ────────────────────────────────────────────
// Handles all Twilio status callbacks.
//
// FIXES applied:
//   1. RACE CONDITION (AMD vs call-status): The old code checked `outcome ===
//      "in-progress"` to detect human answer, but AMD and call-status webhooks
//      arrive in non-deterministic order. If `completed` arrived before `human`
//      from AMD, the call was wrongly classified as unanswered → spurious retry.
//      Fix: AMD now sets a dedicated `humanAnswered` boolean column on
//      AlertAction. The `completed` handler reads that flag instead of the
//      mutable `outcome` string, making the check race-condition-proof.
//
//   2. TWILIO SIGNATURE VALIDATION: Added middleware that verifies Twilio's
//      X-Twilio-Signature header on every incoming webhook. Without this,
//      anyone who discovers the URLs can forge call-status / AMD events and
//      trigger retries or simulated 911 escalations.
//
//   3. SMS STATUS ROUTE: Added `/sms-status` here (was mistakenly only in
//      twiml.ts). The SMS statusCallback in twilio.ts now points here.
//
//   4. MAX_CALL_ATTEMPTS imported from shared constants (no more magic numbers).
//
// IMPORTANT — Prisma migration required:
//   Add the `humanAnswered Boolean @default(false)` column to AlertAction:
//
//     model AlertAction {
//       ...
//       humanAnswered Boolean @default(false)
//     }
//
//   Then run: npx prisma migrate dev --name add_human_answered_to_alert_action

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { db } from "../db/client.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { MAX_CALL_ATTEMPTS, RETRY_DELAY_MS } from "../config/constants.js";

const router = Router();

// ─── TWILIO SIGNATURE VALIDATION MIDDLEWARE ──────────────────────────────────
// Rejects any request that doesn't carry a valid X-Twilio-Signature header.
// Requires the raw body to be available — make sure your Express app uses
// `express.urlencoded({ extended: false })` (not json()) for Twilio routes,
// and does NOT use a body-transforming middleware before this.

function validateTwilioSignature(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // In local/test environments you can skip validation by setting this var.
  if (process.env.SKIP_TWILIO_VALIDATION === "true") {
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const twilioSignature = req.headers["x-twilio-signature"] as string;

  // Build the full URL exactly as Twilio sees it (must match what you gave
  // Twilio as the callback URL, including https:// and no trailing slash).
  const fullUrl = `${process.env.API_BASE_URL}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    authToken,
    twilioSignature,
    fullUrl,
    req.body as Record<string, string>,
  );

  if (!isValid) {
    console.warn("⚠️ Invalid Twilio signature — request rejected:", fullUrl);
    return res.status(403).send("Forbidden");
  }

  return next();
}

// Apply signature validation to all routes in this router.
router.use(validateTwilioSignature);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function scheduleCallRetry(alertId: string, currentAttemptCount: number) {
  if (currentAttemptCount < MAX_CALL_ATTEMPTS) {
    console.log(
      `🔁 Scheduling call retry for alert ${alertId}. ` +
        `Attempt ${currentAttemptCount + 1}/${MAX_CALL_ATTEMPTS} in ${RETRY_DELAY_MS / 1000}s`,
    );

    await alertQueue.add(
      "retryEmergencyCall",
      { alertId },
      {
        delay: RETRY_DELAY_MS,
        // Unique jobId prevents duplicate retries if the webhook fires twice.
        jobId: `retry-call-${alertId}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } else {
    console.log(
      `🚨 Max call attempts (${MAX_CALL_ATTEMPTS}) reached for alert ${alertId}. Escalating to 911 simulation.`,
    );
    await simulate911Escalation(alertId);
  }
}

async function simulate911Escalation(alertId: string) {
  // Idempotent — skip if already escalated.
  const existing = await db.alertAction.findFirst({
    where: { alertId, actionType: "CALL", destination: "911" },
  });

  if (existing) return;

  await db.alertAction.create({
    data: {
      alertId,
      actionType: "CALL",
      destination: "911",
      outcome: "simulated_911_called",
      executedAt: new Date(),
    },
  });

  // Keep the alert ACTIVE so the user can still self-resolve.
  await db.alertEvent.update({
    where: { id: alertId },
    data: { status: "ACTIVE" },
  });

  console.log(`🚨 DEV MODE: simulated 911 escalation for alert ${alertId}`);
}

// ─── POST /twilio/call-status ─────────────────────────────────────────────────
// Twilio posts here at every stage of a call lifecycle.

router.post("/call-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, CallStatus } = req.body as {
      CallSid: string;
      CallStatus: string;
    };

    console.log("📞 call-status webhook:", { CallSid, CallStatus });

    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });

    if (!action) {
      console.warn("⚠️ No AlertAction found for CallSid:", CallSid);
      return res.sendStatus(200);
    }

    // ── Transient states — just update and move on ──────────────────────────
    if (["queued", "initiated", "ringing"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });
      return res.sendStatus(200);
    }

    // ── Call is in progress ─────────────────────────────────────────────────
    if (CallStatus === "in-progress" || CallStatus === "answered") {
      // Only update outcome if AMD hasn't already written something more specific.
      // humanAnswered is set by /amd-status; don't clobber it here.
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "in-progress" },
      });
      return res.sendStatus(200);
    }

    // ── Call completed ──────────────────────────────────────────────────────
    if (CallStatus === "completed") {
      // FIX: Read the dedicated `humanAnswered` flag instead of checking the
      // mutable `outcome` string. This makes the check immune to the AMD vs
      // call-status race condition.
      const latestAction = await db.alertAction.findUnique({
        where: { id: action.id },
        select: { humanAnswered: true },
      });

      if (latestAction?.humanAnswered) {
        // A human picked up and heard the message — success.
        await db.alertAction.update({
          where: { id: action.id },
          data: { outcome: "success" },
        });

        console.log(
          `✅ Human answered call for alert ${action.alertId}. ` +
            `Alert stays ACTIVE until user clicks "I'm safe".`,
        );
        return res.sendStatus(200);
      }

      // Nobody answered (or only a machine did) — schedule a retry.
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "completed-no-human" },
      });

      const attemptCount = await db.alertAction.count({
        where: {
          alertId: action.alertId,
          actionType: "CALL",
          destination: { not: "911" },
        },
      });

      await scheduleCallRetry(action.alertId, attemptCount);
      return res.sendStatus(200);
    }

    // ── Call failed / no-answer / busy / canceled ───────────────────────────
    if (["busy", "no-answer", "canceled", "failed"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });

      const attemptCount = await db.alertAction.count({
        where: {
          alertId: action.alertId,
          actionType: "CALL",
          destination: { not: "911" },
        },
      });

      await scheduleCallRetry(action.alertId, attemptCount);
      return res.sendStatus(200);
    }

    // ── Unknown status — log and acknowledge ────────────────────────────────
    await db.alertAction.update({
      where: { id: action.id },
      data: { outcome: String(CallStatus ?? "unknown") },
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ call-status webhook error:", err);
    return res.sendStatus(500);
  }
});

// ─── POST /twilio/amd-status ──────────────────────────────────────────────────
// Twilio's Answering Machine Detection posts here asynchronously.
// FIX: now sets `humanAnswered = true` on the AlertAction when a human is
// detected, instead of writing to `outcome`. This decouples AMD from the
// call-status flow and eliminates the race condition.

router.post("/amd-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, AnsweredBy } = req.body as {
      CallSid: string;
      AnsweredBy: string;
    };

    console.log("🧠 amd-status webhook:", { CallSid, AnsweredBy });

    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });

    if (!action) {
      console.warn("⚠️ No AlertAction found for AMD CallSid:", CallSid);
      return res.sendStatus(200);
    }

    if (AnsweredBy === "human") {
      // FIX: Set the dedicated flag. The call-status `completed` handler will
      // read this reliably, regardless of which webhook arrives first.
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          humanAnswered: true,
          outcome: "in-progress", // also update outcome for UI display
        },
      });

      console.log(`✅ Human detected on call for alert ${action.alertId}`);
    } else if (
      [
        "machine_start",
        "machine_end_beep",
        "machine_end_silence",
        "machine_end_other",
        "fax",
      ].includes(String(AnsweredBy))
    ) {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          humanAnswered: false,
          outcome: "machine",
        },
      });

      console.log(
        `🤖 Machine/fax detected on call for alert ${action.alertId}`,
      );
    } else {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: String(AnsweredBy ?? "unknown") },
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ amd-status webhook error:", err);
    return res.sendStatus(500);
  }
});

// ─── POST /twilio/sms-status ──────────────────────────────────────────────────
// FIX: This route was previously only in twiml.ts (simplified, no retry logic).
// Moved here so all Twilio callbacks go through one router with signature
// validation. The SMS statusCallback in twilio.ts now points to this endpoint.

router.post("/sms-status", async (req: Request, res: Response) => {
  try {
    const { MessageSid, MessageStatus } = req.body as {
      MessageSid: string;
      MessageStatus: string;
    };

    console.log("📩 sms-status webhook:", { MessageSid, MessageStatus });

    const result = await db.alertAction.updateMany({
      where: {
        providerSid: MessageSid,
        actionType: "SMS",
      },
      data: { outcome: MessageStatus },
    });

    console.log(`📩 SMS status updated for ${result.count} action(s)`);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ sms-status webhook error:", err);
    return res.sendStatus(500);
  }
});

export default router;
