// ─── src/validators/schemas.ts ───────────────────────────────────────────────

import { z } from "zod";

const e164Phone = z
  .string()
  .trim()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "Phone number must be in E.164 format (e.g. +14389279231)",
  );

const cuid = z
  .string()
  .trim()
  .regex(/^c[a-z0-9]{24,}$/, "Invalid ID format");

const checkInIdField = z
  .string()
  .trim()
  .min(1, "checkInId is required")
  .max(64, "checkInId too long");

export const emergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phoneNumber: e164Phone,
  relationship: z.string().trim().max(50).optional().or(z.literal("")),
});

export const registerUserSchema = z.object({
  phoneNumber: e164Phone,
  firstName: z.string().trim().min(1).max(50),
  address: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().max(100).optional().default(""),
  country: z.string().trim().max(100).optional().default(""),
  zipCode: z.string().trim().max(20).optional().default(""),
  emergencyContact: emergencyContactSchema,
});

export const updateEmergencyContactSchema = z.object({
  userId: cuid,
  name: z.string().trim().min(1).max(100),
  phoneNumber: e164Phone,
  relationship: z.string().trim().max(50).optional().default(""),
});

export const resolveAlertSchema = z.object({
  alertId: cuid,
});

export const triggerAlertSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const updateLocationSchema = z.object({
  userId: cuid,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const updateFcmTokenSchema = z.object({
  userId: cuid,
  token: z.string().trim().min(100).max(300),
});

export const checkInResponseSchema = z.object({
  userId: cuid,
  checkInId: checkInIdField,
  response: z.enum(["OK", "SOS"], {
    error: "response must be OK or SOS",
  }),
  source: z.enum(["scheduled", "manual"]).optional(),
});

// NOUVEAU — intervalle de check-in configurable par l'utilisateur.
// Valeurs autorisées en heures : 1, 2, 4, 8, 12, 24.
export const updateCheckInIntervalSchema = z.object({
  userId: cuid,
  intervalHours: z
    .enum(["1", "2", "4", "8", "12", "24"], {
      error: "intervalHours must be one of: 1, 2, 4, 8, 12, 24",
    })
    .transform(Number),
});
