// ─── src/jobs/checkin-scheduler.ts ───────────────────────────────────────────
// Check-in cycle: 24h → 5 notifications every 5 min → automatic SOS.
//
// CHANGES vs previous version:
//   - TEN_MINUTES replaced by FIVE_MINUTES (5 reminders × 5 min = 25 min window)
//   - MAX_REMINDERS: 3 → 5
//   - triggerReason updated to "NO_RESPONSE_AFTER_5_REMINDERS"
//   - All other logic (queue bypass fix, null coords, source field) unchanged.

import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { sendCheckInNotification } from "../services/fcm.js";
import { db } from "../db/client.js";
import { alertQueue } from "./alertQueue.js";
import {
  TWENTY_FOUR_HOURS,
  FIVE_MINUTES,
  MAX_REMINDERS,
} from "../config/constants.js";

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

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

export async function scheduleCheckIn(userId: string) {
  if (!checkInQueue) {
    console.warn("⚠️ Check-in queue unavailable (Redis disabled)");
    return;
  }

  const [mainJob, reminderJob] = await Promise.all([
    checkInQueue.getJob(`checkin-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}`),
  ]);
  await Promise.all([mainJob?.remove(), reminderJob?.remove()]);

  await checkInQueue.add(
    "send-check-in",
    { userId, attempt: 1 },
    {
      jobId: `checkin-${userId}`,
      delay: TWENTY_FOUR_HOURS,
      removeOnComplete: true,
    },
  );

  console.log(`⏰ Check-in scheduled in 24h for user ${userId}`);
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
      // UPDATED: reflects new 5-reminder threshold
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
    {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    },
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

      // ── send-check-in ─────────────────────────────────────────────────────
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

        // On reminder attempts (2+), stop if the user already responded.
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
          data: {
            userId,
            sentAt: new Date(),
            attemptNumber: attempt,
          },
        });

        await sendCheckInNotification(userId, checkIn.id);

        console.log(
          `🔔 Check-in notification sent to ${userId}, attempt ${attempt}/${MAX_REMINDERS}`,
        );

        // ── Schedule next reminder or SOS ─────────────────────────────────
        if (attempt < MAX_REMINDERS) {
          const reminderJob = await checkInQueue.getJob(
            `checkin-reminder-${userId}`,
          );
          await reminderJob?.remove();

          // CHANGED: was TEN_MINUTES, now FIVE_MINUTES
          await checkInQueue.add(
            "send-check-in",
            { userId, attempt: attempt + 1 },
            {
              jobId: `checkin-reminder-${userId}`,
              delay: FIVE_MINUTES,
              removeOnComplete: true,
            },
          );

          console.log(
            `⏳ Reminder ${attempt + 1}/${MAX_REMINDERS} in 5 min for user ${userId}`,
          );
          return;
        }

        // All 5 reminders exhausted — wait one more cycle then SOS.
        await checkInQueue.add(
          "auto-sos",
          { userId, checkInId: checkIn.id },
          {
            jobId: `auto-sos-${userId}`,
            delay: FIVE_MINUTES,
            removeOnComplete: true,
          },
        );

        console.log(
          `🚨 Auto SOS scheduled in 5 min for user ${userId} (5 reminders exhausted)`,
        );
        return;
      }

      // ── auto-sos ──────────────────────────────────────────────────────────
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

  const [mainJob, reminderJob, autoSosJob] = await Promise.all([
    checkInQueue.getJob(`checkin-${userId}`),
    checkInQueue.getJob(`checkin-reminder-${userId}`),
    checkInQueue.getJob(`auto-sos-${userId}`),
  ]);
  await Promise.all([
    mainJob?.remove(),
    reminderJob?.remove(),
    autoSosJob?.remove(),
  ]);

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
      {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );

    await scheduleCheckIn(userId);
  }
}
