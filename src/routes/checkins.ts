// ─── src/routes/checkins.ts ───────────────────────────────────────────────────
// SECURITY: Input now validated via checkInResponseSchema (Zod).
// Uses z.enum(["OK","SOS"]) — invalid values rejected at schema level.

import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { db } from "../db/client.js";
import { handleUserResponse } from "../jobs/checkin-scheduler.js";
import { checkInResponseSchema } from "../validators/schemas.js";

export const checkInRouter = Router();

// POST /checkins/respond
checkInRouter.post("/respond", async (req: Request, res: Response) => {
  try {
    const parsed = checkInResponseSchema.parse(req.body);
    const { userId, checkInId, response, source } = parsed;

    // Backwards-compatible source resolution:
    // - If source is explicitly sent → use it
    // - If checkInId is "manual" or "manual-sos" (legacy clients) → manual
    // - Otherwise → scheduled
    const resolvedSource =
      source ??
      (checkInId === "manual" || checkInId === "manual-sos"
        ? "manual"
        : "scheduled");

    await handleUserResponse(userId, checkInId, response, resolvedSource);

    return res.json({
      ok: true,
      message:
        response === "OK"
          ? "Check-in recorded successfully."
          : "SOS alert triggered.",
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid check-in payload",
        details: err.flatten(),
      });
    }

    console.error("POST /checkins/respond error:", err);
    return res
      .status(500)
      .json({ error: "Failed to process check-in response" });
  }
});

// GET /checkins/history/:userId
checkInRouter.get("/history/:userId", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);

    // Basic CUID format check to avoid arbitrary strings hitting the DB.
    if (!/^c[a-z0-9]{24,}$/.test(userId)) {
      return res.status(400).json({ error: "Invalid userId format" });
    }

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
