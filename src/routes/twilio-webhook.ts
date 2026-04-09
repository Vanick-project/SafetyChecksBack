import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/client.js";
import { alertQueue } from "../jobs/alertQueue.js";

const router = Router();

const MAX_CALL_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

async function simulate911Escalation(alertId: string) {
  const existing911Action = await db.alertAction.findFirst({
    where: {
      alertId,
      actionType: "CALL",
      destination: "911",
    },
  });

  if (existing911Action) {
    return;
  }

  await db.alertAction.create({
    data: {
      alertId,
      actionType: "CALL",
      destination: "911",
      outcome: "simulated_911_called",
      executedAt: new Date(),
    },
  });

  await db.alertEvent.update({
    where: { id: alertId },
    data: {
      status: "ACTIVE",
    },
  });

  console.log(`🚨 DEV MODE: simulated 911 call created for alert ${alertId}`);
}

router.post("/call-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, CallStatus } = req.body;

    console.log("📞 Twilio webhook:", { CallSid, CallStatus });

    const action = await db.alertAction.findFirst({
      where: {
        providerSid: CallSid,
      },
    });

    if (!action) {
      console.log("⚠️ No action found for CallSid:", CallSid);
      return res.sendStatus(200);
    }

    if (
      CallStatus === "queued" ||
      CallStatus === "initiated" ||
      CallStatus === "ringing"
    ) {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: CallStatus,
        },
      });

      return res.sendStatus(200);
    }

    if (CallStatus === "in-progress" || CallStatus === "answered") {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: "in-progress",
        },
      });

      return res.sendStatus(200);
    }

    if (CallStatus === "completed") {
      const latestAction = await db.alertAction.findUnique({
        where: { id: action.id },
      });

      if (latestAction?.outcome === "in-progress") {
        await db.alertAction.update({
          where: { id: action.id },
          data: {
            outcome: "success",
          },
        });

        console.log(
          `✅ Call succeeded for alert ${action.alertId}, but alert stays ACTIVE until user clicks I'm safe`,
        );

        return res.sendStatus(200);
      }

      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: "completed-no-human",
        },
      });

      const attemptCount = await db.alertAction.count({
        where: {
          alertId: action.alertId,
          actionType: "CALL",
          destination: {
            not: "911",
          },
        },
      });

      if (attemptCount < MAX_CALL_ATTEMPTS) {
        console.log(
          `🔁 Scheduling delayed retry for alert ${action.alertId}. Attempt ${attemptCount + 1}/${MAX_CALL_ATTEMPTS} in 30s`,
        );

        await alertQueue.add(
          "retryEmergencyCall",
          { alertId: action.alertId },
          {
            delay: RETRY_DELAY_MS,
            jobId: `retry-call-${action.alertId}-${Date.now()}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } else {
        console.log(
          `🚨 Max call attempts reached for alert ${action.alertId}. Simulating 911 escalation`,
        );
        await simulate911Escalation(action.alertId);
      }

      return res.sendStatus(200);
    }

    if (["busy", "no-answer", "canceled"].includes(CallStatus)) {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: CallStatus,
        },
      });

      const attemptCount = await db.alertAction.count({
        where: {
          alertId: action.alertId,
          actionType: "CALL",
          destination: {
            not: "911",
          },
        },
      });

      if (attemptCount < MAX_CALL_ATTEMPTS) {
        console.log(
          `🔁 Scheduling delayed retry for alert ${action.alertId}. Attempt ${attemptCount + 1}/${MAX_CALL_ATTEMPTS} in 30s`,
        );

        await alertQueue.add(
          "retryEmergencyCall",
          { alertId: action.alertId },
          {
            delay: RETRY_DELAY_MS,
            jobId: `retry-call-${action.alertId}-${Date.now()}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } else {
        console.log(
          `🚨 Max call attempts reached for alert ${action.alertId}. Simulating 911 escalation`,
        );
        await simulate911Escalation(action.alertId);
      }

      return res.sendStatus(200);
    }

    await db.alertAction.update({
      where: { id: action.id },
      data: {
        outcome: String(CallStatus ?? "unknown"),
      },
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
});

router.post("/amd-status", async (req: Request, res: Response) => {
  try {
    const { CallSid, AnsweredBy } = req.body;

    console.log("🧠 Twilio AMD webhook:", { CallSid, AnsweredBy });

    const action = await db.alertAction.findFirst({
      where: {
        providerSid: CallSid,
      },
    });

    if (!action) {
      console.log("⚠️ No action found for AMD CallSid:", CallSid);
      return res.sendStatus(200);
    }

    if (AnsweredBy === "human") {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: "in-progress",
        },
      });
    } else if (
      [
        "machine_start",
        "machine_end_beep",
        "machine_end_silence",
        "machine_end_other",
        "fax",
      ].includes(String(AnsweredBy))
    ) {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: "machine",
        },
      });
    } else {
      await db.alertAction.update({
        where: { id: action.id },
        data: {
          outcome: String(AnsweredBy ?? "unknown"),
        },
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("AMD webhook error:", err);
    return res.sendStatus(500);
  }
});

export default router;
