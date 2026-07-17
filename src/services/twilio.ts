// ─── src/services/twilio.ts ──────────────────────────────────────────────────
//
// PHASE 1 CASCADE :
//   1. sendLocationSMS(alertId, contactId) et callEmergencyContact(alertId,
//      contactId) ciblent désormais UN contact précis — la cascade décide lequel.
//   2. Chaque AlertAction enregistre contactId → compteur de tentatives PAR
//      contact + timeline par contact sur l'AlertScreen et le futur dashboard.
//   3. sendEscalationSMS SUPPRIMÉ : la cascade remplace l'escalade (chaque
//      contact reçoit son SMS géolocalisé au moment où il est engagé).
//   4. La garde MAX_CALL_ATTEMPTS est désormais PAR CONTACT.

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
  if (language === "en") {
    return (
      `Hello ${contactName},\n\n` +
      `This is SafetyCheck. We are contacting you on behalf of ${userName}. ` +
      `We are unable to confirm whether ${userName} is safe at this time. ` +
      `Please call 911 if you are in the United States or Canada, or 112 if you are in the European Union, for a wellness check` +
      (mapsLink
        ? ` and review your private messages for his last known location.\n\nThank you.\n\n📍 ${mapsLink}`
        : `.\n\nThank you.`)
    );
  }

  return (
    `Bonjour ${contactName},\n\n` +
    `Ceci est SafetyCheck. Nous vous contactons au nom de ${userName}. ` +
    `Nous ne sommes pas en mesure de confirmer si ${userName} est en securite. ` +
    `Veuillez contacter immediatement le 911 si vous etes aux Etats-Unis ou au Canada, ou le 112 si vous etes dans l'Union europeenne, pour une verification de bien-etre` +
    (mapsLink
      ? ` et consulter vos messages prives pour sa derniere position connue.\n\nMerci.\n\n📍 ${mapsLink}`
      : `.\n\nMerci.`)
  );
}

/**
 * Charge l'alerte + l'utilisateur + LE contact ciblé, avec vérification
 * d'appartenance (le contact doit appartenir au propriétaire de l'alerte).
 */
async function loadAlertAndContact(alertId: string, contactId: string) {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: true },
  });
  if (!alert) throw new Error(`Alert ${alertId} not found`);

  const contact = await db.emergencyContact.findUnique({
    where: { id: contactId },
  });
  if (!contact) throw new Error(`Emergency contact ${contactId} not found`);
  if (contact.userId !== alert.userId) {
    throw new Error(
      `Contact ${contactId} does not belong to user ${alert.userId} (alert ${alertId})`,
    );
  }

  return { alert, user: alert.user, contact };
}

// ─── SMS DE POSITION ──────────────────────────────────────────────────────────
// Envoyé au contact au moment où la cascade l'engage (une fois par contact).

export async function sendLocationSMS(
  alertId: string,
  contactId: string,
): Promise<string> {
  const { alert, user, contact } = await loadAlertAndContact(alertId, contactId);

  const userName = user.firstName ?? "your contact";
  const language = user.language ?? "fr";

  // Coordonnées figées à l'alerte, sinon dernière position connue
  const lat = alert.latAtTrigger ?? user.lastLat ?? null;
  const lng = alert.lngAtTrigger ?? user.lastLng ?? null;
  const mapsLink =
    lat != null && lng != null
      ? `https://www.google.com/maps?q=${lat},${lng}`
      : null;

  const body = buildSMSBody(contact.name, userName, mapsLink, language);

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
      contactId: contact.id,
      outcome: message.status,
      providerSid: message.sid,
      executedAt: new Date(),
    },
  });

  console.log(
    `📩 Location SMS sent for alert ${alertId} → contact ${contact.id} → SID ${message.sid}`,
  );
  return message.sid;
}

// ─── VOICE CALL ──────────────────────────────────────────────────────────────

export async function callEmergencyContact(
  alertId: string,
  contactId: string,
): Promise<string> {
  const { user, contact } = await loadAlertAndContact(alertId, contactId);

  // Garde PAR CONTACT — filet de sécurité si un job en double se glisse
  const previousAttempts = await db.alertAction.count({
    where: { alertId, actionType: "CALL", contactId: contact.id },
  });

  if (previousAttempts >= MAX_CALL_ATTEMPTS) {
    throw new Error(
      `Max call attempts (${MAX_CALL_ATTEMPTS}) already reached for contact ` +
        `${contact.id} on alert ${alertId}`,
    );
  }

  const lang = user.language ?? "fr";

  // /twiml/voice lit currentContactId en DB pour prononcer le bon nom —
  // pas besoin de passer le contact dans l'URL.
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
      contactId: contact.id,
      outcome: call.status,
      providerSid: call.sid,
      executedAt: new Date(),
    },
  });

  console.log(
    `📞 Call attempt ${previousAttempts + 1}/${MAX_CALL_ATTEMPTS} ` +
      `→ contact ${contact.id} (priority ${contact.priority}) ` +
      `for alert ${alertId} → SID ${call.sid}`,
  );

  return call.sid;
}