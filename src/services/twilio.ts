// ─── src/services/twilio.ts ──────────────────────────────────────────────────
//
// PHASE 1 CASCADE :
//   1. sendLocationSMS / callEmergencyContact ciblent UN contact précis.
//   2. Chaque AlertAction enregistre contactId (compteur par contact + timeline).
//   3. La garde MAX_CALL_ATTEMPTS est PAR CONTACT.
//   4. NOUVEAU : sendCascadeFailureSMS — SMS d'escalade envoyé à un contact
//      quand la cascade a ÉCHOUÉ (aucun contact joint). Formulation plus
//      pressante que le SMS initial. Idempotent par contact (destination
//      "failure-escalation").

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

// SMS d'ÉCHEC — plus pressant. Envoyé quand PERSONNE n'a décroché après toute
// la cascade. Le contact a déjà reçu le SMS initial : celui-ci signale que les
// appels ont tous échoué et qu'une action immédiate est nécessaire.
function buildFailureSMSBody(
  contactName: string,
  userName: string,
  mapsLink: string | null,
  language: string,
): string {
  if (language === "en") {
    return (
      `⚠️ URGENT — ${contactName},\n\n` +
      `SafetyCheck tried to reach you by phone several times but no one answered. ` +
      `We still cannot confirm that ${userName} is safe. ` +
      `Please call 911 (US/Canada) or 112 (EU) NOW and request a wellness check` +
      (mapsLink
        ? ` at their last known location.\n\n📍 ${mapsLink}`
        : `.`)
    );
  }

  return (
    `⚠️ URGENT — ${contactName},\n\n` +
    `SafetyCheck a tente de vous joindre par telephone a plusieurs reprises sans reponse. ` +
    `Nous ne pouvons toujours pas confirmer que ${userName} est en securite. ` +
    `Veuillez appeler le 911 (Etats-Unis/Canada) ou le 112 (UE) MAINTENANT et demander une verification de bien-etre` +
    (mapsLink
      ? ` a sa derniere position connue.\n\n📍 ${mapsLink}`
      : `.`)
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

function mapsLinkFor(alert: any, user: any): string | null {
  const lat = alert.latAtTrigger ?? user.lastLat ?? null;
  const lng = alert.lngAtTrigger ?? user.lastLng ?? null;
  return lat != null && lng != null
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : null;
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
  const mapsLink = mapsLinkFor(alert, user);

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

// ─── SMS D'ÉCHEC / ESCALADE ───────────────────────────────────────────────────
// Envoyé quand la cascade est épuisée (aucun contact joint).
// Idempotent par contact : destination "failure-escalation".

export async function sendCascadeFailureSMS(
  alertId: string,
  contactId: string,
): Promise<string | null> {
  const { alert, user, contact } = await loadAlertAndContact(alertId, contactId);

  // Déjà escaladé pour ce contact ? → ne pas renvoyer.
  const already = await db.alertAction.findFirst({
    where: {
      alertId,
      contactId: contact.id,
      actionType: "SMS",
      destination: "failure-escalation",
    },
    select: { id: true },
  });
  if (already) {
    console.log(
      `ℹ️ Failure SMS already sent to contact ${contact.id} for alert ${alertId}`,
    );
    return null;
  }

  const userName = user.firstName ?? "your contact";
  const language = user.language ?? "fr";
  const mapsLink = mapsLinkFor(alert, user);

  const body = buildFailureSMSBody(contact.name, userName, mapsLink, language);

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
      destination: "failure-escalation",
      contactId: contact.id,
      outcome: message.status,
      providerSid: message.sid,
      executedAt: new Date(),
    },
  });

  console.log(
    `🚨 Failure escalation SMS sent for alert ${alertId} → contact ${contact.id} → SID ${message.sid}`,
  );
  return message.sid;
}

// ─── VOICE CALL ──────────────────────────────────────────────────────────────

export async function callEmergencyContact(
  alertId: string,
  contactId: string,
): Promise<string> {
  const { user, contact } = await loadAlertAndContact(alertId, contactId);

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