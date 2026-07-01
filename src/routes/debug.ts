// ─── src/routes/debug.ts ─────────────────────────────────────────────────────
// Routes de test — actives UNIQUEMENT quand NODE_ENV !== "production".
// app.ts ne monte ce router que si NODE_ENV n'est pas "production".
// Ne jamais déployer ces routes en prod.

import { Router } from "express";
import type { Request, Response } from "express";
import { checkInQueue, scheduleCheckIn } from "../jobs/checkin-scheduler.js";
import { db } from "../db/client.js";
import { sendCheckInNotification } from "../services/fcm.js";

const router = Router();

// Helper — Express 5 type req.params comme string | string[] | undefined, Prisma attend string.
function param(value: string | string[] | undefined): string {
  if (!value) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

// POST /debug/trigger-checkin/:userId
router.post("/trigger-checkin/:userId", async (req: Request, res: Response) => {
  try {
    const userId = param(req.params.userId);

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, fcmToken: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.fcmToken) {
      return res.status(400).json({
        error: "User has no FCM token — notifications cannot be sent",
        hint: "Make sure the app called PATCH /users/fcm-token after login",
      });
    }

    const checkIn = await db.checkInEvent.create({
      data: {
        userId,
        sentAt: new Date(),
        attemptNumber: 1,
      },
    });

    await sendCheckInNotification(userId, checkIn.id);

    console.log(
      `🛠️ [DEBUG] Manual check-in notification sent to user ${userId}`,
    );

    return res.json({
      ok: true,
      checkInId: checkIn.id,
      message: "Check-in notification sent immediately",
    });
  } catch (err) {
    console.error("POST /debug/trigger-checkin error:", err);
    return res.status(500).json({ error: "Debug trigger failed" });
  }
});

// POST /debug/reschedule/:userId
router.post("/reschedule/:userId", async (req: Request, res: Response) => {
  try {
    const userId = param(req.params.userId);
    const { delaySeconds = 30 } = (req.body ?? {}) as { delaySeconds?: number };

    if (!checkInQueue) {
      return res.status(503).json({ error: "Check-in queue unavailable" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
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

    await checkInQueue.add(
      "send-check-in",
      { userId, attempt: 1 },
      {
        jobId: `checkin-${userId}`,
        delay: delaySeconds * 1000,
        removeOnComplete: true,
      },
    );

    console.log(
      `🛠️ [DEBUG] Check-in rescheduled in ${delaySeconds}s for user ${userId}`,
    );

    return res.json({
      ok: true,
      message: `Check-in scheduled in ${delaySeconds} seconds`,
      delaySeconds,
    });
  } catch (err) {
    console.error("POST /debug/reschedule error:", err);
    return res.status(500).json({ error: "Reschedule failed" });
  }
});

// GET /debug/queue-status/:userId
router.get("/queue-status/:userId", async (req: Request, res: Response) => {
  try {
    const userId = param(req.params.userId);

    if (!checkInQueue) {
      return res.status(503).json({ error: "Check-in queue unavailable" });
    }

    const [mainJob, reminderJob, autoSosJob] = await Promise.all([
      checkInQueue.getJob(`checkin-${userId}`),
      checkInQueue.getJob(`checkin-reminder-${userId}`),
      checkInQueue.getJob(`auto-sos-${userId}`),
    ]);

    const jobInfo = async (job: any) => {
      if (!job) return null;
      const state = await job.getState();
      return {
        id: job.id,
        name: job.name,
        state,
        delay: job.opts?.delay,
        processAt: job.opts?.delay
          ? new Date(job.timestamp + job.opts.delay).toISOString()
          : null,
      };
    };

    return res.json({
      userId,
      jobs: {
        main: await jobInfo(mainJob),
        reminder: await jobInfo(reminderJob),
        autoSos: await jobInfo(autoSosJob),
      },
    });
  } catch (err) {
    console.error("GET /debug/queue-status error:", err);
    return res.status(500).json({ error: "Queue status fetch failed" });
  }
});

export default router;
