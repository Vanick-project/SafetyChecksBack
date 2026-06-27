// ─── src/jobs/checkin-scheduler.ts ───────────────────────────────────────────
//
// AJOUT : support du scheduling avancé (interval libre, weekly, monthly).
// getNextCheckInDelayMs() calcule le délai exact selon le type de schedule.

import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { sendCheckInNotification } from "../services/fcm.js";
import { db } from "../db/client.js";
import { alertQueue } from "./alertQueue.js";
import { FIVE_MINUTES, MAX_REMINDERS } from "../config/constants.js";

let connection: Redis | null = null;

if (process.env.REDIS_URL) {
  connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on("connect", () => console.log("✅ check-in Redis connected"));
  connection.on("error", (err) => console.error("❌ check-in Redis error:", err.message));
} else {
  console.warn("⚠️ Redis disabled — check-in queue unavailable");
}

export const checkInQueue: Queue | null = connection
  ? new Queue("check-in", { connection })
  : null;

// ─── CALCUL DU DÉLAI ─────────────────────────────────────────────────────────
//
// Lit le scheduleType et les champs associés depuis la DB.
// Retourne le nombre de millisecondes jusqu'au prochain check-in.

async function getNextCheckInDelayMs(userId: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      scheduleType: true,
      scheduleIntervalHours: true,
      scheduleIntervalMinutes: true,
      scheduleDayOfWeek: true,
      scheduleDayOfMonth: true,
      scheduleTimeHour: true,
      scheduleTimeMinute: true,
      checkInIntervalHours: true,   // fallback legacy
    },
  });

  const type = (user as any)?.scheduleType ?? "interval";

  // ── INTERVAL ────────────────────────────────────────────────────────────
  if (type === "interval") {
    const hours = (user as any)?.scheduleIntervalHours ?? user?.checkInIntervalHours ?? 24;
    const minutes = (user as any)?.scheduleIntervalMinutes ?? 0;
    const totalMs = (hours * 60 + minutes) * 60 * 1000;
    return Math.max(totalMs, 60_000); // minimum 1 minute
  }

  const now = new Date();
  const timeHour = (user as any)?.scheduleTimeHour ?? 9;
  const timeMinute = (user as any)?.scheduleTimeMinute ?? 0;

  // ── WEEKLY ──────────────────────────────────────────────────────────────
  if (type === "weekly") {
    const targetDay = (user as any)?.scheduleDayOfWeek ?? 1; // lundi par défaut
    const next = new Date(now);
    // Calcule combien de jours jusqu'au prochain targetDay
    const daysUntil = ((targetDay - now.getDay() + 7) % 7) || 7;
    next.setDate(now.getDate() + daysUntil);
    next.setHours(timeHour, timeMinute, 0, 0);
    return Math.max(next.getTime() - now.getTime(), 60_000);
  }

  // ── MONTHLY ─────────────────────────────────────────────────────────────
  if (type === "monthly") {
    const targetDay = (user as any)?.scheduleDayOfMonth ?? 1;
    const next = new Date(now.getFullYear(), now.getMonth(), targetDay, timeHour, timeMinute, 0, 0);
    // Si la date est passée ce mois-ci, on prend le mois prochain
    if (next.getTime() <= now.getTime()) {
      next.setMonth(next.getMonth() + 1);
    }
    return Math.max(next.getTime() - now.getTime(), 60_000);
  }

  // Fallback 24h
  return 24 * 60 * 60 * 1000;
}

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

export async function scheduleCheckIn(userId: string) {
  if (!checkInQueue) {
    console.warn("⚠️ Check-in queue unavailable");
    return;
  }

  // Annule tous les jobs existants
  const jobsToCancel = await Promise.all([
    checkInQueue.getJob(`checkin-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-2`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-3`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-4`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-5`),
    checkInQueue.getJob(`auto-sos-${userId}`),
  ]);
  await Promise.all(jobsToCancel.map((j) => j?.remove()));

  // Vérifie notificationsEnabled
  const userPrefsRaw = await db.user.findUnique({ where: { id: userId } });
  const notifEnabled = (userPrefsRaw as any)?.notificationsEnabled;
  if (notifEnabled === false) {
    console.log(`🔕 Notifications disabled for user ${userId} — skipping`);
    return;
  }

  const delayMs = await getNextCheckInDelayMs(userId);
  const delayMin = Math.round(delayMs / 60_000);

  await checkInQueue.add(
    "send-check-in",
    { userId, attempt: 1 },
    { jobId: `checkin-${userId}`, delay: delayMs, removeOnComplete: true },
  );

  console.log(`⏰ Check-in scheduled in ${delayMin} min for user ${userId}`);
}

export async function rescheduleAfterOk(userId: string) {
  await scheduleCheckIn(userId);
}

// ─── AUTOMATIC SOS ───────────────────────────────────────────────────────────

async function triggerAutomaticSOS(userId: string, checkInId: string) {
  const latestCheckIn = await db.checkInEvent.findUnique({
    where: { id: checkInId },
    select: { response: true },
  });
  if (latestCheckIn?.response) {
    console.log(`✅ User ${userId} responded — no SOS needed`);
    return;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { emergencyContact: true },
  });

  if (!user || !user.emergencyContact) {
    console.warn(`⚠️ User ${userId} missing or no contact — cannot SOS`);
    return;
  }

  if ((user as any).alertSystemEnabled === false) {
    console.log(`⏸️ Alert system disabled for user ${userId}`);
    await scheduleCheckIn(userId);
    return;
  }

  const existingAlert = await db.alertEvent.findFirst({
    where: { userId, status: { in: ["ACTIVE", "FAILED"] } },
    orderBy: { triggeredAt: "desc" },
  });
  if (existingAlert) {
    console.log(`ℹ️ Active alert exists for ${userId} — skipping`);
    return;
  }

  const alert = await db.alertEvent.create({
    data: {
      userId,
      triggerReason: "NO_RESPONSE_AFTER_5_REMINDERS",
      triggeredAt: new Date(),
      status: "ACTIVE",
      ...(user.lastLat != null && { latAtTrigger: user.lastLat }),
      ...(user.lastLng != null && { lngAtTrigger: user.lastLng }),
    },
  });

  console.log(`🚨 Auto SOS created for user ${userId}: ${alert.id}`);

  await alertQueue.add(
    "sendEmergencyAlert",
    {
      alertId: alert.id,
      userId,
      emergencyContactId: user.emergencyContact.id,
      emergencyPhone: user.emergencyContact.phoneNumber,
      latitude: user.lastLat ?? null,
      longitude: user.lastLng ?? null,
      maxCallRetries: 2,
    },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
  );

  await scheduleCheckIn(userId);
}

// ─── WORKER ──────────────────────────────────────────────────────────────────

if (connection) {
  new Worker(
    "check-in",
    async (job: Job) => {
      if (!checkInQueue) return;

      if (job.name === "send-check-in") {
        const { userId, attempt } = job.data as { userId: string; attempt: number };

        const userRaw = await db.user.findUnique({ where: { id: userId } });
        const user = userRaw as typeof userRaw & {
          notificationsEnabled?: boolean;
          fcmToken?: string | null;
        };

        if (!user) { console.error(`❌ User ${userId} not found`); return; }
        if (user.notificationsEnabled === false) {
          console.log(`🔕 Notifications disabled for ${userId} — skipping`); return;
        }
        if (user.status !== "ACTIVE") {
          console.log(`⏸️ User ${userId} not ACTIVE — stopped`); return;
        }

        if (attempt > 1) {
          const unanswered = await db.checkInEvent.findFirst({
            where: { userId, response: null },
            orderBy: { sentAt: "desc" },
          });
          if (!unanswered) { console.log(`✅ User ${userId} responded`); return; }
        }

        const checkIn = await db.checkInEvent.create({
          data: { userId, sentAt: new Date(), attemptNumber: attempt },
        });

        await sendCheckInNotification(userId, checkIn.id);
        console.log(`🔔 Check-in sent to ${userId}, attempt ${attempt}/${MAX_REMINDERS}`);

        if (attempt < MAX_REMINDERS) {
          const reminderJob = await checkInQueue.getJob(`checkin-reminder-${userId}`);
          await reminderJob?.remove();

          await checkInQueue.add(
            "send-check-in",
            { userId, attempt: attempt + 1 },
            {
              jobId: `checkin-reminder-${userId}-attempt-${attempt + 1}`,
              delay: FIVE_MINUTES,
              removeOnComplete: true,
            },
          );
          console.log(`⏳ Reminder ${attempt + 1}/${MAX_REMINDERS} in 5 min for ${userId}`);
          return;
        }

        await checkInQueue.add(
          "auto-sos",
          { userId, checkInId: checkIn.id },
          { jobId: `auto-sos-${userId}`, delay: FIVE_MINUTES, removeOnComplete: true },
        );
        console.log(`🚨 Auto SOS scheduled for ${userId}`);
        return;
      }

      if (job.name === "auto-sos") {
        const { userId, checkInId } = job.data as { userId: string; checkInId: string };
        await triggerAutomaticSOS(userId, checkInId);
      }
    },
    { connection },
  );
}

// ─── HANDLE USER RESPONSE ────────────────────────────────────────────────────

export async function handleUserResponse(
  userId: string,
  checkInId: string,
  response: "OK" | "SOS",
  source: "scheduled" | "manual" = "scheduled",
) {
  if (!checkInQueue) return;

  const jobsToCancel = await Promise.all([
    checkInQueue.getJob(`checkin-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-2`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-3`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-4`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-5`),
    checkInQueue.getJob(`auto-sos-${userId}`),
  ]);
  await Promise.all(jobsToCancel.map((j) => j?.remove()));

  if (source === "scheduled") {
    await db.checkInEvent.update({
      where: { id: checkInId },
      data: { response, respondedAt: new Date() },
    });
  }

  if (response === "OK") {
    await db.user.update({
      where: { id: userId },
      data: { lastCheckInAt: new Date(), status: "ACTIVE" },
    });
    await scheduleCheckIn(userId);
    return;
  }

  if (response === "SOS") {
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { emergencyContact: true },
    });
    if (!user || !user.emergencyContact) return;

    const alert = await db.alertEvent.create({
      data: {
        userId,
        triggerReason: "USER_PRESSED_SOS",
        triggeredAt: new Date(),
        status: "ACTIVE",
        ...(user.lastLat != null && { latAtTrigger: user.lastLat }),
        ...(user.lastLng != null && { lngAtTrigger: user.lastLng }),
      },
    });

    await alertQueue.add(
      "sendEmergencyAlert",
      {
        alertId: alert.id,
        userId,
        emergencyContactId: user.emergencyContact.id,
        emergencyPhone: user.emergencyContact.phoneNumber,
        latitude: user.lastLat ?? null,
        longitude: user.lastLng ?? null,
        maxCallRetries: 2,
      },
      { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
    );

    await scheduleCheckIn(userId);
  }
}
