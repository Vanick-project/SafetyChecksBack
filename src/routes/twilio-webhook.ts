// ─── src/routes/twilio-webhook.ts ────────────────────────────────────────────
// ESCALADE 911 :
//   - En dev  (ENABLE_911_ESCALATION absent ou "false") : simulation en DB
//   - En prod (ENABLE_911_ESCALATION=true) : SMS urgent au contact d'urgence
//     indiquant d'appeler le 911 eux-mêmes.
//
//   POURQUOI PAS UN VRAI APPEL AU 911 AUTOMATIQUE ?
//   Appeler le 911 de façon automatisée sans humain en ligne est illégal
//   dans la plupart des juridictions (Canada, USA, Europe). La bonne pratique
//   est d'envoyer un SMS urgent au contact d'urgence avec les coordonnées GPS
//   et de lui demander d'appeler le 911 s'il ne peut pas joindre la personne.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { db } from "../db/client.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { MAX_CALL_ATTEMPTS, RETRY_DELAY_MS } from "../config/constants.js";

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

// ─── 911 ESCALATION ───────────────────────────────────────────────────────────

async function handle911Escalation(alertId: string) {
  // Idempotent — ne jamais escalader deux fois.
  const existing = await db.alertAction.findFirst({
    where: { alertId, actionType: "CALL", destination: "911" },
  });
  if (existing) return;

  const isProduction = process.env.ENABLE_911_ESCALATION === "true";

  if (!isProduction) {
    // ── MODE DEV : simulation en base de données ──────────────────────────
    await db.alertAction.create({
      data: {
        alertId,
        actionType: "CALL",
        destination: "911",
        outcome: "simulated_911_called",
        executedAt: new Date(),
      },
    });

    await db.alertEvent.update({
      where: { id: alertId },
      data: { status: "ACTIVE" },
    });

    console.log(`🚨 [DEV] Simulated 911 escalation for alert ${alertId}`);
    return;
  }

  // ── MODE PROD : SMS urgent au contact d'urgence ───────────────────────────
  // On envoie un SMS demandant au contact d'appeler le 911 lui-même.
  // C'est la seule approche légale pour une app automatisée.
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert || !alert.user.emergencyContact) {
    console.error(`❌ Cannot escalate — no contact found for alert ${alertId}`);
    return;
  }

  const contact = alert.user.emergencyContact;
  const { user } = alert;

  const hasLocation = alert.latAtTrigger != null && alert.lngAtTrigger != null;

  const locationLine = hasLocation
    ? `GPS: https://www.google.com/maps?q=${alert.latAtTrigger},${alert.lngAtTrigger}`
    : "Location unavailable.";

  const urgentBody =
    `🚨 URGENT — ${user.firstName ?? "Your contact"} could not be reached ` +
    `after multiple attempts.\n\n` +
    `${locationLine}\n\n` +
    `Please call them immediately. If you cannot reach them, ` +
    `CALL 911 AND GIVE THEM THIS LOCATION.`;

  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!,
  );

  const message = await twilioClient.messages.create({
    body: urgentBody,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: contact.phoneNumber,
  });

  await db.alertAction.create({
    data: {
      alertId,
      actionType: "CALL",
      destination: "911",
      outcome: `escalation_sms_sent:${message.sid}`,
      executedAt: new Date(),
    },
  });

  await db.alertEvent.update({
    where: { id: alertId },
    data: { status: "ACTIVE" },
  });

  console.log(
    `🚨 [PROD] 911 escalation SMS sent for alert ${alertId} → SID ${message.sid}`,
  );
}

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────

async function scheduleCallRetry(alertId: string, currentAttemptCount: number) {
  // NOUVEAU — vérifie que l'alerte n'a pas été résolue entre-temps
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
        `Attempt ${currentAttemptCount + 1}/${MAX_CALL_ATTEMPTS} in ${RETRY_DELAY_MS / 1000}s`,
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
      `🚨 Max attempts (${MAX_CALL_ATTEMPTS}) reached for alert ${alertId}. Escalating.`,
    );
    await handle911Escalation(alertId);
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

    if (AnsweredBy === "human") {
      await db.alertAction.update({
        where: { id: action.id },
        data: { humanAnswered: true, outcome: "in-progress" },
      });
      console.log(`✅ Human detected for alert ${action.alertId}`);
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
        data: { humanAnswered: false, outcome: "machine" },
      });
      console.log(`🤖 Machine detected for alert ${action.alertId}`);
    } else {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: String(AnsweredBy ?? "unknown") },
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
