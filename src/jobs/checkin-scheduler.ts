// ─── src/jobs/checkin-scheduler.ts ───────────────────────────────────────────
// Schedules 24-hour check-in cycles, sends reminders, and triggers automatic
// SOS after 3 unanswered reminders.
//
// FIXES applied:
//   1. QUEUE BYPASS: `triggerAutomaticSOS` and `handleUserResponse (SOS branch)`
//      previously called `sendLocationSMS` and `callEmergencyContact` directly,
//      skipping the alertQueue entirely. This meant no deduplication, no retry
//      on failure, and different behavior from the /alerts/trigger endpoint.
//      Both now go through `alertQueue.add("sendEmergencyAlert", ...)`.
//
//   2. NULL COORDINATES: `latAtTrigger: user.lastLat ?? 0` was sending (0,0)
//      — the middle of the Atlantic — when a user had no stored location.
//      Changed to omit the fields when null, matching the /alerts/trigger logic.
//
//   3. MAGIC STRING IDs: `checkInId === "manual"` comparison is fragile.
//      Replaced with an explicit `source` field in the payload type.
//
//   4. TLS: Removed `tls: {}` from the local Redis connection. The `rediss://`
//      scheme in REDIS_URL already enables TLS in ioredis.
//
//   5. Constants imported from shared config (no more re-declared literals).

import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { sendCheckInNotification } from "../services/fcm.js";
import { db } from "../db/client.js";
import { alertQueue } from "./alertQueue.js";
import {
  TWENTY_FOUR_HOURS,
  TEN_MINUTES,
  MAX_REMINDERS,
} from "../config/constants.js";

// ─── REDIS CONNECTION ─────────────────────────────────────────────────────────
// FIX: No `tls: {}`. The `rediss://` scheme handles TLS automatically.

let connection: Redis | null = null;

if (process.env.REDIS_URL) {
  connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    // DO NOT add tls: {} — rediss:// URL already enables TLS in ioredis.
  });
  connection.on("connect", () => console.log("✅ check-in Redis connected"));
  connection.on("error", (err) =>
    console.error("❌ check-in Redis error:", err.message),
  );
} else {
  console.warn(
    "⚠️ Redis disabled — check-in queue will not function (no REDIS_URL)",
  );
}

export const checkInQueue: Queue | null = connection
  ? new Queue("check-in", { connection })
  : null;

// ─── SCHEDULE / RESCHEDULE ───────────────────────────────────────────────────

export async function scheduleCheckIn(userId: string) {
  if (!checkInQueue) {
    console.warn("⚠️ Check-in queue unavailable (Redis disabled)");
    return;
  }

  // Clear any existing jobs for this user before scheduling a fresh one.
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
// FIX: now enqueues via alertQueue instead of calling Twilio directly.

async function triggerAutomaticSOS(userId: string, checkInId: string) {
  // Guard: user may have responded between the scheduler firing and now.
  const latestCheckIn = await db.checkInEvent.findUnique({
    where: { id: checkInId },
    select: { response: true },
  });

  if (latestCheckIn?.response) {
    console.log(
      `✅ User ${userId} responded meanwhile — no automatic SOS needed`,
    );
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
    console.warn(
      `⚠️ User ${userId} has no emergency contact — cannot trigger automatic SOS`,
    );
    return;
  }

  // Idempotency guard — don't create a second alert if one is already active.
  const existingActiveAlert = await db.alertEvent.findFirst({
    where: { userId, status: { in: ["ACTIVE", "FAILED"] } },
    orderBy: { triggeredAt: "desc" },
  });

  if (existingActiveAlert) {
    console.log(
      `ℹ️ Active alert already exists for user ${userId} — skipping automatic SOS`,
    );
    return;
  }

  // FIX: Omit coordinates when null instead of defaulting to (0,0).
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

  // FIX: go through alertQueue for deduplication, retry, and consistent behavior.
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

  // Restart the 24h cycle immediately so the user isn't forgotten.
  await scheduleCheckIn(userId);
}

// ─── CHECK-IN WORKER ─────────────────────────────────────────────────────────

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

        // On retry attempts, stop if the user already responded.
        if (attempt > 1) {
          const unanswered = await db.checkInEvent.findFirst({
            where: { userId, response: null },
            orderBy: { sentAt: "desc" },
          });

          if (!unanswered) {
            console.log(
              `✅ User ${userId} already responded — stopping reminders`,
            );
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
          `🔔 Check-in notification sent to user ${userId}, attempt ${attempt}/${MAX_REMINDERS}`,
        );

        if (attempt < MAX_REMINDERS) {
          // Schedule the next reminder.
          const reminderJob = await checkInQueue.getJob(
            `checkin-reminder-${userId}`,
          );
          await reminderJob?.remove();

          await checkInQueue.add(
            "send-check-in",
            { userId, attempt: attempt + 1 },
            {
              jobId: `checkin-reminder-${userId}`,
              delay: TEN_MINUTES,
              removeOnComplete: true,
            },
          );

          console.log(
            `⏳ Reminder ${attempt + 1}/${MAX_REMINDERS} scheduled in 10 min for user ${userId}`,
          );
          return;
        }

        // All reminders exhausted — schedule the automatic SOS.
        await checkInQueue.add(
          "auto-sos",
          { userId, checkInId: checkIn.id },
          {
            jobId: `auto-sos-${userId}`,
            delay: TEN_MINUTES,
            removeOnComplete: true,
          },
        );

        console.log(`🚨 Auto SOS scheduled in 10 min for user ${userId}`);
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
// Called when the user taps "I'm ok" or "Need help" in the app.
//
// FIX (magic string IDs): The old code checked `checkInId === "manual"` to skip
// the DB update. Now the caller passes `source: "scheduled" | "manual"` and we
// check that field instead — explicit and type-safe.

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

  // Cancel all pending jobs for this user.
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

  // FIX: use explicit `source` flag instead of magic string comparison.
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
      console.warn(
        `⚠️ Cannot trigger SOS for user ${userId} — missing user or contact`,
      );
      return;
    }

    // FIX: Omit coordinates when null instead of defaulting to (0,0).
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

    // FIX: go through alertQueue (retry, deduplication, consistent behavior).
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
