// ─── src/routes/twilio-webhook.ts ────────────────────────────────────────────
//
// FIX RETRY APPEL :
//   Le "in-progress" met maintenant humanAnswered = true immédiatement.
//   Un humain qui décroche = succès. Quand "completed" arrive :
//     - humanAnswered = true  → succès, pas de retry
//     - humanAnswered = false → pas de réponse humaine → retry dans RETRY_DELAY_MS
//
//   RETRY_DELAY_MS = 5 minutes (300_000 ms) dans constants.ts
//   MAX_CALL_ATTEMPTS = 3 → 1 appel initial + 2 retries = 3 total

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { db } from "../db/client.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { MAX_CALL_ATTEMPTS, RETRY_DELAY_MS } from "../config/constants.js";
import { sendEscalationSMS } from "../services/twilio.js";

const router = Router();

// ─── VALIDATION SIGNATURE TWILIO ─────────────────────────────────────────────

function validateTwilioSignature(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") {
    return next();
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const twilioSignature = req.headers["x-twilio-signature"] as string;
  const baseUrl = (process.env.API_BASE_URL ?? "").replace(/\/$/, "");
  const fullUrl = `${baseUrl}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    authToken,
    twilioSignature,
    fullUrl,
    req.body as Record<string, string>,
  );

  if (!isValid) {
    console.warn("⚠️ Invalid Twilio signature for:", fullUrl);
    return res.status(403).send("Forbidden");
  }
  return next();
}

router.use(validateTwilioSignature);

// ─── ESCALADE ─────────────────────────────────────────────────────────────────

async function handleEscalation(alertId: string) {
  const existing = await db.alertAction.findFirst({
    where: { alertId, actionType: "CALL", destination: "escalation" },
  });

  if (existing) {
    console.log(`ℹ️ Escalation already handled for alert ${alertId} — skipping`);
    return;
  }

  try {
    await sendEscalationSMS(alertId);
    console.log(`🚨 Escalation SMS sent for alert ${alertId}`);
  } catch (err) {
    console.error(
      `❌ Escalation SMS failed for alert ${alertId}:`,
      err instanceof Error ? err.message : err,
    );
    await db.alertEvent.update({
      where: { id: alertId },
      data: { status: "FAILED" },
    });
  }
}

// ─── RETRY ────────────────────────────────────────────────────────────────────

async function scheduleCallRetry(alertId: string, currentAttemptCount: number) {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    select: { status: true },
  });

  if (!alert || alert.status === "RESOLVED") {
    console.log(`✅ Alert ${alertId} RESOLVED — skipping retry`);
    return;
  }

  if (currentAttemptCount < MAX_CALL_ATTEMPTS) {
    const delayMin = Math.round(RETRY_DELAY_MS / 60_000);
    console.log(
      `🔁 Retry ${currentAttemptCount + 1}/${MAX_CALL_ATTEMPTS} ` +
      `for alert ${alertId} in ${delayMin} min`,
    );
    await alertQueue.add(
      "retryEmergencyCall",
      { alertId },
      {
        delay: RETRY_DELAY_MS,
        jobId: `retry-call-${alertId}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } else {
    console.log(`🚨 Max attempts (${MAX_CALL_ATTEMPTS}) reached for ${alertId} — escalating`);
    await handleEscalation(alertId);
  }
}

// ─── POST /twilio/call-status ─────────────────────────────────────────────────

router.post("/call-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, CallStatus } = req.body as {
      CallSid: string;
      CallStatus: string;
    };

    console.log("📞 call-status:", { CallSid, CallStatus });

    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });

    if (!action) {
      console.warn("⚠️ No AlertAction for CallSid:", CallSid);
      return res.sendStatus(200);
    }

    // États transitoires — pas d'action
    if (["queued", "initiated", "ringing"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });
      return res.sendStatus(200);
    }

    // ── CONTACT A DÉCROCHÉ ────────────────────────────────────────────────────
    // "in-progress" = contact a décroché et écoute le message.
    // On marque humanAnswered = true IMMÉDIATEMENT — pas besoin d'attendre AMD.
    if (CallStatus === "in-progress" || CallStatus === "answered") {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          humanAnswered: true,
          outcome: "success",
        },
      });
      console.log(`✅ Contact answered alert ${action.alertId} — marked success`);
      return res.sendStatus(200);
    }

    // ── APPEL TERMINÉ ─────────────────────────────────────────────────────────
    if (CallStatus === "completed") {
      const latest = await db.alertAction.findUnique({
        where: { id: action.id },
        select: { humanAnswered: true },
      });

      if (latest?.humanAnswered) {
        // Contact a décroché et entendu le message → succès confirmé
        await db.alertAction.update({
          where: { id: action.id },
          data: { outcome: "success" },
        });
        console.log(`✅ Call completed with human answer for alert ${action.alertId}`);
        return res.sendStatus(200);
      }

      // Appel terminé sans réponse humaine → retry
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "completed-no-human" },
      });

      const attemptCount = await db.alertAction.count({
        where: {
          alertId: action.alertId,
          actionType: "CALL",
          destination: { notIn: ["911", "escalation"] },
        },
      });

      await scheduleCallRetry(action.alertId, attemptCount);
      return res.sendStatus(200);
    }

    // ── PAS DE RÉPONSE / OCCUPÉ / ÉCHEC ──────────────────────────────────────
    if (["busy", "no-answer", "canceled", "failed"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });

      const attemptCount = await db.alertAction.count({
        where: {
          alertId: action.alertId,
          actionType: "CALL",
          destination: { notIn: ["911", "escalation"] },
        },
      });

      await scheduleCallRetry(action.alertId, attemptCount);
      return res.sendStatus(200);
    }

    // Statut inconnu
    await db.alertAction.update({
      where: { id: action.id },
      data: { outcome: String(CallStatus ?? "unknown") },
    });
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ /twilio/call-status error:", err);
    return res.sendStatus(500);
  }
});

// ─── POST /twilio/amd-status ──────────────────────────────────────────────────
// AMD = détection répondeur. Utile pour les logs mais ne contrôle plus
// humanAnswered (c'est "in-progress" qui le fait maintenant).

router.post("/amd-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, AnsweredBy } = req.body as {
      CallSid: string;
      AnsweredBy: string;
    };

    console.log("🧠 amd-status:", { CallSid, AnsweredBy });

    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });

    if (!action) {
      console.warn("⚠️ No AlertAction for AMD CallSid:", CallSid);
      return res.sendStatus(200);
    }

    // Sauvegarde le résultat AMD pour les logs — ne touche pas humanAnswered
    await db.alertAction.update({
      where: { id: action.id },
      data: { amdResult: AnsweredBy ?? "unknown" },
    });

    console.log(`🧠 AMD result saved: ${AnsweredBy} for alert ${action.alertId}`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ /twilio/amd-status error:", err);
    return res.sendStatus(500);
  }
});

// ─── POST /twilio/sms-status ──────────────────────────────────────────────────

router.post("/sms-status", async (req: Request, res: Response) => {
  try {
    const { MessageSid, MessageStatus } = req.body as {
      MessageSid: string;
      MessageStatus: string;
    };

    console.log("📩 sms-status:", { MessageSid, MessageStatus });

    const result = await db.alertAction.updateMany({
      where: { providerSid: MessageSid, actionType: "SMS" },
      data: { outcome: MessageStatus },
    });

    console.log(`📩 SMS status updated for ${result.count} action(s)`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ /twilio/sms-status error:", err);
    return res.sendStatus(500);
  }
});

export default router;