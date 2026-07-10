// ─── src/routes/twilio-webhook.ts ────────────────────────────────────────────
//
// FLOW EXACT :
//
//   SMS envoyé immédiatement au contact d'urgence.
//   Appel 1 → lancé immédiatement
//     → Contact raccroche (busy/canceled) → retry dans 5 min
//     → Répondeur (machine_*)            → retry dans 5 min
//     → Pas de réponse (no-answer)       → retry dans 5 min
//     → Humain décroche (AMD = human)    → SUCCÈS → alerte reste ACTIVE
//                                          jusqu'à ce que l'utilisateur
//                                          clique "Je suis safe"
//   Appel 2 → même logique
//   Appel 3 → même logique
//   Après 3 appels échoués → alerte reste ACTIVE (IN PROGRESS)
//                           → utilisateur doit cliquer "Je suis safe"
//
//   RÈGLE CLÉE : humanAnswered = true UNIQUEMENT si AMD confirme "human"
//   in-progress seul ne suffit PAS (le répondeur aussi déclenche in-progress)
//   NE PAS escalader vers SMS après 3 échecs — laisser en IN PROGRESS

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { db } from "../db/client.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { MAX_CALL_ATTEMPTS, RETRY_DELAY_MS } from "../config/constants.js";

const router = Router();

// ─── SIGNATURE TWILIO ─────────────────────────────────────────────────────────

function validateTwilioSignature(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return next();

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
    console.warn("⚠️ Invalid Twilio signature:", fullUrl);
    return res.status(403).send("Forbidden");
  }
  return next();
}

router.use(validateTwilioSignature);

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────
// Après MAX_CALL_ATTEMPTS échecs → NE PAS escalader, laisser l'alerte ACTIVE.
// L'utilisateur doit cliquer "Je suis safe" pour résoudre.

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
    // MAX_CALL_ATTEMPTS atteint — alerte reste IN PROGRESS
    // L'utilisateur doit cliquer "Je suis safe"
    console.log(
      `📵 Max attempts (${MAX_CALL_ATTEMPTS}) reached for alert ${alertId}. ` +
      `Alert stays ACTIVE — waiting for user to confirm safety.`,
    );
    await db.alertEvent.update({
      where: { id: alertId },
      data: { status: "ACTIVE" },
    });
  }
}

// ─── POST /twilio/call-status ─────────────────────────────────────────────────
//
// LOGIQUE :
//   - queued / initiated / ringing  → mise à jour de l'outcome seulement
//   - in-progress                   → quelqu'un décroche (humain OU répondeur)
//                                     NE PAS marquer humanAnswered ici
//                                     AMD confirmera si c'est un humain
//   - completed + humanAnswered=true  → succès (AMD a confirmé human)
//   - completed + humanAnswered=false → échec → retry
//   - busy / no-answer / canceled   → contact a refusé ou pas répondu → retry
//   - failed                        → problème réseau → retry

router.post("/call-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, CallStatus } = req.body as {
      CallSid: string;
      CallStatus: string;
    };

    console.log(`📞 call-status: ${CallSid} → ${CallStatus}`);

    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });

    if (!action) {
      console.warn("⚠️ No AlertAction for CallSid:", CallSid);
      return res.sendStatus(200);
    }

    // ── États transitoires — mise à jour simple ───────────────────────────
    if (["queued", "initiated", "ringing"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: CallStatus },
      });
      return res.sendStatus(200);
    }

    // ── Quelqu'un a décroché (humain OU répondeur) ────────────────────────
    // On NE marque PAS humanAnswered ici — AMD s'en charge via /amd-status
    if (CallStatus === "in-progress" || CallStatus === "answered") {
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "in-progress" },
      });
      console.log(`📲 Call in-progress for alert ${action.alertId} — waiting for AMD`);
      return res.sendStatus(200);
    }

    // ── Appel terminé ─────────────────────────────────────────────────────
    if (CallStatus === "completed") {
      // Relit humanAnswered — peut avoir été mis à true par /amd-status
      const latest = await db.alertAction.findUnique({
        where: { id: action.id },
        select: { humanAnswered: true, amdResult: true },
      });

      if (latest?.humanAnswered === true) {
        // AMD a confirmé un humain → SUCCÈS
        await db.alertAction.update({
          where: { id: action.id },
          data: { outcome: "success" },
        });
        console.log(`✅ Call SUCCESS — human confirmed for alert ${action.alertId}`);
        return res.sendStatus(200);
      }

      // Pas de confirmation humaine (répondeur, raccroché avant AMD, etc.) → retry
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

      console.log(
        `❌ Call completed without human — attempt ${attemptCount}/${MAX_CALL_ATTEMPTS} ` +
        `for alert ${action.alertId}`,
      );
      await scheduleCallRetry(action.alertId, attemptCount);
      return res.sendStatus(200);
    }

    // ── Contact a refusé (busy) ou pas répondu (no-answer) ────────────────
    // "canceled" = Twilio a annulé avant que ça sonne
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

      console.log(
        `📵 Call ${CallStatus} — attempt ${attemptCount}/${MAX_CALL_ATTEMPTS} ` +
        `for alert ${action.alertId}`,
      );
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
//
// AMD = Answering Machine Detection (async, arrive après in-progress)
//
// LOGIQUE :
//   human        → marque humanAnswered = true
//                  si "completed" est déjà passé avec outcome "success" → OK
//                  si "completed" n'est pas encore passé → humanAnswered sera lu
//
//   machine_*    → marque humanAnswered = false + amdResult
//                  si "completed" est déjà passé ET outcome = "success"
//                  → race condition : AMD arrive après completed
//                  → on corrige l'outcome et on lance le retry immédiatement
//
// Note : AMD peut arriver avant OU après "completed" (délai async Twilio)

router.post("/amd-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, AnsweredBy } = req.body as {
      CallSid: string;
      AnsweredBy: string;
    };

    console.log(`🧠 AMD: ${CallSid} → ${AnsweredBy}`);

    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });

    if (!action) {
      console.warn("⚠️ No AlertAction for AMD CallSid:", CallSid);
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
      // ── HUMAIN CONFIRMÉ ──────────────────────────────────────────────────
      await db.alertAction.update({
        where: { id: action.id },
        data: { humanAnswered: true, amdResult: "human", outcome: "success" },
      });
      console.log(`✅ AMD HUMAN — alert ${action.alertId} call successful`);

    } else if (isMachine) {
      // ── RÉPONDEUR DÉTECTÉ ────────────────────────────────────────────────
      // Lit l'état actuel pour détecter la race condition
      const current = await db.alertAction.findUnique({
        where: { id: action.id },
        select: { outcome: true, humanAnswered: true },
      });

      // Marque répondeur
      await db.alertAction.update({
        where: { id: action.id },
        data: { humanAnswered: false, amdResult: AnsweredBy },
      });

      console.log(`🤖 AMD MACHINE (${AnsweredBy}) — alert ${action.alertId}`);

      // RACE CONDITION : "completed" est déjà passé et a mis outcome = "success"
      // car humanAnswered était encore false à ce moment.
      // → corriger et lancer le retry immédiatement
      if (current?.outcome === "success" || current?.outcome === "in-progress") {
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

        console.log(
          `🔁 AMD machine correction — retry for alert ${action.alertId} ` +
          `(attempt ${attemptCount}/${MAX_CALL_ATTEMPTS})`,
        );
        await scheduleCallRetry(action.alertId, attemptCount);
      }

    } else {
      // Résultat AMD inconnu (ex: "unknown")
      await db.alertAction.update({
        where: { id: action.id },
        data: { amdResult: String(AnsweredBy ?? "unknown") },
      });
      console.log(`❓ AMD unknown (${AnsweredBy}) — alert ${action.alertId}`);
    }

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

    console.log(`📩 sms-status: ${MessageSid} → ${MessageStatus}`);

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