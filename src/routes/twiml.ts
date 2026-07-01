import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/client.js";

export const twimlRouter = Router();
console.log("✅ twimlRouter loaded");

const BASE_URL = process.env.API_BASE_URL!;

// ─── HELPER ──────────────────────────────────────────────────────────────────
// Twilio peut envoyer le même param dans query ET body simultanément
// → Express combine en tableau → Prisma crash avec "Expected String, provided (String, String)"
// Ce helper extrait toujours la première valeur string.

function param(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value);
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

twimlRouter.post("/amd-callback", async (req: Request, res: Response) => {
  const { CallSid, AnsweredBy } = req.body as {
    CallSid?: string;
    AnsweredBy?: string;
  };
  console.log(`🤖 AMD — ${CallSid}: ${AnsweredBy}`);
  if (CallSid) {
    try {
      await db.alertAction.updateMany({
        where: { providerSid: CallSid },
        data: { amdResult: AnsweredBy ?? "unknown" },
      });
    } catch (e) {
      console.error("AMD DB error:", e);
    }
  }
  res.sendStatus(204);
});

// ─── CALL STATUS ─────────────────────────────────────────────────────────────

twimlRouter.post("/call-status", async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body as {
    CallSid?: string;
    CallStatus?: string;
    CallDuration?: string;
  };
  console.log(`📞 ${CallSid}: ${CallStatus} ${CallDuration ?? "?"}s`);
  if (CallSid) {
    try {
      await db.alertAction.updateMany({
        where: { providerSid: CallSid },
        data: {
          callStatus: CallStatus ?? null,
          callDuration: CallDuration ? parseInt(CallDuration, 10) : null,
          ...(CallStatus !== undefined && { outcome: CallStatus }),
        },
      });
    } catch (e) {
      console.error("call-status DB error:", e);
    }
  }
  res.sendStatus(204);
});