// ─── src/routes/checkins.ts ───────────────────────────────────────────────────
// Check-in response routes.
//
// IMPROVEMENT: The `handleUserResponse` call now passes a `source` field
// ("scheduled" | "manual") instead of relying on magic string IDs like
// checkInId === "manual". The caller decides the source explicitly.

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/client.js";
import { handleUserResponse } from "../jobs/checkin-scheduler.js";

export const checkInRouter = Router();

// POST /checkins/respond
// Called when the user taps "I'm ok" or "Need help" on the notification.
checkInRouter.post("/respond", async (req: Request, res: Response) => {
  try {
    const { userId, checkInId, response, source } = req.body as {
      userId?: string;
      checkInId?: string;
      response?: string;
      // FIX: explicit source field instead of magic string checkInId comparison.
      // Clients should send "scheduled" when responding to a push notification,
      // or "manual" when the user manually triggers from within the app.
      source?: "scheduled" | "manual";
    };

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    if (!checkInId) {
      return res.status(400).json({ error: "Missing checkInId" });
    }

    if (!["OK", "SOS"].includes(response ?? "")) {
      return res
        .status(400)
        .json({ error: "Invalid response value — must be OK or SOS" });
    }

    // Default to "scheduled" for backwards compatibility with clients that
    // don't yet send the `source` field.
    const resolvedSource = source ?? "scheduled";

    await handleUserResponse(
      userId,
      checkInId,
      response as "OK" | "SOS",
      resolvedSource,
    );

    return res.json({
      ok: true,
      message:
        response === "OK"
          ? "Check-in recorded successfully."
          : "SOS alert triggered.",
    });
  } catch (err) {
    console.error("POST /checkins/respond error:", err);
    return res
      .status(500)
      .json({ error: "Failed to process check-in response" });
  }
});

// GET /checkins/history/:userId
// Powers a future "check-in history" screen.
checkInRouter.get("/history/:userId", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);

    const events = await db.checkInEvent.findMany({
      where: { userId },
      orderBy: { sentAt: "desc" },
      take: 30,
    });

    return res.json(events);
  } catch (err) {
    console.error("GET /checkins/history/:userId error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});
