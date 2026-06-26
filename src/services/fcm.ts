// ─── src/services/fcm.ts ─────────────────────────────────────────────────────
//
// CORRECTION CRITIQUE :
//   userId manquait dans le payload data FCM.
//   Le handler background de notifications.ts (registerFCMBackgroundHandler)
//   dépend de remoteMessage.data.userId pour savoir à quel utilisateur
//   la réponse appartient. Sans ce champ, checkInId et userId sont undefined
//   → le handler loggue un warning et ne fait rien → l'app peut crasher
//   si notifee tente d'afficher une notification avec des data incomplètes.

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
        // CORRECTION : userId inclus pour que le handler background puisse
        // répondre au bon utilisateur sans dépendre d'un closure.
        userId,
      },
      // Notification silencieuse — le frontend (notifee) construit
      // et affiche la notification dans son propre handler.
      // On ne met PAS de champ `notification` ici car sur Android,
      // si `notification` est présent, FCM affiche une notif système
      // générique ET déclenche le handler → double notification.
      android: {
        priority: "high",
      },
      apns: {
        headers: {
          // Priorité maximale pour iOS background delivery
          "apns-priority": "10",
        },
        payload: {
          aps: {
            // content-available = 1 permet de réveiller l'app en background sur iOS
            "content-available": 1,
          },
        },
      },
    });
    console.log(`✅ FCM notification sent to user ${userId}, checkInId: ${checkInId}`);
  } catch (err) {
    console.error(`❌ FCM send failed for user ${userId}:`, err);
    // Si le token est invalide (registration-token-not-registered),
    // on le supprime pour éviter des tentatives inutiles futures.
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