import twilio from "twilio";
import { db } from "../db/client.js";
import { MAX_CALL_ATTEMPTS } from "../config/constants.js";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER!;

// ─── SMS ─────────────────────────────────────────────────────────────────────

export async function sendLocationSMS(alertId: string) {
  const alert = await db.alertEvent.findUnique({
    where: { id: alertId },
    include: { user: { include: { emergencyContact: true } } },
  });

  if (!alert) throw new Error("Alert not found");

  const { user } = alert;
  const contact = user.emergencyContact;

  if (!contact) throw new Error("Emergency contact not found");

  // FIX: only include a Maps link if we actually have coordinates.
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
    // FIX: was `/twiml/sms-status` (simplified handler with no business logic).
    // Now correctly points to `/twilio/sms-status` in twilio-webhook.ts.
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

  console.log(`📩 SMS sent for alert ${alertId} → SID ${message.sid}`);
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

  // Count only real calls (exclude the simulated 911 escalation entry).
  const previousAttempts = await db.alertAction.count({
    where: {
      alertId,
      actionType: "CALL",
      destination: { not: "911" },
    },
  });

  if (previousAttempts >= MAX_CALL_ATTEMPTS) {
    throw new Error(
      `Max emergency call attempts (${MAX_CALL_ATTEMPTS}) already reached for alert ${alertId}`,
    );
  }

  // FIX: only build a Maps link if we actually have coordinates.
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
    // Capture every lifecycle event so the webhook can track exactly where
    // the call is and drive the retry / AMD logic correctly.
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
      outcome: call.status, // "queued" at creation — will be updated by webhook
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
// IMPROVEMENT: <Gather action> now uses the full absolute URL so Twilio can
// POST back correctly regardless of how it resolves relative paths.

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
