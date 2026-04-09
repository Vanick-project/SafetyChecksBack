import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { sendCheckInNotification } from "../services/fcm.js";
import { sendLocationSMS, callEmergencyContact } from "../services/twilio.js";
import { db } from "../db/client.js";

const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const checkInQueue = new Queue("check-in", { connection });

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const MAX_REMINDERS = 3;

export async function scheduleCheckIn(userId: string) {
  const mainJob = await checkInQueue.getJob(`checkin-${userId}`);
  await mainJob?.remove();

  const reminderJob = await checkInQueue.getJob(`checkin-reminder-${userId}`);
  await reminderJob?.remove();

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
  const mainJob = await checkInQueue.getJob(`checkin-${userId}`);
  await mainJob?.remove();

  const reminderJob = await checkInQueue.getJob(`checkin-reminder-${userId}`);
  await reminderJob?.remove();

  await scheduleCheckIn(userId);
}

async function triggerAutomaticSOS(userId: string, checkInId: string) {
  const latestCheckIn = await db.checkInEvent.findUnique({
    where: { id: checkInId },
  });

  if (latestCheckIn?.response) {
    console.log(`✅ User ${userId} responded meanwhile, no SOS needed`);
    return;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { emergencyContact: true },
  });

  if (!user) {
    console.log(`❌ User ${userId} not found for automatic SOS`);
    return;
  }

  const existingActiveAlert = await db.alertEvent.findFirst({
    where: {
      userId,
      status: "ACTIVE",
    },
    orderBy: {
      triggeredAt: "desc",
    },
  });

  if (existingActiveAlert) {
    console.log(`ℹ️ Active alert already exists for user ${userId}`);
    return;
  }

  const alert = await db.alertEvent.create({
    data: {
      userId,
      triggerReason: "NO_RESPONSE_AFTER_3_REMINDERS",
      triggeredAt: new Date(),
      status: "ACTIVE",
      latAtTrigger: user.lastLat ?? 0,
      lngAtTrigger: user.lastLng ?? 0,
    },
  });

  console.log(`🚨 Automatic SOS created for user ${userId}: ${alert.id}`);

  if (user.emergencyContact) {
    try {
      await sendLocationSMS(alert.id);
    } catch (err) {
      console.error(
        "❌ Automatic SOS SMS failed:",
        err instanceof Error ? err.message : err,
      );
    }

    try {
      await callEmergencyContact(alert.id);
    } catch (err) {
      console.error(
        "❌ Automatic SOS call failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  await scheduleCheckIn(userId);
}

new Worker(
  "check-in",
  async (job: Job) => {
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
        console.log(`❌ User ${userId} not found`);
        return;
      }

      if (user.status !== "ACTIVE") {
        console.log(`⏸️ User ${userId} is not ACTIVE, reminders stopped`);
        return;
      }

      const latestUnansweredCheckIn = await db.checkInEvent.findFirst({
        where: {
          userId,
          response: null,
        },
        orderBy: {
          sentAt: "desc",
        },
      });

      if (attempt > 1 && !latestUnansweredCheckIn) {
        console.log(`✅ User ${userId} already responded, stop reminders`);
        return;
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
        `🔔 Check-in notification sent to user ${userId}, attempt ${attempt}`,
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
            jobId: `checkin-reminder-${userId}`,
            delay: TEN_MINUTES,
            removeOnComplete: true,
          },
        );

        console.log(
          `⏳ Reminder ${attempt + 1} scheduled in 10 min for user ${userId}`,
        );
        return;
      }

      await checkInQueue.add(
        "auto-sos",
        {
          userId,
          checkInId: checkIn.id,
        },
        {
          jobId: `auto-sos-${userId}`,
          delay: TEN_MINUTES,
          removeOnComplete: true,
        },
      );

      console.log(`🚨 Auto SOS scheduled in 10 min for user ${userId}`);
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

export async function handleUserResponse(
  userId: string,
  checkInId: string,
  response: "OK" | "SOS",
) {
  const mainJob = await checkInQueue.getJob(`checkin-${userId}`);
  await mainJob?.remove();

  const reminderJob = await checkInQueue.getJob(`checkin-reminder-${userId}`);
  await reminderJob?.remove();

  const autoSosJob = await checkInQueue.getJob(`auto-sos-${userId}`);
  await autoSosJob?.remove();

  const isManual = checkInId === "manual" || checkInId === "manual-sos";

  if (!isManual) {
    await db.checkInEvent.update({
      where: { id: checkInId },
      data: {
        response,
        respondedAt: new Date(),
      },
    });
  }

  if (response === "OK") {
    await db.user.update({
      where: { id: userId },
      data: {
        lastCheckInAt: new Date(),
        status: "ACTIVE",
      },
    });

    await scheduleCheckIn(userId);
    return;
  }

  if (response === "SOS") {
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { emergencyContact: true },
    });

    if (!user) return;

    const alert = await db.alertEvent.create({
      data: {
        userId,
        triggerReason: "USER_PRESSED_SOS",
        triggeredAt: new Date(),
        status: "ACTIVE",
        latAtTrigger: user.lastLat ?? 0,
        lngAtTrigger: user.lastLng ?? 0,
      },
    });

    if (user.emergencyContact) {
      try {
        await sendLocationSMS(alert.id);
      } catch (err) {
        console.error(
          "❌ Manual SOS SMS failed:",
          err instanceof Error ? err.message : err,
        );
      }

      try {
        await callEmergencyContact(alert.id);
      } catch (err) {
        console.error(
          "❌ Manual SOS call failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    await scheduleCheckIn(userId);
  }
}
