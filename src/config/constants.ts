// ─── src/config/constants.ts ─────────────────────────────────────────────────

/** Maximum number of emergency call attempts (1 initial + 2 retries). */
export const MAX_CALL_ATTEMPTS = 3;

/** Delay between call retry attempts, in milliseconds. */
export const RETRY_DELAY_MS = 30_000;

/** Delay before sending the first check-in notification after registration. */
export const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/**
 * Delay between check-in reminder notifications, in milliseconds.
 * CHANGED: 10 min → 5 min as per product requirements.
 */
export const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Maximum number of check-in reminders before triggering an automatic SOS.
 * CHANGED: 3 → 5 as per product requirements.
 */
export const MAX_REMINDERS = 5;
