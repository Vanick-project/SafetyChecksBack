import twilio from "twilio";
import { db } from "../db/client.js";
import { MAX_CALL_ATTEMPTS } from "../config/constants.js";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER!;

// ─── SMS D'ESCALADE ───────────────────────────────────────────────────────────
// Envoyé au contact d'urgence après MAX_CALL_ATTEMPTS appels sans réponse.
// Canal configurable : "sms" | "whatsapp" | "both" (champ alertChannel sur User)

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

  const hasLocation = alert.latAtTrigger != null && alert.lngAtTrigger != null;
  const mapsLink = hasLocation
    ? `https://www.google.com/maps?q=${alert.latAtTrigger},${alert.lngAtTrigger}`
    : null;

  const body =
    `Hello ${contactName},\n\n` +
    `This is SafetyCheck. We are contacting you on behalf of ${userName}. ` +
    `We are unable to confirm whether ${userName} is safe at this time. ` +
    `Please call 911 for a wellness check` +
    (mapsLink
      ? ` and review the link below for their last known location.`
      : `.`) +
    `\n\nThank you.\n\n` +
    `---\n\n` +
    `Bonjour ${contactName},\n\n` +
    `Ceci est SafetyCheck. Nous vous contactons au nom de ${userName}. ` +
    `Nous ne sommes pas en mesure de confirmer si ${userName} est en sécurité. ` +
    `Veuillez appeler le 911 pour une vérification de bien-être` +
    (mapsLink
      ? ` et consultez le lien ci-dessous pour sa dernière position connue.`
      : `.`) +
    `\n\nMerci.` +
    (mapsLink ? `\n\n📍 ${mapsLink}` : "");

  const sendSMS = async () => {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: contact!.phoneNumber,
      statusCallback: `${process.env.API_BASE_URL}/twilio/sms-status`,
    });

    // actionType "CALL" + destination "escalation" = marqueur interne
    // pour que handleEscalation() détecte l'idempotence
    await db.alertAction.create({
      data: {
        alertId,
        actionType: "CALL",
        destination: "escalation",
        outcome: `escalation_sms_sent:${message.sid}`,
        executedAt: new Date(),
      },
    });

    console.log(
      `📱 Escalation SMS sent to emergency contact for alert ${alertId} → ${message.sid}`,
    );
  };

  const sendWhatsApp = async () => {
    const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER ?? process.env.TWILIO_PHONE_NUMBER}`;
    const to = `whatsapp:${contact!.phoneNumber}`;

    const message = await client.messages.create({
      body,
      from,
      to,
      statusCallback: `${process.env.API_BASE_URL}/twilio/sms-status`,
    });

    await db.alertAction.create({
      data: {
        alertId,
        actionType: "CALL",
        destination: "escalation",
        outcome: `escalation_whatsapp_sent:${message.sid}`,
        executedAt: new Date(),
      },
    });

    console.log(
      `💬 Escalation WhatsApp sent to emergency contact for alert ${alertId} → ${message.sid}`,
    );
  };

  if (channel === "sms") await sendSMS();
  else if (channel === "whatsapp") await sendWhatsApp();
  else if (channel === "both") await Promise.all([sendSMS(), sendWhatsApp()]);
}

// ─── SMS DE POSITION ──────────────────────────────────────────────────────────
// Envoyé immédiatement quand l'alerte se déclenche (SOS manuel ou auto).

export async function sendLocationSMS(alertId: string): Promise<string> {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert) throw new Error("Alert not found");

  const { user } = alert;
  const contact = user.emergencyContact;
  if (!contact) throw new Error("Emergency contact not found");

  const hasLocation = alert.latAtTrigger != null && alert.lngAtTrigger != null;
  const locationLine = hasLocation
    ? `Last known location:\nhttps://www.google.com/maps?q=${alert.latAtTrigger},${alert.lngAtTrigger}\n\n`
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
    statusCallback: `${process.env.API_BASE_URL}/twilio/sms-status`,
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

  // Exclut les marqueurs internes "911" (legacy) et "escalation"
  // pour ne compter que les vrais appels au contact d'urgence
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

  const hasLocation = alert.latAtTrigger != null && alert.lngAtTrigger != null;
  const mapsLink = hasLocation
    ? `https://maps.google.com/?q=${alert.latAtTrigger},${alert.lngAtTrigger}`
    : "";

  const twimlUrl =
    `${process.env.API_BASE_URL}/twiml/alert` +
    `?alertId=${encodeURIComponent(alertId)}` +
    `&name=${encodeURIComponent(user.firstName ?? "your contact")}` +
    `&location=${encodeURIComponent(mapsLink)}`;

  const call = await client.calls.create({
    url: twimlUrl,
    from: FROM_NUMBER,
    to: contact.phoneNumber,
    timeout: 20,
    statusCallback: `${process.env.API_BASE_URL}/twilio/call-status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    machineDetection: "Enable",
    asyncAmd: "true",
    asyncAmdStatusCallback: `${process.env.API_BASE_URL}/twilio/amd-status`,
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

// ─── TWIML BUILDER ───────────────────────────────────────────────────────────

export function buildAlertTwiML(name: string, mapsLink: string): string {
  const repeatUrl = `${process.env.API_BASE_URL}/twiml/repeat`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    This is an automated Safety Check alert.
    ${name} has not responded to their safety check-in and may need assistance.
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    Their last known location has been sent to you by text message.
    Please try to contact them immediately.
    If you cannot reach them, please call emergency services.
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    To repeat this message, press 1. Otherwise, please hang up and take action now.
  </Say>
  <Gather numDigits="1" action="${repeatUrl}" method="POST">
    <Pause length="6"/>
  </Gather>
  <Say voice="Polly.Joanna" language="en-US">
    Thank you. Please check on them as soon as possible. Goodbye.
  </Say>
</Response>`;
}
