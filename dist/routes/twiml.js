import { Router } from "express";
import { db } from "../db/client.js";
import { buildAlertTwiML } from "../services/twilio.js";
export const twimlRouter = Router();
console.log("✅ twimlRouter loaded");
// GET /twiml/alert
// Twilio fetches this URL when the emergency contact picks up the call.
twimlRouter.get("/alert", (req, res) => {
    const { name, location } = req.query;
    const xml = buildAlertTwiML(decodeURIComponent(name ?? "your contact"), decodeURIComponent(location ?? ""));
    res.type("text/xml").send(xml);
});
// POST /twiml/repeat
// Handles "Press 1 to repeat" from the TwiML <Gather>.
twimlRouter.post("/repeat", (req, res) => {
    const { Digits } = req.body;
    if (Digits === "1") {
        const { name, location } = req.query;
        const xml = buildAlertTwiML(decodeURIComponent(name ?? "your contact"), decodeURIComponent(location ?? ""));
        return res.type("text/xml").send(xml);
    }
    res.type("text/xml").send(`<Response><Hangup/></Response>`);
});
// POST /twilio/call-status
// Twilio posts here after a call completes — updates the action log.
twimlRouter.post("/call-status", async (req, res) => {
    try {
        const { CallSid, CallStatus } = req.body;
        console.log("📞 Twilio callback:", CallSid, CallStatus);
        // update alertAction lié à ce call
        const result = await db.alertAction.updateMany({
            where: {
                providerSid: CallSid,
                actionType: "CALL",
            },
            data: {
                outcome: CallStatus === "completed" ? "SUCCESS" : CallStatus, // completed, failed, no-answer...
            },
        });
        console.log("CALL UPDATED:", result.count);
        res.sendStatus(200);
    }
    catch (err) {
        console.error("❌ Twilio callback error:", err);
        res.sendStatus(500);
    }
});
//¨POST /twilio/sms-status
// Twilio posts here after an SMS is delivered — updates the action log.
twimlRouter.post("/sms-status", async (req, res) => {
    try {
        const { MessageSid, MessageStatus } = req.body;
        console.log("📩 SMS callback:", MessageSid, MessageStatus);
        const result = await db.alertAction.updateMany({
            where: {
                providerSid: MessageSid,
                actionType: "SMS",
            },
            data: {
                outcome: MessageStatus,
            },
        });
        console.log("SMS UPDATED:", result.count);
        res.sendStatus(200);
    }
    catch (err) {
        console.error("❌ SMS callback error:", err);
        res.sendStatus(500);
    }
});
//# sourceMappingURL=twiml.js.map