import { Router } from "express";
import type { Request, Response } from "express";
import { Queue } from "bullmq";
import twilio from "twilio";
import { db } from "../db/client.js";
import { redisConnection } from "../lib/redis.js";

export const twimlRouter = Router();
console.log("✅ twimlRouter loaded");

const BASE_URL = process.env.API_BASE_URL!;

// ─── FILE BULLMQ (producteur) ─────────────────────────────────────────────────
// Même nom + même connexion que le Worker de alertWorker.ts → même file.
// Instance producteur autonome : pas besoin d'importer une file définie ailleurs.
const alertQueue = new Queue("alertQueue", { connection: redisConnection });

// Délai entre deux tentatives d'appel. (Déplaçable dans config/constants.ts.)
const RETRY_DELAY_MS = 30_000;

// Client Twilio, uniquement pour raccrocher un répondeur détecté par AMD.
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

// ─── HELPER ──────────────────────────────────────────────────────────────────
// Twilio peut envoyer le même param dans query ET body simultanément
// → Express combine en tableau → Prisma crash avec "Expected String, provided (String, String)"
// Ce helper extrait toujours la première valeur string.

function param(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value);
}

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

// ─── HELPERS VOIX ────────────────────────────────────────────────────────────

function twimlVoice(lang: "fr" | "en") {
  return lang === "fr" ? "Polly.Lea" : "Polly.Joanna";
}

function twimlLang(lang: "fr" | "en") {
  return lang === "fr" ? "fr-FR" : "en-US";
}

function buildSpeechFr(name: string, hasLocation: boolean): string {
  const loc = hasLocation
    ? "Leur derniere position a ete envoyee par SMS."
    : "Leur position est inconnue.";
  return [
    "Bonjour.",
    "Ceci est une alerte de Safety Check.",
    name + " ne repond pas a ses verifications de securite.",
    loc + " Contactez-les immediatement.",
    "Si vous ne pouvez pas les joindre, appelez le neuf-un-un.",
    "Pour repeter, appuyez sur 1. Sinon raccrochez.",
  ].join(" ");
}

function buildSpeechEn(name: string, hasLocation: boolean): string {
  const loc = hasLocation
    ? "Their last location was sent to you by text."
    : "Their location is unknown.";
  return [
    "Hello.",
    "This is an automated Safety Check alert.",
    name + " has not responded to their safety check-ins.",
    loc + " Please contact them immediately.",
    "If you cannot reach them, please call 9-1-1.",
    "To repeat this message press 1. Otherwise please hang up.",
  ].join(" ");
}

// ─── VOICE ───────────────────────────────────────────────────────────────────

async function handleVoice(req: Request, res: Response) {
  // CORRECTION : param() protège contre les tableaux query+body combinés
  const alertId = param(req.query.alertId ?? req.body?.alertId) || undefined;
  const lang: "fr" | "en" =
    param(req.query.lang ?? req.body?.lang) === "en" ? "en" : "fr";

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    let userName = lang === "fr" ? "votre contact" : "your contact";
    let hasLocation = false;

    if (alertId && alertId !== "TEST") {
      const alert = await db.alertEvent.findUnique({
        where: { id: alertId },
        include: { user: true },
      });
      if (alert?.user?.firstName) {
        userName = alert.user.firstName
          .replace(/[éèêë]/g, "e")
          .replace(/[àâä]/g, "a")
          .replace(/[ùûü]/g, "u")
          .replace(/[îï]/g, "i")
          .replace(/[ôö]/g, "o")
          .replace(/[ç]/g, "c")
          .replace(/[^a-zA-Z0-9 _-]/g, "");
      }
      hasLocation =
        alert?.latAtTrigger != null && alert?.lngAtTrigger != null;
    }

    const voice = twimlVoice(lang);
    const langAttr = twimlLang(lang);
    const speech =
      lang === "fr"
        ? buildSpeechFr(userName, hasLocation)
        : buildSpeechEn(userName, hasLocation);

    const gatherUrl = alertId
      ? `${BASE_URL}/twiml/gather?alertId=${encodeURIComponent(alertId)}&amp;lang=${lang}`
      : `${BASE_URL}/twiml/gather?lang=${lang}`;

    const thanks =
      lang === "fr"
        ? "Merci. Verifiez leur situation."
        : "Thank you. Please check on them.";

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">${speech}</Say>
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="8">
    <Pause length="8"/>
  </Gather>
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

// ─── GATHER ──────────────────────────────────────────────────────────────────

twimlRouter.post("/gather", async (req: Request, res: Response) => {
  // CORRECTION : param() protège contre les tableaux query+body combinés
  const alertId = param(req.query.alertId ?? req.body?.alertId) || undefined;
  const lang: "fr" | "en" =
    param(req.query.lang ?? req.body?.lang) === "en" ? "en" : "fr";
  const { Digits } = req.body as { Digits?: string };

  if (Digits === "1") {
    const url = alertId
      ? `${BASE_URL}/twiml/voice?alertId=${encodeURIComponent(alertId)}&lang=${lang}`
      : `${BASE_URL}/twiml/voice?lang=${lang}`;
    return res.redirect(303, url);
  }

  const voice = twimlVoice(lang);
  const langAttr = twimlLang(lang);
  const msg = lang === "fr" ? "Merci. Au revoir." : "Thank you. Goodbye.";

  return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langAttr}">${msg}</Say>
  <Hangup/>
</Response>`);
});

// ─── AMD CALLBACK ────────────────────────────────────────────────────────────
// Reçoit le verdict AMD (human | machine_* | fax | unknown).
// Écrit amdResult, et si c'est un répondeur CONFIRMÉ, raccroche tout de suite
// pour ne pas attendre 39 s : le /call-status "completed" qui suit planifiera
// la tentative suivante.

twimlRouter.post("/amd-callback", async (req: Request, res: Response) => {
  const CallSid = param(req.body.CallSid);
  const AnsweredBy = param(req.body.AnsweredBy);
  console.log(`🤖 AMD — ${CallSid}: ${AnsweredBy}`);

  res.sendStatus(204); // ack rapide à Twilio ; le reste est best-effort
  if (!CallSid) return;

  try {
    await db.alertAction.updateMany({
      where: { providerSid: CallSid },
      data: { amdResult: AnsweredBy || "unknown" },
    });

    // On ne raccroche que sur un répondeur CONFIRMÉ (pas "unknown", pour ne pas
    // couper un vrai humain qu'AMD n'aurait pas su classer).
    const confirmedMachine =
      AnsweredBy.startsWith("machine") || AnsweredBy === "fax";

    if (confirmedMachine) {
      await twilioClient
        .calls(CallSid)
        .update({ status: "completed" })
        .catch(() => {});
      console.log(
        `📭 Répondeur détecté (${AnsweredBy}) — appel raccroché, retry à venir.`,
      );
    }
  } catch (e) {
    console.error("AMD DB error:", e);
  }
});

// ─── CALL STATUS ─────────────────────────────────────────────────────────────
// Source unique de décision retry/succès. Reçoit le statut final de chaque appel.
//   - AMD = "human"           → contact joint, aucun retry (l'alerte reste ACTIVE
//                               jusqu'au "I'm safe" de l'utilisateur).
//   - répondeur / no-answer / busy / failed → planifie retryEmergencyCall.
// C'est le worker (alertWorker.ts) qui, au bout de MAX_CALL_ATTEMPTS, passe
// l'alerte à FAILED et envoie l'escalade SMS.

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

    // Écrit le statut final de l'appel (comportement conservé)
    // Écrit un outcome sémantique (answered_human | voicemail | no_answer | busy | ...)
    await db.alertAction.update({
      where: { id: action.id },
      data: {
        callStatus: CallStatus || null,
        callDuration: CallDuration ? parseInt(CallDuration, 10) : null,
        outcome: callOutcome(CallStatus, action.amdResult),
      },
    });

    // On ne réagit qu'aux états terminaux
    const terminal = ["completed", "busy", "no-answer", "failed", "canceled"];
    if (!terminal.includes(CallStatus)) return;

    const alertId = action.alertId;
    if (!alertId) return;

    // Ne pas relancer si l'alerte n'est plus active (résolue par "I'm safe",
    // ou déjà passée à FAILED).
    const alert = await db.alertEvent.findUnique({ where: { id: alertId } });
    if (!alert || alert.status !== "ACTIVE") {
      console.log(
        `⏹️ Alerte ${alertId} non-active (${alert?.status ?? "introuvable"}) — pas de retry.`,
      );
      return;
    }

    // Un humain a décroché → contact joint. On arrête les appels.
    if (CallStatus === "completed" && action.amdResult === "human") {
      console.log(`✅ Humain joint pour ${alertId} — aucun retry.`);
      await db.alertAction.update({
        where: { id: action.id },
        data: { outcome: "answered_human" },
      });
      return;
    }

    // Sinon (répondeur, sans réponse, occupé, échec) → tentative suivante.
    await alertQueue.add(
      "retryEmergencyCall",
      { alertId },
      {
        delay: RETRY_DELAY_MS,
        jobId: `retry-${CallSid}`, // dédup si Twilio renvoie le même webhook
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    console.log(
      `🔁 Retry planifié pour ${alertId} dans ${RETRY_DELAY_MS / 1000}s ` +
        `— cause: ${CallStatus}/${action.amdResult ?? "no-amd"}`,
    );
  } catch (e) {
    console.error("call-status error:", e);
  }
});