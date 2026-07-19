// ─── src/routes/checkins.ts ───────────────────────────────────────────────────
// SECURITY: Input validated via checkInResponseSchema (Zod).
//
// HISTORIQUE PAR PLAN (strict) :
//   FREE  → historyDays 0 → aucune donnée renvoyée (events: [], locked: true)
//   BASIC → historyDays 365 → 12 mois glissants
// La coupure est faite CÔTÉ SERVEUR : un FREE ne peut pas voir l'historique
// même en contournant l'app.

import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { db } from "../db/client.js";
import { handleUserResponse } from "../jobs/checkin-scheduler.js";
import { checkInResponseSchema } from "../validators/schemas.js";
import { resolveUserPlan, PLAN_LIMITS } from "../services/plan.js";

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

// GET /checkins/history/:userId — fenêtre limitée par le plan
checkInRouter.get("/history/:userId", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);

    if (!/^c[a-z0-9]{24,}$/.test(userId)) {
      return res.status(400).json({ error: "Invalid userId format" });
    }

    const plan = await resolveUserPlan(userId);
    const { historyDays, historyMaxRows } = PLAN_LIMITS[plan];

    // STRICT : l'historique est une fonctionnalité Basic. Un FREE ne reçoit
    // rien. `locked: true` permet à l'app d'afficher l'upsell au lieu d'une
    // liste vide ambiguë.
    if (historyDays === 0) {
      return res.json({ plan, historyDays: 0, events: [], locked: true });
    }

    const since = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);

    const events = await db.checkInEvent.findMany({
      where: { userId, sentAt: { gte: since } },
      orderBy: { sentAt: "desc" },
      take: historyMaxRows,
    });

    return res.json({ plan, historyDays, events, locked: false });
  } catch (err) {
    console.error("GET /checkins/history/:userId error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});