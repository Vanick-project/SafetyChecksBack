// ─── src/routes/twilio-webhook.ts ────────────────────────────────────────────
// ESCALADE :
//   Après 3 appels sans réponse → SMS bilingue au contact d'urgence
//   (jamais au 911 directement — approche légale pour app automatisée)

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { db } from "../db/client.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { MAX_CALL_ATTEMPTS, RETRY_DELAY_MS } from "../config/constants.js";
import { sendEscalationSMS } from "../services/twilio.js";

const router = Router();

// ─── TWILIO SIGNATURE VALIDATION ─────────────────────────────────────────────

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
// Déclenché après MAX_CALL_ATTEMPTS appels sans réponse.
// Envoie un SMS bilingue au contact d'urgence (pas au 911).

async function handleEscalation(alertId: string) {
  // Idempotent — ne jamais escalader deux fois
  const existing = await db.alertAction.findFirst({
    where: { alertId, actionType: "CALL", destination: "escalation" },
  });

  if (existing) {
    console.log(
      `ℹ️ Escalation already handled for alert ${alertId} — skipping`,
    );
    return;
  }

  try {
    // Envoie le SMS bilingue au contact d'urgence
    await sendEscalationSMS(alertId);

    await db.alertEvent.update({
      where: { id: alertId },
      data: { status: "ACTIVE" },
    });

    console.log(
      `🚨 Escalation SMS sent to emergency contact for alert ${alertId}`,
    );
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

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────

async function scheduleCallRetry(alertId: string, currentAttemptCount: number) {
  // Vérifie que l'alerte n'a pas été résolue entre-temps
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    select: { status: true },
  });

  if (!alert || alert.status === "RESOLVED") {
    console.log(
      `✅ Alert ${alertId} is RESOLVED — skipping retry and escalation`,
    );
    return;
  }

  if (currentAttemptCount < MAX_CALL_ATTEMPTS) {
    console.log(
      `🔁 Scheduling retry for alert ${alertId}. ` +
        `Attempt ${currentAttemptCount + 1}/${MAX_CALL_ATTEMPTS} ` +
        `in ${RETRY_DELAY_MS / 1000}s`,
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
    console.log(
      `🚨 Max attempts (${MAX_CALL_ATTEMPTS}) reached for alert ${alertId}. ` +
        `Sending escalation SMS to emergency contact.`,
    );
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
      console.warn("⚠️ No action found for CallSid:", CallSid);
      return res.sendStatus(200);
    }

    if (["queued", "initiated", "ringing"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });
      return res.sendStatus(200);
    }

    if (CallStatus === "in-progress" || CallStatus === "answered") {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "in-progress" },
      });
      return res.sendStatus(200);
    }

    if (CallStatus === "completed") {
      const latestAction = await db.alertAction.findUnique({
        where: { id: action.id },
        select: { humanAnswered: true },
      });

      if (latestAction?.humanAnswered) {
        await db.alertAction.update({
          where: { id: action.id },
          data: { outcome: "success" },
        });
        console.log(`✅ Human answered for alert ${action.alertId}`);
        return res.sendStatus(200);
      }

      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "completed-no-human" },
      });

      // Compte uniquement les vrais appels (exclut les marqueurs internes)
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

    if (["busy", "no-answer", "canceled", "failed"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });

      // Compte uniquement les vrais appels (exclut les marqueurs internes)
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

    await db.alertAction.update({
      where: { id: action.id },
      data: { outcome: String(CallStatus ?? "unknown") },
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ call-status error:", err);
    return res.sendStatus(500);
  }
});

// ─── POST /twilio/amd-status ──────────────────────────────────────────────────

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
      console.warn("⚠️ No action found for AMD CallSid:", CallSid);
      return res.sendStatus(200);
    }

    const isMachine = [
      "machine_start",
      "machine_end_beep",
      "machine_end_silence",
      "machine_end_other",
      "fax",
    ].includes(String(AnsweredBy));

    if (AnsweredBy === "human") {
      // Un humain a décroché — on marque le succès
      await db.alertAction.update({
        where: { id: action.id },
        data: { humanAnswered: true, outcome: "success" },
      });
      console.log(`✅ AMD: human confirmed for alert ${action.alertId}`);

    } else if (isMachine) {
      // Répondeur détecté
      const currentAction = await db.alertAction.findUnique({
        where: { id: action.id },
        select: { outcome: true, humanAnswered: true },
      });

      await db.alertAction.update({
        where: { id: action.id },
        data: { humanAnswered: false, amdResult: AnsweredBy },
      });

      console.log(`🤖 AMD: machine (${AnsweredBy}) for alert ${action.alertId}`);

      // Si completed est déjà passé et a marqué success (AMD pas encore arrivé),
      // on corrige et on lance le retry
      if (
        currentAction?.outcome === "success" ||
        currentAction?.outcome === "in-progress"
      ) {
        await db.alertAction.update({
          where: { id: action.id },
          data: { outcome: "machine", humanAnswered: false },
        });

        const attemptCount = await db.alertAction.count({
          where: {
            alertId: action.alertId,
            actionType: "CALL",
            destination: { notIn: ["911", "escalation"] },
          },
        });

        console.log(`🔁 AMD machine — scheduling retry for alert ${action.alertId}`);
        await scheduleCallRetry(action.alertId, attemptCount);
      }

    } else {
      await db.alertAction.update({
        where: { id: action.id },
        data: { amdResult: String(AnsweredBy ?? "unknown") },
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ amd-status error:", err);
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

    console.log(`📩 SMS updated for ${result.count} action(s)`);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ sms-status error:", err);
    return res.sendStatus(500);
  }
});

export default router;