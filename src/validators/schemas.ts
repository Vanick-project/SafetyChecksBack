// ─── src/validators/schemas.ts ───────────────────────────────────────────────
// Zod schemas — single source of truth for all input validation.
//
// SECURITY additions vs previous version:
//   1. Phone numbers validated with E.164 regex — prevents malformed numbers
//      from being sent to Twilio (which would throw an unhandled error) and
//      blocks basic injection attempts in the phone field.
//   2. String fields have maxLength caps — prevents oversized payloads from
//      bloating the DB or crashing JSON parsing.
//   3. Names stripped of leading/trailing whitespace and capped — prevents
//      whitespace-only names passing min(1) checks.
//   4. Coordinates validated as finite numbers within real-world bounds —
//      prevents garbage GPS values from being stored and sent to Google Maps.
//   5. FCM tokens validated for expected length range.
//   6. userId fields validated as cuid format — prevents arbitrary strings
//      being passed as IDs (defence-in-depth on top of Prisma).
//   7. response field uses z.enum() instead of z.string() — only "OK" or
//      "SOS" are accepted at the schema level, not just checked in the handler.
//   8. source field added to checkInResponseSchema for explicit source tracking.
//
// NOTE: Zod validation does NOT replace parameterised queries (Prisma handles
// that). These schemas are the input-sanitisation layer — they stop bad data
// from ever reaching the DB layer.

import { z } from "zod";

// ─── SHARED PRIMITIVES ────────────────────────────────────────────────────────

/**
 * E.164 phone number format: +[country code][number], 8–15 digits total.
 * Examples: +14389279231, +33612345678
 * This is what Twilio requires — enforcing it here prevents runtime Twilio errors.
 */
const e164Phone = z
  .string()
  .trim()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "Phone number must be in E.164 format (e.g. +14389279231)",
  );

/**
 * CUID format used by Prisma @default(cuid()).
 * Blocks arbitrary strings from being used as record IDs.
 */
const cuid = z
  .string()
  .trim()
  .regex(/^c[a-z0-9]{24,}$/, "Invalid ID format");

/**
 * Accepts both "manual" / "manual-sos" (legacy clients) and real CUIDs.
 */
const checkInIdField = z
  .string()
  .trim()
  .min(1, "checkInId is required")
  .max(64, "checkInId too long");

// ─── EMERGENCY CONTACT ────────────────────────────────────────────────────────

export const emergencyContactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Emergency contact name is required")
    .max(100, "Name must be 100 characters or less"),
  phoneNumber: e164Phone,
  relationship: z
    .string()
    .trim()
    .max(50, "Relationship must be 50 characters or less")
    .optional()
    .or(z.literal("")),
});

// ─── USER REGISTRATION ────────────────────────────────────────────────────────

export const registerUserSchema = z.object({
  phoneNumber: e164Phone,
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(50, "First name must be 50 characters or less"),
  address: z
    .string()
    .trim()
    .max(200, "Address must be 200 characters or less")
    .optional()
    .default(""),
  city: z
    .string()
    .trim()
    .max(100, "City must be 100 characters or less")
    .optional()
    .default(""),
  country: z
    .string()
    .trim()
    .max(100, "Country must be 100 characters or less")
    .optional()
    .default(""),
  zipCode: z
    .string()
    .trim()
    .max(20, "Zip code must be 20 characters or less")
    .optional()
    .default(""),
  emergencyContact: emergencyContactSchema,
});

// ─── UPDATE EMERGENCY CONTACT ─────────────────────────────────────────────────

export const updateEmergencyContactSchema = z.object({
  userId: cuid,
  name: z
    .string()
    .trim()
    .min(1, "Emergency contact name is required")
    .max(100, "Name must be 100 characters or less"),
  phoneNumber: e164Phone,
  relationship: z
    .string()
    .trim()
    .max(50, "Relationship must be 50 characters or less")
    .optional()
    .default(""),
});

// ─── ALERT SCHEMAS ────────────────────────────────────────────────────────────

export const resolveAlertSchema = z.object({
  alertId: cuid,
});

export const triggerAlertSchema = z.object({
  latitude: z
    .number()
    .min(-90, "Latitude must be between -90 and 90")
    .max(90, "Latitude must be between -90 and 90")
    .optional(),
  longitude: z
    .number()
    .min(-180, "Longitude must be between -180 and 180")
    .max(180, "Longitude must be between -180 and 180")
    .optional(),
});

// ─── LOCATION ─────────────────────────────────────────────────────────────────

export const updateLocationSchema = z.object({
  userId: cuid,
  lat: z
    .number()
    .min(-90, "Latitude must be between -90 and 90")
    .max(90, "Latitude must be between -90 and 90"),
  lng: z
    .number()
    .min(-180, "Longitude must be between -180 and 180")
    .max(180, "Longitude must be between -180 and 180"),
});

// ─── FCM TOKEN ────────────────────────────────────────────────────────────────

export const updateFcmTokenSchema = z.object({
  userId: cuid,
  // FCM tokens are typically 140–200 characters.
  token: z
    .string()
    .trim()
    .min(100, "FCM token appears too short")
    .max(300, "FCM token appears too long"),
});

// ─── CHECK-IN RESPONSE ────────────────────────────────────────────────────────

export const checkInResponseSchema = z.object({
  userId: cuid,
  checkInId: checkInIdField,
  // Strict enum — only these two values are valid at the schema level.
  response: z.enum(["OK", "SOS"], {
    errorMap: () => ({ message: "response must be OK or SOS" }),
  }),
  // Explicit source: "scheduled" = response to a push notification,
  // "manual" = user-initiated from within the app.
  source: z.enum(["scheduled", "manual"]).optional(),
});
