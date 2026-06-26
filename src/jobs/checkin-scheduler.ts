// ─── src/jobs/checkin-scheduler.ts ───────────────────────────────────────────
//
// AJOUT : vérification de notificationsEnabled au début de scheduleCheckIn().
//   Quand l'utilisateur désactive les notifications dans les paramètres :
//     → notificationsEnabled = false en DB
//     → scheduleCheckIn() annule les jobs existants et NE programme RIEN de nouveau
//     → Aucune notification ne sera envoyée jusqu'à réactivation
//   Quand l'utilisateur réactive :
//     → notificationsEnabled = true
//     → scheduleCheckIn() programme un nouveau job normalement

import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function getUserIntervalMs(userId: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { checkInIntervalHours: true },
  });
  const hours = user?.checkInIntervalHours ?? 24;
  return hours * 60 * 60 * 1000;
}

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

export async function scheduleCheckIn(userId: string) {
  if (!checkInQueue) {
    console.warn("⚠️ Check-in queue unavailable (Redis disabled)");
    return;
  }

  // Annule tous les jobs existants pour cet utilisateur (toujours, même si désactivé)
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

  // AJOUT : vérifie si les notifications sont activées pour cet utilisateur
  const userPrefsRaw = await db.user.findUnique({
  where: { id: userId },
  });
  const userPrefs = userPrefsRaw as typeof userPrefsRaw & { notificationsEnabled?: boolean }

  // Si notificationsEnabled est false (ou null si colonne pas encore migrée),
  // on ne programme rien — les jobs ont déjà été annulés ci-dessus.
  if (userPrefs?.notificationsEnabled === false) {
    console.log(`🔕 Notifications disabled for user ${userId} — check-in cycle suspended`);
    return;
  }

  const intervalMs = await getUserIntervalMs(userId);
  const intervalHours = intervalMs / (60 * 60 * 1000);

  await checkInQueue.add(
    "send-check-in",
    { userId, attempt: 1 },
    {
      jobId: `checkin-${userId}`,
      delay: intervalMs,
      removeOnComplete: true,
    },
  );

  console.log(`⏰ Check-in scheduled in ${intervalHours}h for user ${userId}`);
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

  if (user.alertSystemEnabled === false) {
    console.log(`⏸️ Alert system disabled for user ${userId} — skipping auto SOS`);
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
      triggerReason: "NO_RESPONSE_AFTER_5_REMINDERS",
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
            notificationsEnabled: true,
          },
          
        });
        
        

        if (!user) {
          console.error(`❌ User ${userId} not found — skipping check-in`);
          return;
        }

        // Double-vérification dans le worker : si désactivé entre-temps
        if (user.notificationsEnabled === false) {
          console.log(`🔕 Notifications disabled for user ${userId} — skipping worker execution`);
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

          console.log(`⏳ Reminder ${attempt + 1}/${MAX_REMINDERS} in 5 min for user ${userId}`);
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
    // scheduleCheckIn vérifiera notificationsEnabled et ne programmera rien si désactivé
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