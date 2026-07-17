// ─── src/services/cascade.ts ─────────────────────────────────────────────────
// Machine à états de la cascade d'appels SOS multi-contacts.
//
// SÉQUENCE : 1→1→1 → 2→2→2 → 3→3→3
//   - MAX_CALL_ATTEMPTS (constants.ts) = tentatives PAR CONTACT (3)
//   - SMS envoyé UNIQUEMENT au contact en cours, au moment où la cascade
//     l'engage (idempotent : un seul SMS par contact et par alerte)
//   - Confirmation humaine (Digits=1 via /twiml/gather ou AMD human) → la
//     cascade s'arrête, l'alerte reste ACTIVE jusqu'au "Je suis safe"
//   - Tous les contacts épuisés → alerte FAILED (chaque contact a déjà reçu
//     son SMS avec la géolocalisation — pas de SMS d'escalade supplémentaire)
//
// POINTS D'ENTRÉE (appelés par alertWorker.ts) :
//   startCascade(alertId)    ← job "sendEmergencyAlert"
//   continueCascade(alertId) ← job "retryEmergencyCall" (planifié par
//                              /twiml/call-status après chaque échec)
//
// ÉTAT PERSISTÉ (aucun état en mémoire — résiste aux redémarrages Railway) :
//   AlertEvent.currentContactId → contact en cours
//   AlertAction.contactId       → compteur de tentatives par contact

import { db } from "../db/client.js";
import { MAX_CALL_ATTEMPTS } from "../config/constants.js";
import { sendLocationSMS, callEmergencyContact } from "./twilio.js";

type Contact = {
  id: string;
  userId: string;
  name: string;
  phoneNumber: string;
  priority: number;
  enabled: boolean;
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Contacts activés de l'utilisateur, dans l'ordre d'appel (priority asc). */
export async function getEnabledContacts(userId: string): Promise<Contact[]> {
  return db.emergencyContact.findMany({
    where: { userId, enabled: true },
    orderBy: { priority: "asc" },
  });
}

/** Nombre d'appels déjà passés vers CE contact pour CETTE alerte. */
export async function countCallAttempts(
  alertId: string,
  contactId: string,
): Promise<number> {
  return db.alertAction.count({
    where: { alertId, actionType: "CALL", contactId },
  });
}

/** Premier contact (priority > afterPriority) qui n'a pas épuisé ses tentatives. */
async function findNextAvailableContact(
  alertId: string,
  contacts: Contact[],
  afterPriority: number,
): Promise<Contact | null> {
  for (const contact of contacts) {
    if (contact.priority <= afterPriority) continue;
    const attempts = await countCallAttempts(alertId, contact.id);
    if (attempts < MAX_CALL_ATTEMPTS) return contact;
  }
  return null;
}

/**
 * Engage un contact dans la cascade :
 *   1. le marque comme contact courant (currentContactId)
 *   2. lui envoie le SMS de localisation (une seule fois par alerte)
 *   3. lance le premier appel vers lui
 */
async function engageContact(alertId: string, contact: Contact): Promise<void> {
  await db.alertEvent.update({
    where: { id: alertId },
    data: { currentContactId: contact.id },
  });

  // SMS idempotent par contact — un contact ne reçoit jamais 2 SMS pour la même alerte
  const existingSms = await db.alertAction.findFirst({
    where: { alertId, actionType: "SMS", contactId: contact.id },
    select: { id: true },
  });

  if (!existingSms) {
    try {
      await sendLocationSMS(alertId, contact.id);
      console.log(
        `📩 [cascade] SMS sent to contact priority=${contact.priority} (${contact.id}) — alert ${alertId}`,
      );
    } catch (err) {
      // Non fatal : l'appel part quand même
      console.error(
        `❌ [cascade] SMS failed for contact ${contact.id} — alert ${alertId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await callEmergencyContact(alertId, contact.id);
  console.log(
    `📞 [cascade] Call placed to contact priority=${contact.priority} (${contact.id}) — alert ${alertId}`,
  );
}

/** Tous les contacts épuisés → alerte FAILED + trace d'audit. */
async function markCascadeExhausted(
  alertId: string,
  reason: string,
): Promise<void> {
  await db.alertEvent.update({
    where: { id: alertId },
    data: { status: "FAILED" },
  });
  await db.alertAction.create({
    data: {
      alertId,
      actionType: "SYSTEM",
      destination: "cascade",
      outcome: reason, // "all_contacts_exhausted" | "no_enabled_contact"
      executedAt: new Date(),
    },
  });
  console.log(`🛑 [cascade] ${reason} — alert ${alertId} marked FAILED`);
}

// ─── POINTS D'ENTRÉE ─────────────────────────────────────────────────────────

/**
 * Démarre la cascade : premier contact activé (priority la plus basse).
 * Idempotent : si un appel existe déjà pour cette alerte, ne relance rien
 * (protège contre un double traitement du job "sendEmergencyAlert").
 */
export async function startCascade(alertId: string): Promise<void> {
  const alert = await db.alertEvent.findUnique({ where: { id: alertId } });

  if (!alert) {
    console.error(`❌ [cascade] Alert ${alertId} not found — cannot start`);
    return;
  }
  if (alert.status !== "ACTIVE") {
    console.log(
      `⏹️ [cascade] Alert ${alertId} is ${alert.status} — start skipped`,
    );
    return;
  }

  const contacts = await getEnabledContacts(alert.userId);
  if (contacts.length === 0) {
    await markCascadeExhausted(alertId, "no_enabled_contact");
    return;
  }

  const existingCalls = await db.alertAction.count({
    where: { alertId, actionType: "CALL" },
  });
  if (existingCalls > 0) {
    console.log(`ℹ️ [cascade] Alert ${alertId} already started — skipping`);
    return;
  }

  await engageContact(alertId, contacts[0]!);
}

/**
 * Continue la cascade après un échec d'appel (planifié par /twiml/call-status
 * via le job "retryEmergencyCall") :
 *   - contact courant < MAX_CALL_ATTEMPTS → nouvelle tentative (pas de SMS)
 *   - contact courant épuisé → contact suivant (SMS + appel)
 *   - plus aucun contact disponible → FAILED
 */
export async function continueCascade(alertId: string): Promise<void> {
  const alert = await db.alertEvent.findUnique({ where: { id: alertId } });

  if (!alert) {
    console.error(`❌ [cascade] Alert ${alertId} not found — cannot continue`);
    return;
  }
  if (alert.status !== "ACTIVE") {
    console.log(
      `⏹️ [cascade] Alert ${alertId} is ${alert.status} — retry skipped`,
    );
    return;
  }

  const contacts = await getEnabledContacts(alert.userId);
  if (contacts.length === 0) {
    await markCascadeExhausted(alertId, "no_enabled_contact");
    return;
  }

  const current = contacts.find((c) => c.id === alert.currentContactId) ?? null;

  if (current) {
    const attempts = await countCallAttempts(alertId, current.id);

    if (attempts < MAX_CALL_ATTEMPTS) {
      // Nouvelle tentative vers le MÊME contact — pas de nouveau SMS
      await callEmergencyContact(alertId, current.id);
      console.log(
        `🔁 [cascade] Retry ${attempts + 1}/${MAX_CALL_ATTEMPTS} to contact ` +
          `priority=${current.priority} — alert ${alertId}`,
      );
      return;
    }

    // Contact courant épuisé → suivant dans l'ordre de priorité
    const next = await findNextAvailableContact(
      alertId,
      contacts,
      current.priority,
    );
    if (next) {
      console.log(
        `➡️ [cascade] Contact priority=${current.priority} exhausted — ` +
          `moving to priority=${next.priority} — alert ${alertId}`,
      );
      await engageContact(alertId, next);
      return;
    }

    await markCascadeExhausted(alertId, "all_contacts_exhausted");
    return;
  }

  // Contact courant introuvable (supprimé / désactivé pendant l'alerte)
  // → premier contact activé non épuisé
  const next = await findNextAvailableContact(alertId, contacts, 0);
  if (next) {
    console.log(
      `⚠️ [cascade] Current contact missing — falling back to ` +
        `priority=${next.priority} — alert ${alertId}`,
    );
    await engageContact(alertId, next);
    return;
  }

  await markCascadeExhausted(alertId, "all_contacts_exhausted");
}