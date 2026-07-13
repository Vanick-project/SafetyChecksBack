import { Router } from "express";
import type { Request, Response } from "express";
import { Queue } from "bullmq";
import { db } from "../db/client.js";
import { redisConnection } from "../lib/redis.js";
import { RETRY_DELAY_MS } from "../config/constants.js";

export const twimlRouter = Router();
console.log("✅ twimlRouter loaded");

const BASE_URL = process.env.API_BASE_URL!;

// ─── FILE BULLMQ (producteur) ─────────────────────────────────────────────────
// Même nom + même connexion que le Worker de alertWorker.ts → même file.
const alertQueue = new Queue("alertQueue", { connection: redisConnection });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── HELPER PARAM ─────────────────────────────────────────────────────────────
// Twilio peut envoyer le même param dans query ET body → Express combine en tableau.

function param(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value);
}

// ─── OUTCOME SÉMANTIQUE ───────────────────────────────────────────────────────
// Traduit (CallStatus, amdResult) en un outcome lisible par le frontend.

function callOutcome(status: string, amd: string | null): string {
  if (status === "completed") {
    if (amd === "human") return "answered_human";
    if (amd && (amd.startsWith("machine") || amd === "fax")) return "voicemail";
    return "completed";
  }
  if (status === "no-answer") return "no_answer";
  if (status === "busy") return "busy";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return status;
}

// ─── HELPERS VOIX ─────────────────────────────────────────────────────────────

function twimlVoice(lang: "fr" | "en") {
  return lang === "fr" ? "Polly.Lea" : "Polly.Joanna";
}

function twimlLang(lang: "fr" | "en") {
  return lang === "fr" ? "fr-FR" : "en-US";
}

function buildSpeechFr(contactName: string, userName: string): string {
  return [
    "Bonjour " + contactName + ".",
    "Ici Safety Check.",
    "Nous vous contactons au nom de " + userName + ".",
    "A l'heure actuelle, nous ne sommes pas en mesure de confirmer que " + userName + " est en securite.",
    "Nous vous demandons de contacter immediatement le neuf-un-un si vous etes aux Etats-Unis ou au Canada,",
    "ou le un-un-deux si vous etes dans l'Union europeenne,",
    "afin de demander une verification de bien-etre,",
    "puis de consulter vos messages prives pour obtenir sa derniere localisation connue.",
    "Pour confirmer que vous avez bien recu cette alerte, appuyez sur 1.",
  ].join(" ");
}

function buildSpeechEn(contactName: string, userName: string): string {
  return [
    "Hello " + contactName + ".",
    "This is Safety Check.",
    "We are reaching out on behalf of " + userName + ".",
    "We are unable to confirm whether " + userName + " is safe at this time.",
    "Please call 9-1-1 if you are in the United States or Canada,",
    "or 1-1-2 if you are in the European Union,",
    "for a wellness check,",
    "and review your private message for his last known location.",
    "To confirm that you received this alert, press 1.",
  ].join(" ");
}

// ─── VOICE ────────────────────────────────────────────────────────────────────

async function handleVoice(req: Request, res: Response) {
  const alertId = param(req.query.alertId ?? req.body?.alertId) || undefined;
  const lang: "fr" | "en" =
    param(req.query.lang ?? req.body?.lang) === "en" ? "en" : "fr";

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // Nettoie un nom pour Polly (retire accents et caractères hors alphabet).
  const sanitizeName = (raw: string): string =>
    raw
      .replace(/[éèêë]/g, "e")
      .replace(/[àâä]/g, "a")
      .replace(/[ùûü]/g, "u")
      .replace(/[îï]/g, "i")
      .replace(/[ôö]/g, "o")
      .replace(/[ç]/g, "c")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim();

  try {
    let userName = lang === "fr" ? "votre proche" : "your contact";
    let contactName = "";

    if (alertId && alertId !== "TEST") {
      const alert = await db.alertEvent.findUnique({
        where: { id: alertId },
        include: { user: { include: { emergencyContact: true } } },
      });
      if (alert?.user?.firstName) {
        userName = sanitizeName(alert.user.firstName) || userName;
      }
      if (alert?.user?.emergencyContact?.name) {
        contactName = sanitizeName(alert.user.emergencyContact.name);
      }
    }

    const voice = twimlVoice(lang);
    const langAttr = twimlLang(lang);
    const speech =
      lang === "fr"
        ? buildSpeechFr(contactName, userName)
        : buildSpeechEn(contactName, userName);

    const gatherUrl = alertId
      ? `${BASE_URL}/twiml/gather?alertId=${encodeURIComponent(alertId)}&amp;lang=${lang}`
      : `${BASE_URL}/twiml/gather?lang=${lang}`;

    const thanks =
      lang === "fr"
        ? "Merci. Verifiez leur situation."
        : "Thank you. Please check on them.";

    // Le Gather ne POST vers /gather QUE si le contact appuie sur une touche.
    // En cas de non-réponse (timeout), on passe au Say + Hangup, et
    // /call-status planifiera la tentative suivante.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">${speech}</Say>
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="10"/>
  <Say voice="${voice}" language="${langAttr}">${thanks}</Say>
  <Hangup/>
</Response>`;

    console.log(`✅ /twiml/voice served for alertId=${alertId} lang=${lang}`);
    res.type("text/xml").send(xml);
  } catch (err) {
    console.error("❌ /twiml/voice error:", err);
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">Safety Check emergency alert. Please check on your contact immediately.</Say>
  <Hangup/>
</Response>`);
  }
}

twimlRouter.get("/voice", handleVoice);
twimlRouter.post("/voice", handleVoice);

// ─── GATHER (CONFIRMATION HUMAINE) ────────────────────────────────────────────
// Atteint UNIQUEMENT si le contact appuie sur une touche pendant l'appel.
// Digits === "1" = preuve fiable qu'un humain a reçu l'alerte (sans dépendre d'AMD).

twimlRouter.post("/gather", async (req: Request, res: Response) => {
  const alertId = param(req.query.alertId ?? req.body?.alertId) || undefined;
  const lang: "fr" | "en" =
    param(req.query.lang ?? req.body?.lang) === "en" ? "en" : "fr";
  const CallSid = param(req.body.CallSid);
  const Digits = param(req.body.Digits);

  const voice = twimlVoice(lang);
  const langAttr = twimlLang(lang);

  if (Digits === "1") {
    // Marque CET appel comme répondu par un humain. /call-status le lira et
    // n'ordonnera aucun retry, aucune escalade.
    try {
      if (CallSid) {
        await db.alertAction.updateMany({
          where: { providerSid: CallSid },
          data: { outcome: "answered_human" },
        });
      }
      console.log(
        `✅ Contact a CONFIRMÉ (appui 1) — alert=${alertId} call=${CallSid}`,
      );
    } catch (e) {
      console.error("gather confirm error:", e);
    }

    const msg =
      lang === "fr"
        ? "Merci. Verifiez leur situation. Au revoir."
        : "Thank you. Please check on them. Goodbye.";
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langAttr}">${msg}</Say>
  <Hangup/>
</Response>`);
  }

  // Touche autre que 1 → pas de confirmation. On raccroche ; retry via call-status.
  const msg = lang === "fr" ? "Au revoir." : "Goodbye.";
  return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langAttr}">${msg}</Say>
  <Hangup/>
</Response>`);
});

// ─── AMD CALLBACK ─────────────────────────────────────────────────────────────
// Enregistre le verdict AMD (filet de secours pour détecter un humain).
// PAS de raccrochage ici : AMD prend parfois un humain pour un répondeur.

twimlRouter.post("/amd-callback", async (req: Request, res: Response) => {
  const CallSid = param(req.body.CallSid);
  const AnsweredBy = param(req.body.AnsweredBy);
  console.log(`🤖 AMD — ${CallSid}: ${AnsweredBy}`);

  res.sendStatus(204);
  if (!CallSid) return;

  try {
    await db.alertAction.updateMany({
      where: { providerSid: CallSid },
      data: { amdResult: AnsweredBy || "unknown" },
    });
  } catch (e) {
    console.error("AMD DB error:", e);
  }
});

// ─── CALL STATUS ──────────────────────────────────────────────────────────────
// Décide succès vs retry. Succès = appui sur 1 (answered_human écrit par /gather)
// OU AMD=human. Sinon → tentative suivante via retryEmergencyCall.

twimlRouter.post("/call-status", async (req: Request, res: Response) => {
  const CallSid = param(req.body.CallSid);
  const CallStatus = param(req.body.CallStatus);
  const CallDuration = param(req.body.CallDuration);

  console.log(`📞 ${CallSid}: ${CallStatus} ${CallDuration || "?"}s`);

  res.sendStatus(204); // ack rapide à Twilio
  if (!CallSid) return;

  try {
    const action = await db.alertAction.findFirst({
      where: { providerSid: CallSid },
    });
    if (!action) return;

    const dur = CallDuration ? parseInt(CallDuration, 10) : null;

    // On ne réagit qu'aux états terminaux ; les états intermédiaires ne font
    // que mettre à jour le statut brut.
    const terminal = ["completed", "busy", "no-answer", "failed", "canceled"];
    if (!terminal.includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: { callStatus: CallStatus || null },
      });
      return;
    }

    const alertId = action.alertId;
    if (!alertId) return;

    // 1) Confirmation par appui sur 1 (déterministe, écrite par /gather).
    let confirmed = action.outcome === "answered_human";
    let amd = action.amdResult;

    // 2) Sinon, sur "completed" sans verdict AMD encore arrivé, court délai :
    //    l'appui sur 1 OU l'AMD peuvent atterrir juste après le "completed".
    if (!confirmed && CallStatus === "completed" && amd == null) {
      await sleep(2500);
      const fresh = await db.alertAction.findUnique({
        where: { id: action.id },
      });
      amd = fresh?.amdResult ?? null;
      if (fresh?.outcome === "answered_human") confirmed = true;
    }

    const humanReached =
      confirmed || (CallStatus === "completed" && amd === "human");

    // Ne pas relancer si l'alerte n'est plus active (résolue / déjà FAILED).
    const alert = await db.alertEvent.findUnique({ where: { id: alertId } });
    if (!alert || alert.status !== "ACTIVE") {
      console.log(
        `⏹️ Alerte ${alertId} non-active (${alert?.status ?? "introuvable"}) — pas de retry.`,
      );
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          callStatus: CallStatus || null,
          callDuration: dur,
          outcome: humanReached ? "answered_human" : callOutcome(CallStatus, amd),
        },
      });
      return;
    }

    
    // SUCCÈS : un humain a été joint → aucun retry, aucune escalade.
    if (humanReached) {
      console.log(`✅ Humain joint pour ${alertId} — aucun retry.`);
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          callStatus: CallStatus || null,
          callDuration: dur,
          outcome: "answered_human",
        },
      });

      // Marque l'action "System action" (PUSH/system) comme terminée avec succès.
      // L'alerte reste ACTIVE : seul le "I'm safe" de l'utilisateur la résout (option B).
      await db.alertAction.updateMany({
        where: {
          alertId,
          actionType: "PUSH",
          destination: "system",
        },
        data: { outcome: "contact_reached_success" },
      });

      return;
    }

    // ÉCHEC de cette tentative → outcome sémantique + planifie la suivante.
    await db.alertAction.update({
      where: { id: action.id },
      data: {
        callStatus: CallStatus || null,
        callDuration: dur,
        outcome: callOutcome(CallStatus, amd),
      },
    });

    await alertQueue.add(
      "retryEmergencyCall",
      { alertId },
      {
        delay: RETRY_DELAY_MS,
        jobId: `retry-${CallSid}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    console.log(
      `🔁 Retry planifié pour ${alertId} dans ${RETRY_DELAY_MS / 1000}s ` +
        `— cause: ${CallStatus}/${amd ?? "no-amd"}`,
    );
  } catch (e) {
    console.error("call-status error:", e);
  }
});