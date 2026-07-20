// ─── src/jobs/checkin-scheduler.ts ───────────────────────────────────────────
// PHASE 1 CASCADE (seuls changements vs version précédente) :
//   - triggerAutomaticSOS et handleUserResponse(SOS) vérifient désormais
//     qu'AU MOINS UN contact ACTIVÉ existe (emergencyContacts, plus le
//     singulier emergencyContact qui n'existe plus dans le schéma).
//   - Le job "sendEmergencyAlert" ne transporte plus emergencyContactId /
//     emergencyPhone : la cascade résout les contacts depuis la DB.
// Tout le reste (scheduling interval/weekly/monthly, rappels adaptatifs,
// récurrence) est INCHANGÉ.

import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { DateTime } from "luxon";
import { sendCheckInNotification } from "../services/fcm.js";
import { db } from "../db/client.js";
import { alertQueue } from "./alertQueue.js";
import { MAX_REMINDERS } from "../config/constants.js";

// ─── CADENCE DES RAPPELS ──────────────────────────────────────────────────────
const NORMAL_REMINDER_MS = 5 * 60 * 1000; // intervalle >= 30 min, weekly, monthly
const CLOSE_REMINDER_MS = 2 * 60 * 1000;  // intervalle court : 15-29 min
const SHORT_INTERVAL_THRESHOLD_MIN = 30;  // en-dessous -> cadence rapprochee
const MIN_INTERVAL_MIN = 15;              // plancher absolu

// Duree totale de l'intervalle en minutes (interval only ; grande valeur sinon).
function intervalTotalMinutes(u: {
  scheduleType: string | null;
  scheduleIntervalHours: number | null;
  scheduleIntervalMinutes: number | null;
  checkInIntervalHours: number | null;
}): number {
  const type = u.scheduleType ?? "interval";
  if (type !== "interval") return Number.MAX_SAFE_INTEGER;
  const h = u.scheduleIntervalHours ?? u.checkInIntervalHours ?? 24;
  const m = u.scheduleIntervalMinutes ?? 0;
  return Math.max(MIN_INTERVAL_MIN, h * 60 + m);
}

// Cadence de rappel pour un utilisateur (2 min si court, 5 min sinon).
async function reminderDelayMs(userId: string): Promise<number> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      scheduleType: true,
      scheduleIntervalHours: true,
      scheduleIntervalMinutes: true,
      checkInIntervalHours: true,
    },
  });
  if (!u) return NORMAL_REMINDER_MS;
  return intervalTotalMinutes(u) < SHORT_INTERVAL_THRESHOLD_MIN
    ? CLOSE_REMINDER_MS
    : NORMAL_REMINDER_MS;
}

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
    const rawMin =
      (user.scheduleIntervalHours ?? user.checkInIntervalHours ?? DEFAULT_HOURS) * 60 +
      (user.scheduleIntervalMinutes ?? 0);
    const totalMin = Math.max(MIN_INTERVAL_MIN, rawMin); // plancher 15 min
    const next = base + totalMin * 60 * 1000;
    return Math.max(0, next - Date.now());
  }

  // ── WEEKLY / MONTHLY : ancrés sur une heure murale → dépend du fuseau ──
  const zone = user.timezone || "UTC";
  const nowLocal = DateTime.now().setZone(zone);
  const timeH = user.scheduleTimeHour ?? 9;
  const timeM = user.scheduleTimeMinute ?? 0;

  if (type === "weekly") {
    const targetDowJs = user.scheduleDayOfWeek ?? 1;
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
  // GARDE RÉCURRENCE : un check-in non récurrent ne se reprogramme JAMAIS.
  // Point de contrôle unique — protège tous les appelants (résolution
  // d'alerte, réponse OK, etc.) contre une relance non désirée.
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { recurring: true },
  });
  if (u?.recurring === false) {
    // On annule tout job résiduel et on marque le cycle comme terminé.
    const stale = await Promise.all([
      checkInQueue.getJob(`checkin-${userId}`),
      checkInQueue.getJob(`checkin-reminder-${userId}`),
      checkInQueue.getJob(`checkin-reminder-${userId}-attempt-2`),
      checkInQueue.getJob(`checkin-reminder-${userId}-attempt-3`),
      checkInQueue.getJob(`auto-sos-${userId}`),
    ]);
    await Promise.all(stale.map((j) => j?.remove()));
    await db.user
      .update({ where: { id: userId }, data: { checkInActive: false } })
      .catch(() => {});
    console.log(`⏹️ scheduleCheckIn skipped for ${userId} — non-recurring`);
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

  await db.user
    .update({ where: { id: userId }, data: { checkInActive: true } })
    .catch(() => {});

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

  // CASCADE : au moins un contact ACTIVÉ requis
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
    console.error(`❌ User ${userId} not found for automatic SOS`);
    return;
  }

  if (user.emergencyContacts.length === 0) {
    console.warn(`⚠️ User ${userId} has no enabled emergency contact — cannot SOS`);
    return;
  }

  // Système désactivé par l'utilisateur
  if (user.alertSystemEnabled === false) {
    console.log(
      `⏸️ Alert system disabled for user ${userId} — skipping auto SOS`,
    );
    if (user.recurring !== false) {
      await scheduleCheckIn(userId);
    } else {
      await db.user.update({ where: { id: userId }, data: { checkInActive: false } }).catch(() => {});
    }
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

  // CASCADE : le job ne transporte que alertId + userId
  await alertQueue.add(
    "sendEmergencyAlert",
    { alertId: alert.id, userId },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
  );

  // Récurrent → on reprogramme ; non-récurrent → one-shot consommé, on arrête.
  if (user.recurring !== false) {
    await scheduleCheckIn(userId);
  } else {
    await db.user.update({ where: { id: userId }, data: { checkInActive: false } }).catch(() => {});
    console.log(`⏹️ Non-recurring check-in consumed for user ${userId} — cycle stopped`);
  }
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

        const delay = await reminderDelayMs(userId);
        const delayMin = Math.round(delay / 60000);

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
              delay,
              removeOnComplete: true,
            },
          );

          console.log(
            `⏳ Reminder ${attempt + 1}/${MAX_REMINDERS} in ${delayMin} min for user ${userId}`,
          );
          return;
        }

        await checkInQueue.add(
          "auto-sos",
          { userId, checkInId: checkIn.id },
          {
            jobId: `auto-sos-${userId}`,
            delay,
            removeOnComplete: true,
          },
        );

        console.log(`🚨 Auto SOS scheduled in ${delayMin} min for user ${userId}`);
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
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { recurring: true },
    });

    if (u?.recurring === false) {
      await db.user.update({
        where: { id: userId },
        data: { lastCheckInAt: new Date(), status: "ACTIVE", checkInActive: false },
      });
      console.log(`⏹️ Non-recurring OK for user ${userId} — no next check-in scheduled`);
      return;
    }

    await db.user.update({
      where: { id: userId },
      data: { lastCheckInAt: new Date(), status: "ACTIVE" },
    });
    await scheduleCheckIn(userId);
    return;
  }

  if (response === "SOS") {
    // CASCADE : au moins un contact ACTIVÉ requis
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        emergencyContacts: {
          where: { enabled: true },
          orderBy: { priority: "asc" },
        },
      },
    });

    if (!user || user.emergencyContacts.length === 0) {
      console.warn(`⚠️ Cannot SOS for ${userId} — missing user or enabled contact`);
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

    // CASCADE : le job ne transporte que alertId + userId
    await alertQueue.add(
      "sendEmergencyAlert",
      { alertId: alert.id, userId },
      { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
    );

    if (user.recurring !== false) {
      await scheduleCheckIn(userId);
    } else {
      await db.user.update({ where: { id: userId }, data: { checkInActive: false } }).catch(() => {});
    }
  }
}