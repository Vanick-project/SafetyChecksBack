// ─── src/jobs/alertWorker.ts ──────────────────────────────────────────────────
// BullMQ worker that processes the alertQueue.
//
// FIXES applied:
//   1. MAX_CALL_ATTEMPTS imported from shared constants — no more duplicated
//      magic number that can drift out of sync with twilio-webhook.ts.
//
//   2. Attempt count in `retryEmergencyCall` now excludes the simulated "911"
//      entry (destination: { not: "911" }), matching the count logic in
//      twilio-webhook.ts so the two never disagree on how many real attempts
//      have been made.

import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import {
  sendLocationSMS,
  sendEscalationSMS,
  callEmergencyContact,
} from "../services/twilio.js";
import { db } from "../db/client.js";
import { MAX_CALL_ATTEMPTS } from "../config/constants.js";

export const alertWorker = new Worker(
  "alertQueue",
  async (job) => {
    console.log("🔥 alertWorker received job:", job.name, job.data);

    // ── sendEmergencyAlert ────────────────────────────────────────────────────
    // Triggered by /alerts/trigger, checkin-scheduler automatic SOS, and manual
    // SOS from the check-in response flow.
    if (job.name === "sendEmergencyAlert") {
      const { alertId } = job.data as { alertId: string };

      // ── SMS (idempotent) ──────────────────────────────────────────────────
      const existingSms = await db.alertAction.findFirst({
        where: { alertId, actionType: "SMS" },
      });

      if (!existingSms) {
        try {
          await sendLocationSMS(alertId);
          console.log(`✅ SMS sent for alert ${alertId}`);
        } catch (err) {
          console.error(
            `❌ SMS failed for alert ${alertId}:`,
            err instanceof Error ? err.message : err,
          );
          // Non-fatal — continue to place the call even if SMS fails.
        }
      } else {
        console.log(`ℹ️ SMS already sent for alert ${alertId} — skipping`);
      }

      // ── Voice call (idempotent) ───────────────────────────────────────────
      const existingCalls = await db.alertAction.count({
        where: {
          alertId,
          actionType: "CALL",
          destination: { notIn: ["911", "escalation"] },
        },
      });

      if (existingCalls === 0) {
        try {
          await callEmergencyContact(alertId);
          console.log(`📞 Initial call placed for alert ${alertId}`);
        } catch (err) {
          console.error(
            `❌ Initial call failed for alert ${alertId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        console.log(`ℹ️ Call already placed for alert ${alertId} — skipping`);
      }

      return;
    }

    // ── retryEmergencyCall ────────────────────────────────────────────────────
    // Triggered by twilio-webhook.ts when a call goes unanswered.
    if (job.name === "retryEmergencyCall") {
      const { alertId } = job.data as { alertId: string };

      // Dans retryEmergencyCall — count des tentatives
      const attemptCount = await db.alertAction.count({
        where: {
          alertId,
          actionType: "CALL",
          destination: { notIn: ["911", "escalation"] },
        },
      });

      if (attemptCount >= MAX_CALL_ATTEMPTS) {
        console.log(
          `🛑 Max call attempts (${MAX_CALL_ATTEMPTS}) reached for alert ${alertId} — marking FAILED`,
        );

        await db.alertEvent.update({
          where: { id: alertId },
          data: { status: "FAILED" },
        });

        return;
      }

      try {
        console.log(
          `📞 Retry call for alert ${alertId}. ` +
            `Attempt ${attemptCount + 1}/${MAX_CALL_ATTEMPTS}`,
        );
        await callEmergencyContact(alertId);
      } catch (err) {
        console.error(
          `❌ Retry call failed for alert ${alertId}:`,
          err instanceof Error ? err.message : err,
        );
      }

      return;
    }

    console.warn(`⚠️ Unknown job name received by alertWorker: "${job.name}"`);
  },
  {
    connection: redisConnection,
  },
);

alertWorker.on("completed", (job) => {
  console.log(`✅ alertWorker: job ${job.id} (${job.name}) completed`);
});

alertWorker.on("failed", (job, err) => {
  console.error(
    `❌ alertWorker: job ${job?.id} (${job?.name}) failed:`,
    err.message,
  );
});
