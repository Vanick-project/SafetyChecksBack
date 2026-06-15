// ─── src/routes/users.ts ─────────────────────────────────────────────────────

import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { db } from "../db/client.js";
import {
  registerUserSchema,
  updateFcmTokenSchema,
  updateLocationSchema,
  updateEmergencyContactSchema,
  updateCheckInIntervalSchema,
  updateAlertSettingsSchema,
} from "../validators/schemas.js";
import { scheduleCheckIn } from "../jobs/checkin-scheduler.js";

const router = Router();

// POST /users/register
// Inclut maintenant checkInIntervalHours choisi pendant l'onboarding
router.post("/register", async (req: Request, res: Response) => {
  try {
    const parsed = registerUserSchema.parse(req.body);
    const {
      phoneNumber,
      firstName,
      address,
      city,
      country,
      zipCode,
      emergencyContact,
      checkInIntervalHours,
      language,
    } = parsed;

    const user = await db.user.upsert({
      where: { phoneNumber },
      update: {
        firstName,
        address,
        city,
        country,
        zipCode,
        checkInIntervalHours,
        language,
      },
      create: {
        phoneNumber,
        firstName,
        address,
        city,
        country,
        zipCode,
        checkInIntervalHours,
        language,
      },
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
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid registration data", details: err.flatten() });
    }
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
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid emergency contact payload",
        details: err.flatten(),
      });
    }
    console.error("PATCH /users/emergency-contact error:", err);
    return res.status(500).json({ error: "Emergency contact update failed" });
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
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid token payload", details: err.flatten() });
    }
    console.error("PATCH /users/fcm-token error:", err);
    return res.status(500).json({ error: "Token update failed" });
  }
});

// PATCH /users/location
router.patch("/location", async (req: Request, res: Response) => {
  try {
    const parsed = updateLocationSchema.parse(req.body);
    const { userId, lat, lng } = parsed;

    await db.user.update({
      where: { id: userId },
      data: { lastLat: lat, lastLng: lng },
    });
    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid location payload", details: err.flatten() });
    }
    console.error("PATCH /users/location error:", err);
    return res.status(500).json({ error: "Location update failed" });
  }
});

// PATCH /users/checkin-interval
// FIX: le schema accepte maintenant string ET number → plus de 400
// Reprogramme le job BullMQ + réinitialise le timer (lastCheckInAt = now)
router.patch("/checkin-interval", async (req: Request, res: Response) => {
  try {
    const parsed = updateCheckInIntervalSchema.parse(req.body);
    const { userId, intervalHours } = parsed;

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Sauvegarde le nouvel intervalle ET réinitialise lastCheckInAt à maintenant
    // → le countdown repart de zéro avec le nouvel intervalle
    await db.user.update({
      where: { id: userId },
      data: {
        checkInIntervalHours: intervalHours,
        lastCheckInAt: new Date(), // réinitialise le timer visuellement
      },
    });

    // Reprogramme le job BullMQ avec le nouvel intervalle
    await scheduleCheckIn(userId);

    console.log(
      `⏰ Check-in interval updated to ${intervalHours}h for user ${userId} — timer reset`,
    );

    return res.json({
      ok: true,
      intervalHours,
      timerResetAt: new Date().toISOString(),
    });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid interval payload", details: err.flatten() });
    }
    console.error("PATCH /users/checkin-interval error:", err);
    return res.status(500).json({ error: "Interval update failed" });
  }
});

// PATCH /users/language
router.patch("/language", async (req: Request, res: Response) => {
  try {
    const { userId, language } = req.body as {
      userId: string;
      language: string;
    };

    if (!userId || !["fr", "en"].includes(language)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await db.user.update({
      where: { id: userId },
      data: { language },
    });

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
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid alert settings payload",
        details: err.flatten(),
      });
    }
    console.error("PATCH /users/alert-settings error:", err);
    return res.status(500).json({ error: "Alert settings update failed" });
  }
});

export default router;
