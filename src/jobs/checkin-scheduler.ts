// ─── src/jobs/checkin-scheduler.ts ───────────────────────────────────────────
// CHANGEMENTS vs version précédente :
//   - scheduleCheckIn gère les 3 modes (interval | weekly | monthly), en
//     miroir de getNextCheckInMs du HomeScreen → affichage et déclenchement
//     restent cohérents.
//   - weekly/monthly sont calculés dans le FUSEAU de l'utilisateur (champ
//     User.timezone, IANA, ex "America/Toronto") via luxon → gère aussi le DST.
//     Fallback "UTC" si le fuseau n'est pas connu.
//   - interval reste une pure durée depuis lastCheckInAt (indépendant du fuseau).
//   - FIVE_MINUTES entre les rappels, MAX_REMINDERS = 3.

import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { DateTime } from "luxon";
import { sendCheckInNotification } from "../services/fcm.js";
import { db } from "../db/client.js";
import { alertQueue } from "./alertQueue.js";
import { FIVE_MINUTES, MAX_REMINDERS } from "../config/constants.js";

// ─── REDIS ───────────────────────────────────────────────────────────────────

let connection: Redis | null = null;

if (process.env.REDIS_URL) {
  connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  connection.on("connect", () => console.log("✅ check-in Redis connected"));
  connection.on("error", (err) =>
    console.error("❌ check-in Redis error:", err.message),
  );
} else {
  console.warn("⚠️ Redis disabled — check-in queue unavailable (no REDIS_URL)");
}

export const checkInQueue: Queue | null = connection
  ? new Queue("check-in", { connection })
  : null;

// ─── CALCUL DU PROCHAIN CHECK-IN ──────────────────────────────────────────────
// Retourne le nombre de millisecondes jusqu'au prochain check-in.
// Reproduit exactement getNextCheckInMs du HomeScreen, mais côté serveur et
// dans le fuseau de l'utilisateur pour weekly/monthly.

async function computeNextDelayMs(userId: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      checkInIntervalHours: true,
      scheduleType: true,
      scheduleIntervalHours: true,
      scheduleIntervalMinutes: true,
      scheduleDayOfWeek: true,
      scheduleDayOfMonth: true,
      scheduleTimeHour: true,
      scheduleTimeMinute: true,
      lastCheckInAt: true,
      createdAt: true,
      timezone: true,
    },
  });

  const DEFAULT_HOURS = 24;
  if (!user) return DEFAULT_HOURS * 60 * 60 * 1000;

  const type = user.scheduleType ?? "interval";

  // ── INTERVAL : pure durée depuis lastCheckInAt → indépendant du fuseau ──
  if (type === "interval") {
    const base = (user.lastCheckInAt ?? user.createdAt ?? new Date()).getTime();
    const h =
      user.scheduleIntervalHours ??
      user.checkInIntervalHours ??
      DEFAULT_HOURS;
    const m = user.scheduleIntervalMinutes ?? 0;
    const next = base + (h * 60 + m) * 60 * 1000;
    return Math.max(0, next - Date.now());
  }

  // ── WEEKLY / MONTHLY : ancrés sur une heure murale → dépend du fuseau ──
  const zone = user.timezone || "UTC";
  const nowLocal = DateTime.now().setZone(zone);
  const timeH = user.scheduleTimeHour ?? 9;
  const timeM = user.scheduleTimeMinute ?? 0;

  if (type === "weekly") {
    // scheduleDayOfWeek : 0=dimanche..6=samedi (convention JS, comme le HomeScreen)
    const targetDowJs = user.scheduleDayOfWeek ?? 1;
    // luxon weekday : 1=lundi..7=dimanche → %7 donne dim=0..sam=6 (= getDay JS)
    const nowDowJs = nowLocal.weekday % 7;
    const daysUntil = ((targetDowJs - nowDowJs + 7) % 7) || 7;
    const next = nowLocal
      .plus({ days: daysUntil })
      .set({ hour: timeH, minute: timeM, second: 0, millisecond: 0 });
    return Math.max(0, next.toMillis() - nowLocal.toMillis());
  }

  if (type === "monthly") {
    const rawDom = user.scheduleDayOfMonth ?? 1;
    let next = nowLocal.set({
      hour: timeH,
      minute: timeM,
      second: 0,
      millisecond: 0,
    });
    // clamp au dernier jour du mois (ex : 31 en février → 28/29)
    next = next.set({ day: Math.min(rawDom, next.daysInMonth ?? 28) });
    if (next <= nowLocal) {
      const nm = next.plus({ months: 1 });
      next = nm.set({ day: Math.min(rawDom, nm.daysInMonth ?? 28) });
    }
    return Math.max(0, next.toMillis() - nowLocal.toMillis());
  }

  return DEFAULT_HOURS * 60 * 60 * 1000;
}

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

export async function scheduleCheckIn(userId: string) {
  if (!checkInQueue) {
    console.warn("⚠️ Check-in queue unavailable (Redis disabled)");
    return;
  }

  // Annule tous les jobs existants pour cet utilisateur.
  const jobsToCancel = await Promise.all([
    checkInQueue.getJob(`checkin-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}`), // legacy
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-2`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-3`),
    checkInQueue.getJob(`auto-sos-${userId}`),
  ]);
  await Promise.all(jobsToCancel.map((j) => j?.remove()));

  // Délai jusqu'au prochain check-in selon le mode (interval/weekly/monthly).
  const delayMs = await computeNextDelayMs(userId);

  await checkInQueue.add(
    "send-check-in",
    { userId, attempt: 1 },
    {
      jobId: `checkin-${userId}`,
      delay: delayMs,
      removeOnComplete: true,
    },
  );

  const mins = Math.round(delayMs / 60000);
  const hrs = (delayMs / 3600000).toFixed(1);
  console.log(
    `⏰ Check-in scheduled in ~${mins} min (${hrs}h) for user ${userId}`,
  );
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
    console.log(`✅ User ${userId} responded meanwhile — no SOS needed`);
    return;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { emergencyContact: true },
  });

  if (!user) {
    console.error(`❌ User ${userId} not found for automatic SOS`);
    return;
  }

  if (!user.emergencyContact) {
    console.warn(`⚠️ User ${userId} has no emergency contact — cannot SOS`);
    return;
  }

  // Système désactivé par l'utilisateur
  if (user.alertSystemEnabled === false) {
    console.log(
      `⏸️ Alert system disabled for user ${userId} — skipping auto SOS`,
    );
    await scheduleCheckIn(userId);
    return;
  }

  const existingActiveAlert = await db.alertEvent.findFirst({
    where: { userId, status: { in: ["ACTIVE", "FAILED"] } },
    orderBy: { triggeredAt: "desc" },
  });

  if (existingActiveAlert) {
    console.log(`ℹ️ Active alert already exists for user ${userId} — skipping`);
    return;
  }

  const alert = await db.alertEvent.create({
    data: {
      userId,
      triggerReason: "NO_RESPONSE_AFTER_3_REMINDERS",
      triggeredAt: new Date(),
      status: "ACTIVE",
      ...(user.lastLat != null && { latAtTrigger: user.lastLat }),
      ...(user.lastLng != null && { lngAtTrigger: user.lastLng }),
    },
  });

  console.log(`🚨 Automatic SOS created for user ${userId}: ${alert.id}`);

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
      if (!checkInQueue) {
        console.warn("⚠️ Check-in queue unavailable inside worker");
        return;
      }

      if (job.name === "send-check-in") {
        const { userId, attempt } = job.data as {
          userId: string;
          attempt: number;
        };

        const user = await db.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            status: true,
            lastCheckInAt: true,
            fcmToken: true,
          },
        });

        if (!user) {
          console.error(`❌ User ${userId} not found — skipping check-in`);
          return;
        }

        if (user.status !== "ACTIVE") {
          console.log(`⏸️ User ${userId} is not ACTIVE — reminders stopped`);
          return;
        }

        if (attempt > 1) {
          const unanswered = await db.checkInEvent.findFirst({
            where: { userId, response: null },
            orderBy: { sentAt: "desc" },
          });
          if (!unanswered) {
            console.log(`✅ User ${userId} already responded — stopping`);
            return;
          }
        }

        const checkIn = await db.checkInEvent.create({
          data: { userId, sentAt: new Date(), attemptNumber: attempt },
        });

        await sendCheckInNotification(userId, checkIn.id);

        console.log(
          `🔔 Check-in sent to ${userId}, attempt ${attempt}/${MAX_REMINDERS}`,
        );

        if (attempt < MAX_REMINDERS) {
          const reminderJob = await checkInQueue.getJob(
            `checkin-reminder-${userId}`,
          );
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

          console.log(
            `⏳ Reminder ${attempt + 1}/${MAX_REMINDERS} in 5 min for user ${userId}`,
          );
          return;
        }

        await checkInQueue.add(
          "auto-sos",
          { userId, checkInId: checkIn.id },
          {
            jobId: `auto-sos-${userId}`,
            delay: FIVE_MINUTES,
            removeOnComplete: true,
          },
        );

        console.log(`🚨 Auto SOS scheduled in 5 min for user ${userId}`);
        return;
      }

      if (job.name === "auto-sos") {
        const { userId, checkInId } = job.data as {
          userId: string;
          checkInId: string;
        };
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
  if (!checkInQueue) {
    console.warn("⚠️ Check-in queue unavailable (Redis disabled)");
    return;
  }

  const jobsToCancel = await Promise.all([
    checkInQueue.getJob(`checkin-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}`), // legacy
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-2`),
    checkInQueue.getJob(`checkin-reminder-${userId}-attempt-3`),
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

    if (!user || !user.emergencyContact) {
      console.warn(`⚠️ Cannot SOS for ${userId} — missing user or contact`);
      return;
    }

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