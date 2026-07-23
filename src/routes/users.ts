// ─── src/routes/users.ts ─────────────────────────────────────────────────────
//
// PHASE 1 MULTI-CONTACTS + PALIERS FREE/BASIC :
//   - /register : le contact d'onboarding devient le contact PRIORITÉ 1.
//     NOUVEAU : /register accepte désormais le SCHEDULE COMPLET (interval /
//     weekly / monthly). C'est la SEULE occasion pour un FREE de personnaliser
//     son check-in — après l'inscription, toute modification exige Basic.
//     (Le frontend n'a donc plus besoin d'enchaîner un PATCH /schedule.)
//   - PATCH /schedule et PATCH /checkin-interval : BLOQUÉS pour les FREE
//     (code PLAN_REQUIRED_SCHEDULE). BASIC peut modifier à tout moment.
//   - PATCH /email : NOUVEAU — ancre d'identité posée au moment de l'achat Basic.
//   - GET /users/:id : renvoie emergencyContacts[] + emergencyContact (legacy).
//   - DELETE /users/:id : NOUVEAU — suppression complète (RGPD + Play Store).

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
import { scheduleCheckIn, checkInQueue } from "../jobs/checkin-scheduler.js";
import { alertQueue } from "../jobs/alertQueue.js";
import { canCustomizeSchedule, DEFAULT_CHECKIN_HOURS } from "../services/plan.js";

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
  timezone: z.string().optional(),
  recurring: z.boolean().optional(),
});

// Schéma optionnel du schedule embarqué dans /register (choix d'onboarding).
// Tous les champs sont optionnels : une app qui n'envoie qu'un intervalle simple
// continue de fonctionner. Absent → check-in 24h par défaut.
const registerScheduleSchema = z
  .object({
    scheduleType: z.enum(["interval", "weekly", "monthly"]).optional(),
    scheduleIntervalHours: z.number().int().min(0).max(168).optional(),
    scheduleIntervalMinutes: z.number().int().min(0).max(59).optional(),
    scheduleDayOfWeek: z.number().int().min(0).max(6).optional(),
    scheduleDayOfMonth: z.number().int().min(1).max(31).optional(),
    scheduleTimeHour: z.number().int().min(0).max(23).optional(),
    scheduleTimeMinute: z.number().int().min(0).max(59).optional(),
  })
  .optional();

// ─── Helper : upsert du contact PRIORITÉ 1 ───────────────────────────────────

async function upsertPrimaryContact(
  userId: string,
  data: { name: string; phoneNumber: string; relationship?: string | null | undefined },
) {
  return db.emergencyContact.upsert({
    where: { userId_priority: { userId, priority: 1 } },
    update: {
      name: data.name,
      phoneNumber: data.phoneNumber,
      relationship: data.relationship ?? null,
    },
    create: {
      userId,
      priority: 1,
      enabled: true,
      name: data.name,
      phoneNumber: data.phoneNumber,
      relationship: data.relationship ?? null,
    },
  });
}

// ─── Helper : construit le bloc schedule depuis le choix d'onboarding ────────
// Un FREE règle son check-in ICI, une fois. On persiste exactement son choix
// (interval / weekly / monthly). Absent → interval 24h.
function buildOnboardingSchedule(input: {
  checkInIntervalHours?: number | undefined;
  schedule?: z.infer<typeof registerScheduleSchema> | undefined;
  timezone?: string | undefined;
  recurring?: boolean | undefined;
}) {
  const s = input.schedule ?? {};
  const type = s.scheduleType ?? "interval";

  // Intervalle : priorité au schedule avancé, sinon au champ legacy, sinon 24h.
  const intervalHours =
    s.scheduleIntervalHours ?? input.checkInIntervalHours ?? DEFAULT_CHECKIN_HOURS;

  return {
    scheduleType: type,
    checkInIntervalHours: intervalHours,
    scheduleIntervalHours: intervalHours,
    scheduleIntervalMinutes: s.scheduleIntervalMinutes ?? 0,
    // Champs weekly/monthly : posés seulement s'ils sont fournis
    ...(s.scheduleDayOfWeek !== undefined && { scheduleDayOfWeek: s.scheduleDayOfWeek }),
    ...(s.scheduleDayOfMonth !== undefined && { scheduleDayOfMonth: s.scheduleDayOfMonth }),
    ...(s.scheduleTimeHour !== undefined && { scheduleTimeHour: s.scheduleTimeHour }),
    ...(s.scheduleTimeMinute !== undefined && { scheduleTimeMinute: s.scheduleTimeMinute }),
    lastCheckInAt: new Date(),
    checkInActive: true,
    recurring: input.recurring ?? true,
    ...(input.timezone && { timezone: input.timezone }),
  };
}

// POST /users/register
router.post("/register", async (req: Request, res: Response) => {
  try {
    const parsed = registerUserSchema.parse(req.body);
    const {
      phoneNumber, firstName, address, city, country, zipCode, province,
      emergencyContact, checkInIntervalHours, language, timezone, recurring,
    } = parsed;

    // Le schedule avancé éventuel est validé à part (il peut ne pas exister
    // dans le schéma de register selon la version de l'app).
    const schedule = registerScheduleSchema.parse((req.body as any).schedule);

    // FREE règle son check-in à l'inscription. On grave son choix complet.
    const onboardingSchedule = buildOnboardingSchedule({
      checkInIntervalHours,
      schedule,
      timezone,
      recurring,
    });

    const user = await db.user.upsert({
      where: { phoneNumber },
      update: {
        firstName, address, city, country, zipCode,
        province: province ?? "", language,
        ...onboardingSchedule,
      },
      create: {
        phoneNumber, firstName, address, city, country, zipCode,
        province: province ?? "", language,
        ...onboardingSchedule,
      },
    });

    // Le contact d'onboarding = contact priorité 1 de la cascade
    await upsertPrimaryContact(user.id, emergencyContact);

    await scheduleCheckIn(user.id);
    return res.status(201).json({
      userId: user.id,
      checkInIntervalHours: onboardingSchedule.checkInIntervalHours,
    });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid registration data", details: err.flatten() });
    console.error("POST /users/register error:", err);
    return res.status(500).json({ error: "Registration failed" });
  }
});

// PATCH /users/emergency-contact — LEGACY (app actuelle des testeurs)
router.patch("/emergency-contact", async (req: Request, res: Response) => {
  try {
    const parsed = updateEmergencyContactSchema.parse(req.body);
    const { userId, name, phoneNumber, relationship } = parsed;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const emergencyContact = await upsertPrimaryContact(userId, {
      name,
      phoneNumber,
      relationship: relationship || null,
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

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      console.warn(`⚠️ PATCH /users/fcm-token : userId ${userId} not found (stale client)`);
      return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

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

// PATCH /users/checkin-interval (legacy) — MODIFICATION = Basic uniquement
router.patch("/checkin-interval", async (req: Request, res: Response) => {
  try {
    const parsed = updateCheckInIntervalSchema.parse(req.body);
    const { userId, intervalHours, timezone, recurring } = parsed as {
      userId: string; intervalHours: number; timezone?: string; recurring?: boolean;
    };
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // GARDE PLAN : modifier le check-in après l'inscription exige Basic.
    if (!(await canCustomizeSchedule(userId))) {
      return res.status(403).json({
        error: "Schedule customization requires a Basic subscription",
        code: "PLAN_REQUIRED_SCHEDULE",
      });
    }

    await db.user.update({
      where: { id: userId },
      data: {
        checkInIntervalHours: intervalHours,
        scheduleType: "interval",
        scheduleIntervalHours: intervalHours,
        scheduleIntervalMinutes: 0,
        lastCheckInAt: new Date(),
        checkInActive: true,
        ...(timezone && { timezone }),
        ...(recurring !== undefined && { recurring }),
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

// PATCH /users/schedule — schedule avancé — MODIFICATION = Basic uniquement
router.patch("/schedule", async (req: Request, res: Response) => {
  try {
    const parsed = updateScheduleSchema.parse(req.body);
    const { userId, scheduleType, timezone, recurring, ...scheduleFields } = parsed;

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // GARDE PLAN : modifier le check-in après l'inscription exige Basic.
    if (!(await canCustomizeSchedule(userId))) {
      return res.status(403).json({
        error: "Schedule customization requires a Basic subscription",
        code: "PLAN_REQUIRED_SCHEDULE",
      });
    }

    await db.user.update({
      where: { id: userId },
      data: {
        scheduleType,
        ...(scheduleFields.scheduleIntervalHours !== undefined && {
          scheduleIntervalHours: scheduleFields.scheduleIntervalHours,
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
        ...(timezone && { timezone }),
        ...(recurring !== undefined && { recurring }),
        checkInActive: true,
        lastCheckInAt: new Date(),
      },
    });

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

// PATCH /users/email — ancre d'identité posée au moment de l'achat Basic.
// Stocké en minuscules, unique par utilisateur (index partiel côté DB).
const setEmailSchema = z.object({
  userId: z.string().trim().min(10).max(100),
  email: z.string().trim().email().max(200),
});

router.patch("/email", async (req: Request, res: Response) => {
  try {
    const { userId, email } = setEmailSchema.parse(req.body);
    const normalized = email.toLowerCase();

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Email déjà rattaché à un AUTRE compte → conflit (évite le vol d'ancre)
    const existing = await db.user.findFirst({
      where: { email: normalized, id: { not: userId } },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({
        error: "Email already in use",
        code: "EMAIL_IN_USE",
      });
    }

    await db.user.update({ where: { id: userId }, data: { email: normalized } });
    console.log(`📧 Email set for user ${userId}`);
    return res.json({ ok: true, email: normalized });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid email payload", details: err.flatten() });
    console.error("PATCH /users/email error:", err);
    return res.status(500).json({ error: "Email update failed" });
  }
});

// PATCH /users/recurring — toggle isolé du flag "récurrent"
// Accessible en FREE et BASIC (contrairement à /schedule qui exige Basic).
// Ta règle : un FREE peut basculer ON/OFF sur son check-in choisi à l'inscription,
// mais ne peut PAS changer les valeurs (intervalle, jour, heure).
const setRecurringSchema = z.object({
  userId: z.string().trim().min(10).max(100),
  recurring: z.boolean(),
});

router.patch("/recurring", async (req: Request, res: Response) => {
  try {
    const { userId, recurring } = setRecurringSchema.parse(req.body);

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Toggle ON : on remet le compteur À MAINTENANT (le prochain check-in
    // part depuis l'instant du toggle, pas depuis le dernier check-in qui
    // peut dater d'il y a longtemps).
    // Toggle OFF : scheduleCheckIn (via son garde recurring:false) va nettoyer.
    await db.user.update({
      where: { id: userId },
      data: {
        recurring,
        checkInActive: recurring,
        ...(recurring && { lastCheckInAt: new Date() }),
      },
    });

    // ORDRE CRITIQUE : mettre à jour la DB AVANT scheduleCheckIn,
    // sinon son garde interne (recurring:false → skip) bloque à tort.
    await scheduleCheckIn(userId);

    console.log(
      `🔁 Recurring ${recurring ? "ENABLED" : "DISABLED"} for user ${userId}`,
    );
    return res.json({ ok: true, recurring });
  } catch (err: any) {
    if (err instanceof ZodError)
      return res.status(400).json({
        error: "Invalid recurring payload",
        details: err.flatten(),
      });
    console.error("PATCH /users/recurring error:", err);
    return res.status(500).json({ error: "Recurring update failed" });
  }
});


// PATCH /users/language
router.patch("/language", async (req: Request, res: Response) => {
  try {
    const { userId, language } = req.body as { userId: string; language: string };
    if (!userId || !["fr", "en"].includes(language))
      return res.status(400).json({ error: "Invalid payload" });

    // Vérifier que l'user existe AVANT le update (évite le P2025 en log)
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

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
      include: {
        emergencyContacts: { orderBy: { priority: "asc" } },
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    // COMPATIBILITÉ : l'app actuelle des testeurs lit data.emergencyContact
    // (singulier). On expose le contact priorité 1 sous ce nom.
    const primary = user.emergencyContacts[0] ?? null;

    return res.json({ ...user, emergencyContact: primary });
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

// ─── DELETE /users/:id ───────────────────────────────────────────────────────
// Suppression complète du compte (conformité RGPD + Play Store Data Deletion 2023).
//
// Cascade AUTOMATIQUE (schema.prisma `onDelete: Cascade`) :
//   User → EmergencyContact, CheckInEvent, AlertEvent → AlertAction
//
// Suppression MANUELLE (userId nullable sans relation Prisma) :
//   SupportMessage, SubscriptionEvent
//
// Sécurité : le header x-user-id doit correspondre à l'id de l'URL
// (anti-usurpation minimale — même pattern que DELETE /contacts/:id).
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.id);
    const headerUserId = Array.isArray(req.headers["x-user-id"])
      ? req.headers["x-user-id"][0]
      : req.headers["x-user-id"];

    if (!headerUserId || headerUserId !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // 1) Purge BullMQ (sinon les workers crashent sur un user inexistant
    //    quelques minutes plus tard). checkInQueue peut être null si
    //    REDIS_URL n'est pas défini (garde défensive).
    try {
      const jobLists = await Promise.all([
        checkInQueue
          ? checkInQueue.getJobs(["delayed", "waiting", "active"])
          : Promise.resolve([]),
        alertQueue.getJobs(["delayed", "waiting", "active"]),
      ]);
      const [checkInJobs, alertJobs] = jobLists;

      await Promise.all([
        ...checkInJobs
          .filter((j) => j?.data?.userId === userId)
          .map((j) => j?.remove().catch(() => {})),
        ...alertJobs
          .filter((j) => j?.data?.userId === userId)
          .map((j) => j?.remove().catch(() => {})),
      ]);
    } catch (queueErr) {
      // Non bloquant : on log mais on continue la suppression DB
      console.warn(`⚠️ Failed to purge BullMQ jobs for ${userId}:`, queueErr);
    }

    // 2) Suppression DB (transaction atomique — soit tout part, soit rien)
    await db.$transaction([
      db.supportMessage.deleteMany({ where: { userId } }),
      db.subscriptionEvent.deleteMany({ where: { userId } }),
      db.user.delete({ where: { id: userId } }),
    ]);

    console.log(
      `🗑️ Account deleted for user ${userId} (${user.phoneNumber})`,
    );
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("DELETE /users/:id error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

export default router;