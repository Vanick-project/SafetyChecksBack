// ─── src/config/constants.ts ─────────────────────────────────────────────────
// Single source of truth for all shared constants.
// Import from here instead of re-declaring in each file.

/** Maximum number of emergency call attempts (1 initial + 2 retries). */
export const MAX_CALL_ATTEMPTS = 3;

/** Delay between call retry attempts, in milliseconds. */
export const RETRY_DELAY_MS = 30_000;

/** Delay before sending the first check-in notification, in milliseconds. */
export const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/** Delay between check-in reminder notifications, in milliseconds. */
export const TEN_MINUTES = 10 * 60 * 1000;

/** Maximum number of check-in reminders before triggering an automatic SOS. */
export const MAX_REMINDERS = 3;
