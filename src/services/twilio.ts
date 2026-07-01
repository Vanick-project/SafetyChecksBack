// ─── src/services/twilio.ts ──────────────────────────────────────────────────
//
// CORRECTIONS :
//
//   1. URL APPEL — callEmergencyContact pointait vers /twiml/alert (ancien endpoint
//      qui n'existe plus dans twiml.ts). Maintenant pointe vers /twiml/voice
//      avec alertId et lang en query params.
//      /twiml/voice charge le nom et les coords depuis la DB → message personnalisé.
//
//   2. CALLBACKS AMD ET STATUS — asyncAmdStatusCallback pointe vers /twiml/amd-callback
//      et statusCallback vers /twiml/call-status (dans twiml.ts),
//      pour que les résultats AMD et le statut final soient sauvegardés en DB.
//
//   3. buildAlertTwiML retiré — le TwiML est maintenant construit dans twiml.ts
//      directement depuis la DB. Plus besoin de ce helper ici.

import twilio from "twilio";
import { db } from "../db/client.js";
import { MAX_CALL_ATTEMPTS } from "../config/constants.js";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER!;
const BASE_URL = process.env.API_BASE_URL!;

// ─── SMS D'ESCALADE ───────────────────────────────────────────────────────────

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

  const lat = alert.latAtTrigger ?? user.lastLat;
  const lng = alert.lngAtTrigger ?? user.lastLng;
  const hasLocation = lat != null && lng != null;
  const mapsLink = hasLocation
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : null;

  const body =
    language === "en"
      ? `Hello ${contactName},\n\n` +
        `This is SafetyCheck. We are contacting you on behalf of ${userName}. ` +
        `We are unable to confirm whether ${userName} is safe at this time. ` +
        `Please call 911 for a wellness check` +
        (mapsLink ? ` and review the link below for their last known location.` : `.`) +
        `\n\nThank you.` +
        (mapsLink ? `\n\n📍 ${mapsLink}` : "")
      : `Bonjour ${contactName},\n\n` +
        `Ceci est SafetyCheck. Nous vous contactons au nom de ${userName}. ` +
        `Nous ne sommes pas en mesure de confirmer si ${userName} est en sécurité. ` +
        `Veuillez appeler le 911 pour une vérification de bien-être` +
        (mapsLink ? ` et consultez le lien ci-dessous pour sa dernière position connue.` : `.`) +
        `\n\nMerci.` +
        (mapsLink ? `\n\n📍 ${mapsLink}` : "");

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

export async function sendLocationSMS(alertId: string): Promise<string> {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert) throw new Error("Alert not found");

  const { user } = alert;
  const contact = user.emergencyContact;
  if (!contact) throw new Error("Emergency contact not found");

  const lat = alert.latAtTrigger ?? user.lastLat;
const lng = alert.lngAtTrigger ?? user.lastLng;
const hasLocation = lat != null && lng != null;
const locationLine = hasLocation
  ? `Last known location:\nhttps://www.google.com/maps?q=${lat},${lng}\n\n`
  : `Location is unavailable at this time.\n\n`;

  const body =
    `SAFETY ALERT: ${user.firstName ?? "Your contact"} has not responded ` +
    `to their Safety Check app.\n\n` +
    locationLine +
    `If you cannot reach them, please call emergency services.`;

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

  // CORRECTION : URL pointe vers /twiml/voice avec alertId et lang
  // → twiml.ts charge le nom et les coords depuis la DB
  // → message vocal personnalisé FR ou EN selon la langue de l'utilisateur
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
    // CORRECTION : statusCallback → /twiml/call-status (dans twiml.ts)
    statusCallback: `${BASE_URL}/twiml/call-status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    // AMD = Answering Machine Detection
    // DetectMessageEnd attend la fin du message répondeur avant de jouer le TwiML
    // (meilleur que Enable qui coupe au milieu du message répondeur)
    machineDetection: "DetectMessageEnd",
    asyncAmd: "true",
    // CORRECTION : amdCallback → /twiml/amd-callback (dans twiml.ts)
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