import { Router } from "express";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { db } from "../db/client.js";
import {
  registerUserSchema,
  updateFcmTokenSchema,
  updateLocationSchema,
  updateEmergencyContactSchema,
} from "../validators/schemas.js";

const router = Router();

// POST /users/register
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
    } = parsed;

    const user = await db.user.upsert({
      where: { phoneNumber },
      update: {
        firstName,
        address,
        city,
        country,
        zipCode,
      },
      create: {
        phoneNumber,
        firstName,
        address,
        city,
        country,
        zipCode,
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

    return res.status(201).json({ userId: user.id });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid registration data",
        details: err.flatten(),
      });
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

    const user = await db.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const emergencyContact = await db.emergencyContact.upsert({
      where: { userId },
      update: {
        name,
        phoneNumber,
        relationship: relationship || null,
      },
      create: {
        userId,
        name,
        phoneNumber,
        relationship: relationship || null,
      },
    });

    return res.json({
      ok: true,
      emergencyContact,
    });
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

    await db.user.update({
      where: { id: userId },
      data: { fcmToken: token },
    });

    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid token payload",
        details: err.flatten(),
      });
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
      return res.status(400).json({
        error: "Invalid location payload",
        details: err.flatten(),
      });
    }

    console.error("PATCH /users/location error:", err);
    return res.status(500).json({ error: "Location update failed" });
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

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json(user);
  } catch (err) {
    console.error("GET /users/:id error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

export default router;
