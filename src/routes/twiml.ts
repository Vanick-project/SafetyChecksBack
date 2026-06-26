// ─── src/routes/twiml.ts ──────────────────────────────────────────────────────
//
// Remplace entièrement l'ancien twiml.ts qui importait buildAlertTwiML
// depuis twilio.ts (fonction supprimée).
//
// Endpoints :
//   GET  /twiml/voice        — Message vocal principal (FR Polly.Léa / EN Polly.Joanna)
//   POST /twiml/gather       — Gère la touche 1 (répéter) ou timeout (raccrocher)
//   POST /twiml/amd-callback — Résultat AMD async (human/machine) → sauvegardé en DB
//   POST /twiml/call-status  — Statut final de l'appel + durée → sauvegardé en DB

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

function buildSpeechBlocks(
  lang: "fr" | "en",
  userName: string,
  hasLocation: boolean,
): string {
  const voice = twimlVoice(lang);
  const langAttr = twimlLang(lang);

  if (lang === "fr") {
    const locationLine = hasLocation
      ? "Leur dernière position connue a été envoyée par SMS."
      : "Leur position n'est pas disponible pour le moment.";

    return `
  <Say voice="${voice}" language="${langAttr}">Bonjour.</Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    Ceci est une alerte automatique de l'application Safety Check.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${userName} n'a pas répondu à ses vérifications de sécurité et pourrait avoir besoin d'aide immédiate.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${locationLine} Veuillez essayer de les contacter immédiatement.
    Si vous ne pouvez pas les joindre, appelez les services d'urgence.
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
    ${userName} has not responded to their safety check-ins and may need immediate help.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    ${locationLine} Please try to contact them immediately.
    If you cannot reach them, please call emergency services.
  </Say>
  <Pause length="1"/>
  <Say voice="${voice}" language="${langAttr}">
    To repeat this message, press 1. Otherwise please hang up and take action now.
  </Say>`;
}

// ─── GET /twiml/voice ─────────────────────────────────────────────────────────
// Twilio appelle cette URL quand le contact décroche.
// Query params : alertId, lang ('fr' | 'en')

twimlRouter.get("/voice", async (req: Request, res: Response) => {
  const alertId = req.query.alertId as string | undefined;
  const lang: "fr" | "en" = req.query.lang === "en" ? "en" : "fr";

  try {
    let userName = lang === "fr" ? "votre contact" : "your contact";
    let hasLocation = false;

    if (alertId) {
      const alert = await db.alertEvent.findUnique({
        where: { id: alertId },
        include: { user: true },
      });
      if (alert?.user?.firstName) {
        userName = alert.user.firstName;
      }
      hasLocation =
        alert?.latAtTrigger != null && alert?.lngAtTrigger != null;
    }

    const voice = twimlVoice(lang);
    const langAttr = twimlLang(lang);
    const speechBlocks = buildSpeechBlocks(lang, userName, hasLocation);
    const gatherUrl = alertId
      ? `${BASE_URL}/twiml/gather?alertId=${encodeURIComponent(alertId)}&lang=${lang}`
      : `${BASE_URL}/twiml/gather?lang=${lang}`;

    const thankyouMsg =
      lang === "fr"
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
  const msg =
    lang === "fr"
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

  console.log(
    `📞 Call status — SID: ${CallSid}, Status: ${CallStatus}, Duration: ${CallDuration ?? "?"}s`,
  );

  if (CallSid) {
    try {
      await db.alertAction.updateMany({
        where: { providerSid: CallSid },
        data: {
          callStatus: CallStatus ?? null,
          callDuration: CallDuration ? parseInt(CallDuration, 10) : null,
          // outcome est non-nullable en DB — on n'écrase pas la valeur existante
          // si CallStatus est absent (undefined = Prisma ignore le champ)
          ...(CallStatus !== undefined && { outcome: CallStatus }),
        },
      });
    } catch (err) {
      console.error("❌ Call status DB update failed:", err);
    }
  }

  res.sendStatus(204);
});