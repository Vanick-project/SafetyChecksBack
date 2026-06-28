// ─── src/routes/twiml.ts ──────────────────────────────────────────────────────
//
// FIX CRITIQUE : apostrophes échappées en &apos; dans le XML TwiML.
// Sans ça, le parseur XML de Twilio rejette le TwiML → erreur 11200 → 
// message "We're sorry, an application error has occurred" en anglais.
//
// Règle XML : dans un attribut ou le contenu d'un élément XML, les caractères
// spéciaux doivent être échappés :
//   '  →  &apos;
//   "  →  &quot;
//   &  →  &amp;
//   <  →  &lt;
//   >  →  &gt;

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/client.js";

export const twimlRouter = Router();
console.log("✅ twimlRouter loaded");

const BASE_URL = process.env.API_BASE_URL!;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function twimlVoice(lang: "fr" | "en") {
  return lang === "fr" ? "Polly.Léa" : "Polly.Joanna";
}

function twimlLang(lang: "fr" | "en") {
  return lang === "fr" ? "fr-FR" : "en-US";
}

// Échappe les caractères spéciaux XML dans le texte des balises <Say>
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSpeechBlocks(
  lang: "fr" | "en",
  userName: string,
  hasLocation: boolean,
): string {
  const voice = twimlVoice(lang);
  const langAttr = twimlLang(lang);
  const safeName = xmlEscape(userName);

  if (lang === "fr") {
    const locationLine = hasLocation
      ? "Leur dernière position connue a été envoyée par SMS."
      : "Leur position n&apos;est pas disponible pour le moment.";

    return `
  <Say voice="${voice}" language="${langAttr}">Bonjour.</Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    Ceci est une alerte automatique de l&apos;application Safety Check.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${safeName} n&apos;a pas répondu à ses vérifications de sécurité et pourrait avoir besoin d&apos;aide immédiate.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${locationLine} Veuillez essayer de les contacter immédiatement.
    Si vous ne pouvez pas les joindre, appelez le 9-1-1 immédiatement.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    Pour répéter ce message, appuyez sur 1. Sinon, raccrochez et agissez maintenant.
  </Say>`;
  }

  const locationLine = hasLocation
    ? "Their last known location has been sent to you by text message."
    : "Their location is not available at this time.";

  return `
  <Say voice="${voice}" language="${langAttr}">Hello.</Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    This is an automated alert from the Safety Check application.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${safeName} has not responded to their safety check-ins and may need immediate help.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${locationLine} Please try to contact them immediately.
    If you cannot reach them, please call 9-1-1 immediately.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    To repeat this message, press 1. Otherwise please hang up and take action now.
  </Say>`;
}

// ─── GET /twiml/voice ─────────────────────────────────────────────────────────

twimlRouter.get("/voice", async (req: Request, res: Response) => {
  const alertId = req.query.alertId as string | undefined;
  const lang: "fr" | "en" = req.query.lang === "en" ? "en" : "fr";

  // CRITIQUE : désactive le cache HTTP — Twilio doit recevoir 200 + XML à chaque appel.
  // Un 304 "Not Modified" est interprété comme une erreur par Twilio → message d'erreur anglais.
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
        userName = alert.user.firstName;
      }
      hasLocation = alert?.latAtTrigger != null && alert?.lngAtTrigger != null;
    }

    const voice = twimlVoice(lang);
    const langAttr = twimlLang(lang);
    const speechBlocks = buildSpeechBlocks(lang, userName, hasLocation);
    const gatherUrl = alertId
      ? `${BASE_URL}/twiml/gather?alertId=${encodeURIComponent(alertId)}&amp;lang=${lang}`
      : `${BASE_URL}/twiml/gather?lang=${lang}`;

    const thankyouMsg = lang === "fr"
      ? "Merci. Veuillez vérifier leur situation dès que possible."
      : "Thank you. Please check on them as soon as possible.";

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  ${speechBlocks}
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="8">
    <Pause length="8"/>
  </Gather>
  <Say voice="${voice}" language="${langAttr}">${thankyouMsg}</Say>
  <Hangup/>
</Response>`;

    res.type("text/xml").send(xml);
  } catch (err) {
    console.error("❌ /twiml/voice error:", err);
    // Fallback générique si DB inaccessible
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    This is a Safety Check emergency alert. Please check on your contact immediately.
  </Say>
  <Hangup/>
</Response>`);
  }
});

// Twilio peut appeler /twiml/voice en POST selon la configuration du numéro
// ou lors de redirections internes — on accepte les deux méthodes.
twimlRouter.post("/voice", async (req: Request, res: Response) => {
  // En POST, alertId et lang peuvent être dans le body ou la query string
  const alertId = (req.query.alertId || req.body?.alertId) as string | undefined;
  const lang: "fr" | "en" = ((req.query.lang || req.body?.lang) === "en") ? "en" : "fr";

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
      if (alert?.user?.firstName) userName = alert.user.firstName;
      hasLocation = alert?.latAtTrigger != null && alert?.lngAtTrigger != null;
    }

    const voice = twimlVoice(lang);
    const langAttr = twimlLang(lang);
    const speechBlocks = buildSpeechBlocks(lang, userName, hasLocation);
    const gatherUrl = alertId
      ? `${BASE_URL}/twiml/gather?alertId=${encodeURIComponent(alertId)}&amp;lang=${lang}`
      : `${BASE_URL}/twiml/gather?lang=${lang}`;
    const thankyouMsg = lang === "fr"
      ? "Merci. Veuillez vérifier leur situation dès que possible."
      : "Thank you. Please check on them as soon as possible.";

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  ${speechBlocks}
  <Gather numDigits="1" action="${gatherUrl}" method="POST" timeout="8">
    <Pause length="8"/>
  </Gather>
  <Say voice="${voice}" language="${langAttr}">${thankyouMsg}</Say>
  <Hangup/>
</Response>`;

    res.type("text/xml").send(xml);
  } catch (err) {
    console.error("❌ POST /twiml/voice error:", err);
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    This is a Safety Check emergency alert. Please check on your contact immediately.
  </Say>
  <Hangup/>
</Response>`);
  }
});

// ─── POST /twiml/gather ───────────────────────────────────────────────────────

twimlRouter.post("/gather", async (req: Request, res: Response) => {
  const alertId = req.query.alertId as string | undefined;
  const lang: "fr" | "en" = req.query.lang === "en" ? "en" : "fr";
  const { Digits } = req.body as { Digits?: string };

  if (Digits === "1") {
    const redirectUrl = alertId
      ? `${BASE_URL}/twiml/voice?alertId=${encodeURIComponent(alertId)}&lang=${lang}`
      : `${BASE_URL}/twiml/voice?lang=${lang}`;
    return res.redirect(303, redirectUrl);
  }

  const voice = twimlVoice(lang);
  const langAttr = twimlLang(lang);
  const msg = lang === "fr"
    ? "Merci. Prenez soin de vérifier la situation rapidement. Au revoir."
    : "Thank you. Please check on them as soon as possible. Goodbye.";

  return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langAttr}">${msg}</Say>
  <Hangup/>
</Response>`);
});

// ─── POST /twiml/amd-callback ─────────────────────────────────────────────────

twimlRouter.post("/amd-callback", async (req: Request, res: Response) => {
  const { CallSid, AnsweredBy } = req.body as {
    CallSid?: string;
    AnsweredBy?: string;
  };
  console.log(`🤖 AMD — CallSid: ${CallSid}, AnsweredBy: ${AnsweredBy}`);
  if (CallSid) {
    try {
      await db.alertAction.updateMany({
        where: { providerSid: CallSid },
        data: { amdResult: AnsweredBy ?? "unknown" },
      });
    } catch (err) {
      console.error("❌ AMD callback DB update failed:", err);
    }
  }
  res.sendStatus(204);
});

// ─── POST /twiml/call-status ──────────────────────────────────────────────────

twimlRouter.post("/call-status", async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body as {
    CallSid?: string;
    CallStatus?: string;
    CallDuration?: string;
  };
  console.log(`📞 Call status — SID: ${CallSid}, Status: ${CallStatus}, Duration: ${CallDuration ?? "?"}s`);
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
    } catch (err) {
      console.error("❌ Call status DB update failed:", err);
    }
  }
  res.sendStatus(204);
});