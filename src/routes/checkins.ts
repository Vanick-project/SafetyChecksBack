// ─── src/routes/checkins.ts ───────────────────────────────────────────────────
//
// PHASE 1 PAYWALL :
//   GET /history/:userId est désormais limité PAR PLAN (enforcement serveur) :
//     FREE  → 7 jours  (PLAN_LIMITS.FREE.historyDays)
//     BASIC → 365 jours (PLAN_LIMITS.BASIC.historyDays)
//   La réponse passe d'un tableau brut à { plan, historyDays, events } pour
//   que le frontend affiche le bandeau "Passez à Basic pour 12 mois".

import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { db } from "../db/client.js";
import { handleUserResponse } from "../jobs/checkin-scheduler.js";
import { checkInResponseSchema } from "../validators/schemas.js";
import { PLAN_LIMITS, resolveUserPlan } from "../services/plan.js";

export const checkInRouter = Router();

// POST /checkins/respond
checkInRouter.post("/respond", async (req: Request, res: Response) => {
  try {
    const parsed = checkInResponseSchema.parse(req.body);
    const { userId, checkInId, response, source } = parsed;

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

// GET /checkins/history/:userId — fenêtre limitée par le plan
checkInRouter.get("/history/:userId", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);

    if (!/^c[a-z0-9]{24,}$/.test(userId)) {
      return res.status(400).json({ error: "Invalid userId format" });
    }

    const plan = await resolveUserPlan(userId);
    const { historyDays, historyMaxRows } = PLAN_LIMITS[plan];

    const since = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);

    const events = await db.checkInEvent.findMany({
      where: { userId, sentAt: { gte: since } },
      orderBy: { sentAt: "desc" },
      take: historyMaxRows,
    });

    return res.json({ plan, historyDays, events });
  } catch (err) {
    console.error("GET /checkins/history/:userId error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});