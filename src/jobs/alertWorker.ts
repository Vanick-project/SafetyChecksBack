// ─── src/jobs/alertWorker.ts ──────────────────────────────────────────────────
// BullMQ worker de la alertQueue.
//
// PHASE 1 CASCADE : le worker ne contient PLUS de logique métier — il délègue
// tout à src/services/cascade.ts (machine à états testable indépendamment).
//
//   "sendEmergencyAlert"  → startCascade    (contact priority 1 : SMS + appel)
//   "retryEmergencyCall"  → continueCascade (retry même contact, ou contact
//                           suivant, ou FAILED si tous épuisés)
//
// Les anciens champs de job (emergencyContactId, emergencyPhone, maxCallRetries)
// sont ignorés — la cascade résout les contacts depuis la DB à chaque étape,
// donc un contact modifié PENDANT une alerte est pris en compte.

import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { startCascade, continueCascade } from "../services/cascade.js";

export const alertWorker = new Worker(
  "alertQueue",
  async (job) => {
    console.log("🔥 alertWorker received job:", job.name, job.data);

    const { alertId } = job.data as { alertId?: string };
    if (!alertId) {
      console.error(`❌ alertWorker: job ${job.name} without alertId — skipped`);
      return;
    }

    if (job.name === "sendEmergencyAlert") {
      await startCascade(alertId);
      return;
    }

    if (job.name === "retryEmergencyCall") {
      await continueCascade(alertId);
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