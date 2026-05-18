import { Router } from "express";
import type { Request, Response } from "express";
import { buildAlertTwiML } from "../services/twilio.js";

export const twimlRouter = Router();
console.log("✅ twimlRouter loaded");

// GET /twiml/alert
// Twilio fetches this URL when the emergency contact picks up the call.
twimlRouter.get("/alert", (req: Request, res: Response) => {
  const { name, location } = req.query as { name: string; location: string };

  const xml = buildAlertTwiML(
    decodeURIComponent(name ?? "your contact"),
    decodeURIComponent(location ?? ""),
  );

  res.type("text/xml").send(xml);
});

// POST /twiml/repeat
// Handles "Press 1 to repeat" from the TwiML <Gather>.
twimlRouter.post("/repeat", (req: Request, res: Response) => {
  const { Digits } = req.body;

  if (Digits === "1") {
    const { name, location } = req.query as { name: string; location: string };

    const xml = buildAlertTwiML(
      decodeURIComponent(name ?? "your contact"),
      decodeURIComponent(location ?? ""),
    );

    return res.type("text/xml").send(xml);
  }

  // Any other key (or timeout) → hang up gracefully.
  return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    Thank you. Please check on them as soon as possible.
  </Say>
  <Hangup/>
</Response>`);
});
