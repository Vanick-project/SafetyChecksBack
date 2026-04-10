import twilio from "twilio";
import { db } from "../db/client.js";
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
// ─── SMS ────────────────────────────────────────────────────────────────────
export async function sendLocationSMS(alertId) {
    const alert = await db.alertEvent.findUnique({
        where: { id: alertId },
        include: { user: { include: { emergencyContact: true } } },
    });
    if (!alert)
        throw new Error("Alert not found");
    const { user } = alert;
    const contact = user.emergencyContact;
    const mapsLink = `https://www.google.com/maps?q=${alert.latAtTrigger},${alert.lngAtTrigger}`;
    if (!contact) {
        throw new Error("Emergency contact not found");
    }
    const body = `SAFETY ALERT: ${user.firstName ?? "Your contact"} has not responded ` +
        `to their Safety Check app.\n\n` +
        `Last known location:\n${mapsLink}\n\n` +
        `If you cannot reach them, please call emergency services.`;
    const message = await client.messages.create({
        body,
        from: FROM_NUMBER,
        to: contact.phoneNumber,
        statusCallback: `${process.env.API_BASE_URL}/twiml/sms-status`,
    });
    // Log the action
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
    return message.sid;
}
// ─── VOICE CALL ─────────────────────────────────────────────────────────────
export async function callEmergencyContact(alertId) {
    const alert = await db.alertEvent.findUnique({
        where: { id: alertId },
        include: { user: { include: { emergencyContact: true } } },
    });
    if (!alert)
        throw new Error("Alert not found");
    const { user } = alert;
    const contact = user.emergencyContact;
    if (!contact) {
        throw new Error("Emergency contact not found");
    }
    const previousAttempts = await db.alertAction.count({
        where: {
            alertId,
            actionType: "CALL",
        },
    });
    const MAX_CALL_ATTEMPTS = 3; // 1 initial + 2 retries
    if (previousAttempts >= MAX_CALL_ATTEMPTS) {
        throw new Error("Max emergency call attempts reached");
    }
    const mapsLink = `https://maps.google.com/?q=${alert.latAtTrigger},${alert.lngAtTrigger}`;
    const twimlUrl = `${process.env.API_BASE_URL}/twiml/alert` +
        `?alertId=${alertId}` +
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
    console.log(`📞 Emergency call attempt ${previousAttempts + 1}/${MAX_CALL_ATTEMPTS} created for alert ${alertId}`);
    return call.sid;
}
// ─── TWIML ENDPOINT (Express route) ─────────────────────────────────────────
// Mount this at GET /twiml/alert in your Express app.
// Twilio fetches it when the contact picks up the call.
export function buildAlertTwiML(name, mapsLink) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    This is an automated Safety Check alert.
    ${name} has not responded to their safety check-in
    and may need assistance.
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    Their last known location has been sent to you by text message.
    Please try to contact them immediately.
    If you cannot reach them, please call emergency services.
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    To repeat this message, press 1.
  </Say>
  <Gather numDigits="1" action="/twiml/repeat" method="POST">
    <Pause length="5"/>
  </Gather>
</Response>`;
}
//# sourceMappingURL=twilio.js.map