// ─── src/services/fcm.ts ─────────────────────────────────────────────────────

import admin from "firebase-admin";
import { db } from "../db/client.js";

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase Admin initialized");
}

export async function sendCheckInNotification(
  userId: string,
  checkInId: string,
) {
  const user = await db.user.findUnique({ where: { id: userId } });

  if (!user?.fcmToken) {
    console.warn(`⚠️ No FCM token for user ${userId}`);
    return;
  }

  const lang = (user as any).language ?? "fr";

  const title = "🛡️ Safety Check";
  const body = lang === "fr"
    ? "Êtes-vous en sécurité ?"
    : "Are you safe?";

  try {
    await admin.messaging().send({
      token: user.fcmToken,

      // ── Champ notification : force Android à délivrer même app tuée ───────
      notification: { title, body },

      // ── Data payload : utilisé par Notifee pour la notif riche / actions ──
      data: {
        type: "CHECK_IN",
        checkInId,
        userId,
      },

      android: {
        priority: "high",
        notification: {
          // Doit matcher EXACTEMENT le channelId créé côté Notifee
          channelId: "safety-check",
          tag: `checkin-${checkInId}`,
          defaultVibrateTimings: true,
        },
      },

      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            "content-available": 1,
            alert: { title, body },
            sound: "default",
          },
        },
      },
    });

    console.log(`✅ FCM notification sent to user ${userId}, checkInId: ${checkInId}`);
  } catch (err) {
    console.error(`❌ FCM send failed for user ${userId}:`, err);

    if (
      err instanceof Error &&
      (err.message.includes("registration-token-not-registered") ||
        err.message.includes("invalid-registration-token"))
    ) {
      try {
        await db.user.update({
          where: { id: userId },
          data: { fcmToken: null },
        });
        console.warn(`🗑️ FCM token cleared for user ${userId} (token expired)`);
      } catch (clearErr) {
        console.error(`❌ Could not clear FCM token for user ${userId}:`, clearErr);
      }
    }
  }
}