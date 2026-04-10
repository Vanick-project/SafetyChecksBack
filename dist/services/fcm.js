import admin from "firebase-admin";
import { db } from "../db/client.js";
export async function sendCheckInNotification(userId, checkInId) {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.fcmToken)
        return;
    await admin.messaging().send({
        token: user.fcmToken,
        data: {
            type: "CHECK_IN",
            checkInId,
        },
        notification: {
            title: "Safety Check",
            body: "Are you ok?",
        },
    });
}
//# sourceMappingURL=fcm.js.map