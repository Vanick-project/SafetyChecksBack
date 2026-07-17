// ─── src/routes/alerts.ts ────────────────────────────────────────────────────
//
// PHASE 1 CASCADE :
//   - /trigger : vérifie qu'AU MOINS UN contact ACTIVÉ existe (multi-contacts).
//     Le job "sendEmergencyAlert" ne transporte plus emergencyContactId /
//     emergencyPhone — la cascade résout les contacts depuis la DB.
//   - /resolve : inchangé (le webhook + la cascade vérifient le statut en DB).

import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { db } from "../db/client.js";
import {
  resolveAlertSchema,
  triggerAlertSchema,
} from "../validators/schemas.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { scheduleCheckIn } from "../jobs/checkin-scheduler.js";

export const alertRouter = Router();

function getUserIdFromHeader(req: Request): string | undefined {
  const userIdHeader = req.headers["x-user-id"];
  if (typeof userIdHeader === "string") return userIdHeader;
  if (Array.isArray(userIdHeader)) return userIdHeader[0];
  return undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// POST /alerts/resolve
alertRouter.post("/resolve", async (req: Request, res: Response) => {
  try {
    const parsed = resolveAlertSchema.parse(req.body);
    const { alertId } = parsed;

    const existingAlert = await db.alertEvent.findUnique({
      where: { id: alertId },
    });

    if (!existingAlert) {
      return res.status(404).json({ error: "Alert not found" });
    }

    // 1. Résout l'alerte en DB EN PREMIER — cascade et webhooks vérifient ce statut
    await db.alertEvent.update({
      where: { id: alertId },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        actions: {
          create: {
            actionType: "USER_RESOLVED",
            destination: "self",
            outcome: "completed",
            executedAt: new Date(),
          },
        },
      },
    });

    // 2. Annule tous les jobs BullMQ liés à cette alerte
    try {
      const jobs = await alertQueue.getJobs(["delayed", "waiting", "active"]);

      const alertJobs = jobs.filter(
        (j) =>
          j.data?.alertId === alertId &&
          ["sendEmergencyAlert", "retryEmergencyCall"].includes(j.name),
      );

      await Promise.all(alertJobs.map((j) => j.remove()));

      console.log(
        `🛑 Cancelled ${alertJobs.length} BullMQ job(s) for alert ${alertId}`,
      );
    } catch (cancelErr) {
      // Non-bloquant — la vérification de statut dans la cascade prend le relais
      console.warn(
        `⚠️ Could not cancel BullMQ jobs for alert ${alertId}:`,
        cancelErr,
      );
    }

    // 3. Reset user state
    await db.user.update({
      where: { id: existingAlert.userId },
      data: {
        lastCheckInAt: new Date(),
        status: "ACTIVE",
      },
    });

    // 4. Relance le cycle de check-in
    await scheduleCheckIn(existingAlert.userId);

    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid resolve payload",
        details: err.flatten(),
      });
    }
    console.error("POST /alerts/resolve error:", err);
    return res.status(500).json({ error: "Resolve failed" });
  }
});

// POST /alerts/trigger
alertRouter.post("/trigger", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);

    if (!userId) {
      return res.status(400).json({ error: "Missing userId header" });
    }

    const parsed = triggerAlertSchema.parse(req.body);

    const latitude = toOptionalNumber(parsed.latitude);
    const longitude = toOptionalNumber(parsed.longitude);

    // CASCADE : il faut AU MOINS UN contact ACTIVÉ
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        emergencyContacts: {
          where: { enabled: true },
          orderBy: { priority: "asc" },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.emergencyContacts.length === 0) {
      return res.status(400).json({ error: "No enabled emergency contact found" });
    }

    const existingActiveAlert = await db.alertEvent.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "FAILED"] },
      },
      orderBy: { triggeredAt: "desc" },
    });

    if (existingActiveAlert) {
      return res.status(200).json({
        ok: true,
        alertId: existingActiveAlert.id,
        smsStatus: "already_active",
        callStatus: "already_active",
        queueStatus: "already_active",
        usedLocation:
          existingActiveAlert.latAtTrigger != null &&
          existingActiveAlert.lngAtTrigger != null,
        latitude: existingActiveAlert.latAtTrigger,
        longitude: existingActiveAlert.lngAtTrigger,
        message: "An active SOS alert already exists for this user.",
      });
    }

    const finalLatitude =
      latitude !== undefined
        ? latitude
        : user.lastLat !== null && user.lastLat !== undefined
          ? user.lastLat
          : undefined;

    const finalLongitude =
      longitude !== undefined
        ? longitude
        : user.lastLng !== null && user.lastLng !== undefined
          ? user.lastLng
          : undefined;

    const alert = await db.alertEvent.create({
      data: {
        userId,
        triggerReason: "USER_PRESSED_SOS",
        triggeredAt: new Date(),
        status: "ACTIVE",
        ...(finalLatitude !== undefined && { latAtTrigger: finalLatitude }),
        ...(finalLongitude !== undefined && { lngAtTrigger: finalLongitude }),
      },
    });

    if (finalLatitude != null && finalLongitude != null) {
      await db.user.update({
        where: { id: userId },
        data: {
          lastLat: finalLatitude,
          lastLng: finalLongitude,
        },
      });
    }

    try {
      await db.alertAction.create({
        data: {
          alertId: alert.id,
          actionType: "PUSH",
          destination: "system",
          outcome: "queued_for_processing",
          executedAt: new Date(),
        },
      });

      // CASCADE : le job ne transporte que alertId + userId —
      // startCascade résout les contacts depuis la DB (état toujours frais)
      await alertQueue.add(
        "sendEmergencyAlert",
        { alertId: alert.id, userId },
        {
          attempts: 1,
          removeOnComplete: 50,
          removeOnFail: 100,
        },
      );
    } catch (queueError) {
      console.error("alertQueue.add error:", queueError);

      await db.alertEvent.update({
        where: { id: alert.id },
        data: { status: "FAILED" },
      });

      await db.alertAction.create({
        data: {
          alertId: alert.id,
          actionType: "PUSH",
          destination: "system",
          outcome: "queue_failed",
          executedAt: new Date(),
        },
      });

      return res.status(500).json({
        ok: false,
        alertId: alert.id,
        smsStatus: "not_sent",
        callStatus: "not_called",
        queueStatus: "failed",
        usedLocation:
          finalLatitude !== undefined && finalLongitude !== undefined,
        latitude: finalLatitude ?? null,
        longitude: finalLongitude ?? null,
        message: "SOS alert created, but queueing failed.",
      });
    }

    return res.status(201).json({
      ok: true,
      alertId: alert.id,
      smsStatus: "queued",
      callStatus: "queued",
      queueStatus: "queued",
      usedLocation: finalLatitude !== undefined && finalLongitude !== undefined,
      latitude: finalLatitude ?? null,
      longitude: finalLongitude ?? null,
      message: "SOS alert created and queued successfully.",
    });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid trigger payload",
        details: err.flatten(),
      });
    }

    console.error("POST /alerts/trigger error:", err);
    return res.status(500).json({ error: "Trigger failed" });
  }
});

// GET /alerts/active/:userId
alertRouter.get("/active/:userId", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);

    const alert = await db.alertEvent.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "FAILED"] },
      },
      include: {
        actions: {
          orderBy: { executedAt: "desc" },
        },
      },
      orderBy: { triggeredAt: "desc" },
    });

    return res.json(alert ?? null);
  } catch (err) {
    console.error("GET /alerts/active/:userId error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// GET /alerts/history/:userId
alertRouter.get("/history/:userId", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId);

    const alerts = await db.alertEvent.findMany({
      where: { userId },
      include: {
        actions: {
          orderBy: { executedAt: "desc" },
        },
      },
      orderBy: { triggeredAt: "desc" },
      take: 20,
    });

    return res.json(alerts);
  } catch (err) {
    console.error("GET /alerts/history/:userId error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});