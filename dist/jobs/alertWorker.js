import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { sendLocationSMS, callEmergencyContact } from "../services/twilio.js";
import { db } from "../db/client.js";
export const alertWorker = new Worker("alertQueue", async (job) => {
    console.log("🔥 Job reçu :", job.name, job.data);
    if (job.name === "sendEmergencyAlert") {
        const { alertId } = job.data;
        const existingSms = await db.alertAction.findFirst({
            where: {
                alertId,
                actionType: "SMS",
            },
        });
        if (!existingSms) {
            try {
                await sendLocationSMS(alertId);
                console.log("✅ SMS envoyé");
            }
            catch (err) {
                console.error("❌ SMS échoué:", err instanceof Error ? err.message : err);
            }
        }
        const existingCalls = await db.alertAction.count({
            where: {
                alertId,
                actionType: "CALL",
            },
        });
        if (existingCalls === 0) {
            try {
                await callEmergencyContact(alertId);
                console.log("📞 Premier appel lancé");
            }
            catch (err) {
                console.error("❌ Erreur premier appel:", err instanceof Error ? err.message : err);
            }
        }
        return;
    }
    if (job.name === "retryEmergencyCall") {
        const { alertId } = job.data;
        const attemptCount = await db.alertAction.count({
            where: {
                alertId,
                actionType: "CALL",
            },
        });
        const MAX_CALL_ATTEMPTS = 3;
        if (attemptCount >= MAX_CALL_ATTEMPTS) {
            console.log(`🛑 Max call attempts reached for alert ${alertId}`);
            await db.alertEvent.update({
                where: { id: alertId },
                data: {
                    status: "FAILED",
                },
            });
            return;
        }
        try {
            console.log(`📞 Retry delayed call for alert ${alertId}. Attempt ${attemptCount + 1}/${MAX_CALL_ATTEMPTS}`);
            await callEmergencyContact(alertId);
        }
        catch (err) {
            console.error("❌ Erreur retry appel:", err instanceof Error ? err.message : err);
        }
        return;
    }
}, {
    connection: redisConnection,
});
alertWorker.on("completed", (job) => {
    console.log(`✅ Job ${job.id} terminé`);
});
alertWorker.on("failed", (job, err) => {
    console.error(`❌ Job ${job?.id} échoué:`, err.message);
});
//# sourceMappingURL=alertWorker.js.map