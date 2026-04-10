import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/client.js";
import { handleUserResponse } from "../jobs/checkin-scheduler.js";

// TEMP: disable Redis-dependent job
/*
const handleUserResponse = async () => {
  console.log("⚠️ handleUserResponse skipped (Redis disabled)");
};*/

// ─── CHECK-IN ROUTES ─────────────────────────────────────────────────────────

export const checkInRouter = Router();

// POST /checkins/respond
// Called when the user taps "I'm ok" or "Need help" on the notification.
checkInRouter.post("/respond", async (req: Request, res: Response) => {
  try {
    const { userId, checkInId, response } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    if (!checkInId) {
      return res.status(400).json({ error: "Missing checkInId" });
    }

    if (!["OK", "SOS"].includes(response)) {
      return res.status(400).json({ error: "Invalid response value" });
    }

    await handleUserResponse(userId, checkInId, response);

    return res.json({
      ok: true,
      message:
        response === "OK"
          ? "Check-in recorded successfully."
          : "SOS alert triggered.",
    });
  } catch (err) {
    console.error("POST /checkins/respond error:", err);
    return res.status(500).json({
      error: "Failed to process check-in response",
    });
  }
});

// GET /checkins/history/:userId
// Optional — powers a future "check-in history" screen.
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
