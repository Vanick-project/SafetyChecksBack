// ─── src/routes/users.ts ─────────────────────────────────────────────────────
//
// AJOUT : PATCH /users/schedule — sauvegarde la config de schedule avancé.

import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  registerUserSchema,
  updateFcmTokenSchema,
  updateLocationSchema,
  updateEmergencyContactSchema,
  updateCheckInIntervalSchema,
  updateAlertSettingsSchema,
  updateNotificationsSettingsSchema,
} from "../validators/schemas.js";
import { scheduleCheckIn } from "../jobs/checkin-scheduler.js";

const router = Router();

// ─── Schéma schedule avancé ──────────────────────────────────────────────────

const updateScheduleSchema = z.object({
  userId: z.string().trim().min(10).max(100),
  scheduleType: z.enum(["interval", "weekly", "monthly"]),
  scheduleIntervalHours: z.number().int().min(0).max(168).optional(),
  scheduleIntervalMinutes: z.number().int().min(0).max(59).optional(),
  scheduleDayOfWeek: z.number().int().min(0).max(6).optional(),
  scheduleDayOfMonth: z.number().int().min(1).max(31).optional(),
  scheduleTimeHour: z.number().int().min(0).max(23).optional(),
  scheduleTimeMinute: z.number().int().min(0).max(59).optional(),
});

// POST /users/register
router.post("/register", async (req: Request, res: Response) => {
  try {
    const parsed = registerUserSchema.parse(req.body);
    const {
      phoneNumber, firstName, address, city, country, zipCode,
      emergencyContact, checkInIntervalHours, language,
    } = parsed;

    const user = await db.user.upsert({
      where: { phoneNumber },
      update: { firstName, address, city, country, zipCode, checkInIntervalHours, language },
      create: { phoneNumber, firstName, address, city, country, zipCode, checkInIntervalHours, language },
    });

    await db.emergencyContact.upsert({
      where: { userId: user.id },
      update: {
        name: emergencyContact.name,
        phoneNumber: emergencyContact.phoneNumber,
        relationship: emergencyContact.relationship ?? null,
      },
      create: {
        userId: user.id,
        name: emergencyContact.name,
        phoneNumber: emergencyContact.phoneNumber,
        relationship: emergencyContact.relationship ?? null,
      },
    });

    await scheduleCheckIn(user.id);
    return res.status(201).json({ userId: user.id, checkInIntervalHours });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid registration data", details: err.flatten() });
    console.error("POST /users/register error:", err);
    return res.status(500).json({ error: "Registration failed" });
  }
});

// PATCH /users/emergency-contact
router.patch("/emergency-contact", async (req: Request, res: Response) => {
  try {
    const parsed = updateEmergencyContactSchema.parse(req.body);
    const { userId, name, phoneNumber, relationship } = parsed;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    const emergencyContact = await db.emergencyContact.upsert({
      where: { userId },
      update: { name, phoneNumber, relationship: relationship || null },
      create: { userId, name, phoneNumber, relationship: relationship || null },
    });
    return res.json({ ok: true, emergencyContact });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid payload", details: err.flatten() });
    console.error("PATCH /users/emergency-contact error:", err);
    return res.status(500).json({ error: "Update failed" });
  }
});

// PATCH /users/fcm-token
router.patch("/fcm-token", async (req: Request, res: Response) => {
  try {
    const parsed = updateFcmTokenSchema.parse(req.body);
    const { userId, token } = parsed;
    await db.user.update({ where: { id: userId }, data: { fcmToken: token } });
    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid payload", details: err.flatten() });
    console.error("PATCH /users/fcm-token error:", err);
    return res.status(500).json({ error: "Token update failed" });
  }
});

// PATCH /users/location
router.patch("/location", async (req: Request, res: Response) => {
  try {
    const parsed = updateLocationSchema.parse(req.body);
    const { userId, lat, lng } = parsed;
    await db.user.update({ where: { id: userId }, data: { lastLat: lat, lastLng: lng } });
    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid payload", details: err.flatten() });
    console.error("PATCH /users/location error:", err);
    return res.status(500).json({ error: "Location update failed" });
  }
});

// PATCH /users/checkin-interval (legacy — conservé pour compatibilité)
router.patch("/checkin-interval", async (req: Request, res: Response) => {
  try {
    const parsed = updateCheckInIntervalSchema.parse(req.body);
    const { userId, intervalHours } = parsed;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    await db.user.update({
      where: { id: userId },
      data: {
        checkInIntervalHours: intervalHours,
        scheduleType: "interval",
        scheduleIntervalHours: intervalHours,
        scheduleIntervalMinutes: 0,
        lastCheckInAt: new Date(),
      },
    });
    await scheduleCheckIn(userId);
    return res.json({ ok: true, intervalHours });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid payload", details: err.flatten() });
    console.error("PATCH /users/checkin-interval error:", err);
    return res.status(500).json({ error: "Interval update failed" });
  }
});

// PATCH /users/schedule — NOUVEAU endpoint pour le schedule avancé
router.patch("/schedule", async (req: Request, res: Response) => {
  try {
    const parsed = updateScheduleSchema.parse(req.body);
    const { userId, scheduleType, ...scheduleFields } = parsed;

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    await db.user.update({
      where: { id: userId },
      data: {
        scheduleType,
        ...(scheduleFields.scheduleIntervalHours !== undefined && {
          scheduleIntervalHours: scheduleFields.scheduleIntervalHours,
          // Met aussi à jour checkInIntervalHours (legacy countdown)
          checkInIntervalHours: scheduleFields.scheduleIntervalHours,
        }),
        ...(scheduleFields.scheduleIntervalMinutes !== undefined && {
          scheduleIntervalMinutes: scheduleFields.scheduleIntervalMinutes,
        }),
        ...(scheduleFields.scheduleDayOfWeek !== undefined && {
          scheduleDayOfWeek: scheduleFields.scheduleDayOfWeek,
        }),
        ...(scheduleFields.scheduleDayOfMonth !== undefined && {
          scheduleDayOfMonth: scheduleFields.scheduleDayOfMonth,
        }),
        ...(scheduleFields.scheduleTimeHour !== undefined && {
          scheduleTimeHour: scheduleFields.scheduleTimeHour,
        }),
        ...(scheduleFields.scheduleTimeMinute !== undefined && {
          scheduleTimeMinute: scheduleFields.scheduleTimeMinute,
        }),
        lastCheckInAt: new Date(),
      },
    });

    // Reprogramme le job BullMQ avec le nouveau schedule
    await scheduleCheckIn(userId);

    console.log(`📅 Schedule updated to '${scheduleType}' for user ${userId}`);
    return res.json({ ok: true, scheduleType });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid schedule payload", details: err.flatten() });
    console.error("PATCH /users/schedule error:", err);
    return res.status(500).json({ error: "Schedule update failed" });
  }
});

// PATCH /users/language
router.patch("/language", async (req: Request, res: Response) => {
  try {
    const { userId, language } = req.body as { userId: string; language: string };
    if (!userId || !["fr", "en"].includes(language))
      return res.status(400).json({ error: "Invalid payload" });
    await db.user.update({ where: { id: userId }, data: { language } });
    return res.json({ ok: true, language });
  } catch (err) {
    console.error("PATCH /users/language error:", err);
    return res.status(500).json({ error: "Language update failed" });
  }
});

// GET /users/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.id);
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { emergencyContact: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (err) {
    console.error("GET /users/:id error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// PATCH /users/alert-settings
router.patch("/alert-settings", async (req: Request, res: Response) => {
  try {
    const parsed = updateAlertSettingsSchema.parse(req.body);
    const { userId, alertChannel, alertSystemEnabled } = parsed;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    await db.user.update({
      where: { id: userId },
      data: {
        ...(alertChannel !== undefined && { alertChannel }),
        ...(alertSystemEnabled !== undefined && { alertSystemEnabled }),
      },
    });
    return res.json({ ok: true, alertChannel, alertSystemEnabled });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid payload", details: err.flatten() });
    console.error("PATCH /users/alert-settings error:", err);
    return res.status(500).json({ error: "Alert settings update failed" });
  }
});

// PATCH /users/notifications-settings
router.patch("/notifications-settings", async (req: Request, res: Response) => {
  try {
    const parsed = updateNotificationsSettingsSchema.parse(req.body);
    const { userId, notificationsEnabled } = parsed;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    await db.user.update({ where: { id: userId }, data: { notificationsEnabled } });
    await scheduleCheckIn(userId);
    console.log(`🔔 Notifications ${notificationsEnabled ? "enabled" : "disabled"} for ${userId}`);
    return res.json({ ok: true, notificationsEnabled });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid payload", details: err.flatten() });
    console.error("PATCH /users/notifications-settings error:", err);
    return res.status(500).json({ error: "Notifications update failed" });
  }
});

export default router;
