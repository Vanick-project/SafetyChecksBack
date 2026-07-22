// Purge tous les jobs BullMQ dont le userId n'existe plus en DB.
// Usage : npx tsx scripts/purge-orphan-jobs.ts

import { alertQueue } from "../src/jobs/alertQueue.js";
import { checkInQueue } from "../src/jobs/checkin-scheduler.js";
import { db } from "../src/db/client.js";

async function main() {
  const users = await db.user.findMany({ select: { id: true } });
  const validIds = new Set(users.map((u) => u.id));
  console.log(`✅ ${validIds.size} valid user(s) in DB`);

  const purgeQueue = async (name: string, queue: any) => {
    if (!queue) {
      console.log(`⚠️ ${name}: queue not available (no REDIS_URL)`);
      return;
    }
    const jobs = await queue.getJobs([
      "delayed",
      "waiting",
      "active",
      "paused",
    ]);
    let removed = 0;
    for (const job of jobs) {
      const uid = job?.data?.userId;
      if (uid && !validIds.has(uid)) {
        await job.remove().catch(() => {});
        removed++;
      }
    }
    console.log(
      `🗑️  ${name}: purged ${removed} orphan job(s) (${jobs.length} total)`,
    );
  };

  await purgeQueue("checkInQueue", checkInQueue);
  await purgeQueue("alertQueue", alertQueue);

  await db.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Purge failed:", err);
  process.exit(1);
});