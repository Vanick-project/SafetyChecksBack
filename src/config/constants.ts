// ─── src/config/constants.ts ─────────────────────────────────────────────────

/** Maximum number of emergency call attempts (1 initial + 2 retries). */
export const MAX_CALL_ATTEMPTS = 3;

/** Delay between call retry attempts, in milliseconds. */
export const RETRY_DELAY_MS = 30_000;

/** Delay before sending the first check-in notification after registration. */
export const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/**
 * Delay between check-in reminder notifications, in milliseconds.
 * 5 minutes between each reminder.
 */
export const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Maximum number of check-in reminders before triggering an automatic SOS.
 * CHANGED: 5 → 3 (3 notifications séparées de 5 min, puis SOS)
 */
export const MAX_REMINDERS = 3;