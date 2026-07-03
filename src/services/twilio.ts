// ─── src/services/twilio.ts ──────────────────────────────────────────────────
//
// CHANGEMENTS :
//   1. sendLocationSMS et sendEscalationSMS : message unifié au format demandé :
//      "Hello [Contact], This is SafetyCheck... Please call 911... [maps link]"
//   2. callEmergencyContact : URL mise à jour vers /twiml/voice (nouveau endpoint)

import twilio from "twilio";
import { db } from "../db/client.js";
import { MAX_CALL_ATTEMPTS } from "../config/constants.js";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER!;
const BASE_URL = process.env.API_BASE_URL!;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildSMSBody(
  contactName: string,
  userName: string,
  mapsLink: string | null,
  language: string,
): string {
  // Format demandé exactement, avec localisation si disponible
  if (language === "en") {
    return (
      `Hello ${contactName},\n\n` +
      `This is SafetyCheck. We are contacting you on behalf of ${userName}. ` +
      `We are unable to confirm whether ${userName} is safe at this time. ` +
      `Please call 911 for a wellness check` +
      (mapsLink
        ? ` and review your private messages for his last known location.\n\nThank you.\n\n📍 ${mapsLink}`
        : `.\n\nThank you.`)
    );
  }

  // Français
  return (
    `Bonjour ${contactName},\n\n` +
    `Ceci est SafetyCheck. Nous vous contactons au nom de ${userName}. ` +
    `Nous ne sommes pas en mesure de confirmer si ${userName} est en securite. ` +
    `Veuillez appeler le 911 pour une verification de bien-etre` +
    (mapsLink
      ? ` et consulter vos messages prives pour sa derniere position connue.\n\nMerci.\n\n📍 ${mapsLink}`
      : `.\n\nMerci.`)
  );
}

// ─── SMS D'ESCALADE ───────────────────────────────────────────────────────────
// Envoyé au contact d'urgence après MAX_CALL_ATTEMPTS appels sans réponse.

export async function sendEscalationSMS(alertId: string): Promise<void> {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert) throw new Error("Alert not found");

  const { user } = alert;
  const contact = user.emergencyContact;
  if (!contact) throw new Error("Emergency contact not found");

  const userName = user.firstName ?? "your contact";
  const contactName = contact.name;
  const channel = (user as any).alertChannel ?? "sms";
  const language = (user as any).language ?? "fr";

  const hasLocation = alert.latAtTrigger != null && alert.lngAtTrigger != null;
  const mapsLink = hasLocation
    ? `https://www.google.com/maps?q=${alert.latAtTrigger},${alert.lngAtTrigger}`
    : null;

  const body = buildSMSBody(contactName, userName, mapsLink, language);

  const sendSMS = async () => {
    const message = await client.messages.create({
      body,
      from: FROM_NUMBER,
      to: contact!.phoneNumber,
      statusCallback: `${BASE_URL}/twilio/sms-status`,
    });

    await db.alertAction.create({
      data: {
        alertId,
        actionType: "CALL",
        destination: "escalation",
        outcome: "escalation_sms_sent",
        executedAt: new Date(),
      },
    });

    console.log(`📱 Escalation SMS sent for alert ${alertId} → ${message.sid}`);
  };

  const sendWhatsApp = async () => {
    const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER ?? FROM_NUMBER}`;
    const to = `whatsapp:${contact!.phoneNumber}`;

    const message = await client.messages.create({
      body,
      from,
      to,
      statusCallback: `${BASE_URL}/twilio/sms-status`,
    });

    await db.alertAction.create({
      data: {
        alertId,
        actionType: "CALL",
        destination: "escalation",
        outcome: "escalation_whatsapp_sent",
        executedAt: new Date(),
      },
    });

    console.log(`💬 Escalation WhatsApp sent for alert ${alertId} → ${message.sid}`);
  };

  if (channel === "sms") await sendSMS();
  else if (channel === "whatsapp") await sendWhatsApp();
  else if (channel === "both") await Promise.all([sendSMS(), sendWhatsApp()]);
}

// ─── SMS DE POSITION ──────────────────────────────────────────────────────────
// Envoyé immédiatement quand l'alerte se déclenche (SOS manuel ou auto).
// Utilise le même format de message que sendEscalationSMS.

export async function sendLocationSMS(alertId: string): Promise<string> {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert) throw new Error("Alert not found");

  const { user } = alert;
  const contact = user.emergencyContact;
  if (!contact) throw new Error("Emergency contact not found");

  const userName = user.firstName ?? "your contact";
  const contactName = contact.name;
  const language = (user as any).language ?? "fr";

  const hasLocation = alert.latAtTrigger != null && alert.lngAtTrigger != null;
  const mapsLink = hasLocation
    ? `https://www.google.com/maps?q=${alert.latAtTrigger},${alert.lngAtTrigger}`
    : null;

  const body = buildSMSBody(contactName, userName, mapsLink, language);

  const message = await client.messages.create({
    body,
    from: FROM_NUMBER,
    to: contact.phoneNumber,
    statusCallback: `${BASE_URL}/twilio/sms-status`,
  });

  await db.alertAction.create({
    data: {
      alertId,
      actionType: "SMS",
      destination: contact.phoneNumber,
      outcome: message.status,
      providerSid: message.sid,
      executedAt: new Date(),
    },
  });

  console.log(`📩 Location SMS sent for alert ${alertId} → SID ${message.sid}`);
  return message.sid;
}

// ─── VOICE CALL ──────────────────────────────────────────────────────────────

export async function callEmergencyContact(alertId: string) {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert) throw new Error("Alert not found");

  const { user } = alert;
  const contact = user.emergencyContact;
  if (!contact) throw new Error("Emergency contact not found");

  const previousAttempts = await db.alertAction.count({
    where: {
      alertId,
      actionType: "CALL",
      destination: { notIn: ["911", "escalation"] },
    },
  });

  if (previousAttempts >= MAX_CALL_ATTEMPTS) {
    throw new Error(
      `Max emergency call attempts (${MAX_CALL_ATTEMPTS}) already reached for alert ${alertId}`,
    );
  }

  const lang = (user as any).language ?? "fr";

  const twimlUrl =
    `${BASE_URL}/twiml/voice` +
    `?alertId=${encodeURIComponent(alertId)}` +
    `&lang=${encodeURIComponent(lang)}`;

  const call = await client.calls.create({
    url: twimlUrl,
    from: FROM_NUMBER,
    to: contact.phoneNumber,
    timeout: 20,
    statusCallback: `${BASE_URL}/twiml/call-status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    machineDetection: "DetectMessageEnd",
    asyncAmd: "true",
    asyncAmdStatusCallback: `${BASE_URL}/twiml/amd-callback`,
    asyncAmdStatusCallbackMethod: "POST",
  });

  await db.alertAction.create({
    data: {
      alertId,
      actionType: "CALL",
      destination: contact.phoneNumber,
      outcome: call.status,
      providerSid: call.sid,
      executedAt: new Date(),
    },
  });

  console.log(
    `📞 Emergency call attempt ${previousAttempts + 1}/${MAX_CALL_ATTEMPTS} ` +
    `created for alert ${alertId} → SID ${call.sid}`,
  );

  return call.sid;
}

// buildAlertTwiML conservé pour compatibilité — ne plus utiliser en production
export function buildAlertTwiML(name: string, _mapsLink: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${name}</Say></Response>`;
}