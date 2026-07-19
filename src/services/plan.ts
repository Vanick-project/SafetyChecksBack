// ─── src/services/plan.ts ────────────────────────────────────────────────────
// Source de vérité UNIQUE des limites par plan.
// Toute règle métier liée au plan passe par ce fichier — jamais de nombre
// magique "3 contacts" ou "7 jours" ailleurs dans le code.

import { db } from "../db/client.js";

export const PLAN_LIMITS = {
  FREE: {
    maxContacts: 1,
    historyDays: 0, // STRICT : aucun historique en FREE (fonctionnalité Basic)
    historyMaxRows: 0,
    canCustomizeSchedule: false, // FREE : check-in réglable à l'inscription SEULEMENT
  },
  BASIC: {
    maxContacts: 3,
    historyDays: 365, // 12 mois
    historyMaxRows: 500,
    canCustomizeSchedule: true, // BASIC : modifiable à tout moment
  },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;

/** Intervalle de check-in par défaut (heures) si l'app n'en fournit aucun. */
export const DEFAULT_CHECKIN_HOURS = 24;

/**
 * Résout le plan EFFECTIF d'un utilisateur.
 * Filet de sécurité : si le webhook EXPIRATION de RevenueCat n'est pas encore
 * arrivé mais que planExpiresAt est dépassé, l'utilisateur est traité en FREE.
 * (planExpiresAt null + plan BASIC = accès accordé manuellement → pas d'expiration)
 */
export async function resolveUserPlan(userId: string): Promise<PlanName> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { plan: true, planExpiresAt: true },
  });

  if (!user) return "FREE";

  if (user.plan === "BASIC") {
    if (user.planExpiresAt && user.planExpiresAt.getTime() < Date.now()) {
      return "FREE";
    }
    return "BASIC";
  }

  return "FREE";
}

/** Limites effectives d'un utilisateur (plan résolu + expiration vérifiée). */
export async function getUserLimits(userId: string) {
  const plan = await resolveUserPlan(userId);
  return { plan, ...PLAN_LIMITS[plan] };
}

/**
 * true si l'utilisateur peut MODIFIER son check-in maintenant.
 * FREE : false (le réglage n'est possible qu'à l'inscription via /register).
 * BASIC : true.
 */
export async function canCustomizeSchedule(userId: string): Promise<boolean> {
  const plan = await resolveUserPlan(userId);
  return PLAN_LIMITS[plan].canCustomizeSchedule;
}