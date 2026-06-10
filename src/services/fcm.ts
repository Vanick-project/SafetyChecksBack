// ─── src/services/fcm.ts ─────────────────────────────────────────────────────
import admin from "firebase-admin";
import { db } from "../db/client.js";

// Initialise Firebase Admin une seule fois
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

  try {
    await admin.messaging().send({
      token: user.fcmToken,
      data: {
        type: "CHECK_IN",
        checkInId,
      },
      notification: {
        title: "Safety Check",
        body: "Êtes-vous ok ?",
      },
      android: {
        priority: "high",
      },
    });
    console.log(`✅ FCM notification sent to user ${userId}`);
  } catch (err) {
    console.error(`❌ FCM send failed for user ${userId}:`, err);
  }
}
