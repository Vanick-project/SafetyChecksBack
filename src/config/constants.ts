// ─── src/config/constants.ts ─────────────────────────────────────────────────

/** Maximum number of emergency call attempts (1 initial + 2 retries = 3 total). */
export const MAX_CALL_ATTEMPTS = 3;

/**
 * Delay between call retry attempts, in milliseconds.
 * 5 minutes = 300 000 ms
 * Flux : appel 1 → attente 5 min → appel 2 → attente 5 min → appel 3 → escalade SMS
 */
export const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/** Delay before sending the first check-in notification after registration. */
export const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/** Delay between check-in reminder notifications. */
export const FIVE_MINUTES = 5 * 60 * 1000;

/** Maximum number of check-in reminders before triggering an automatic SOS. */
export const MAX_REMINDERS = 3;