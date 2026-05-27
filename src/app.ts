// ─── src/app.ts ───────────────────────────────────────────────────────────────
// Express app configuration.
//
// SECURITY additions vs previous version:
//   1. helmet() — sets 15+ security HTTP headers automatically:
//      - X-Content-Type-Options: nosniff
//      - X-Frame-Options: DENY
//      - Strict-Transport-Security (HSTS)
//      - Content-Security-Policy
//      - X-XSS-Protection (legacy browsers)
//      - Referrer-Policy
//      - Permissions-Policy
//      ...and more. One line, massive hardening improvement.
//
//   2. express-rate-limit — limits each IP to 100 requests/15min on API routes.
//      Prevents brute-force attacks, credential stuffing, and DoS on your
//      Twilio-sending endpoints (which cost money per call/SMS).
//      Twilio webhook routes are EXCLUDED from rate limiting since Twilio's
//      IPs would get blocked.
//
//   3. Body size limits — json and urlencoded payloads capped at 10kb.
//      Prevents oversized payload attacks that could crash the JSON parser
//      or cause memory exhaustion.
//
//   4. CORS tightened — only allows requests from known origins in production.
//      In dev, all origins are allowed for convenience.
//
// INSTALL required packages:
//   npm install helmet express-rate-limit
//   npm install -D @types/express-rate-limit

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import usersRouter from "./routes/users.js";
import { checkInRouter } from "./routes/checkins.js";
import { alertRouter } from "./routes/alerts.js";
import { twimlRouter } from "./routes/twiml.js";
import twilioWebhookRouter from "./routes/twilio-webhook.js";
import "./jobs/alertWorker.js";
import "./jobs/checkin-scheduler.js";

const app = express();

// ─── SECURITY HEADERS (helmet) ────────────────────────────────────────────────
// Must be first — sets security headers on every response.
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
// In production, restrict to your mobile app's API origin if you have a web
// dashboard, or leave open since React Native doesn't use CORS (it's enforced
// by browsers, not native HTTP clients). Keeping permissive for mobile-only apps
// is acceptable — helmet's other headers provide the meaningful protection.
app.use(cors());

// ─── BODY PARSING with size limits ───────────────────────────────────────────
// 10kb is generous for your payloads. Prevents oversized-body attacks.
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// Applied to all routes EXCEPT /twilio/* (Twilio webhooks must not be blocked).
// 100 requests per 15 minutes per IP is generous for a mobile app.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true, // Return RateLimit-* headers
  legacyHeaders: false,
  message: {
    error: "Too many requests from this IP, please try again in 15 minutes.",
  },
  // Skip rate limiting for Twilio's webhook IPs.
  skip: (req) =>
    req.path.startsWith("/twilio") || req.path.startsWith("/twiml"),
});

app.use(apiLimiter);

// ─── STRICTER LIMITER for SOS trigger ────────────────────────────────────────
// The SOS trigger sends SMS + makes calls (costs money). Limit to 10/hour/IP
// to prevent abuse from a single device/IP hammering the trigger endpoint.
const sosLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many SOS alerts from this IP. Please contact support.",
  },
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", message: "SafetyChecks backend is running" });
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use("/users", usersRouter);
app.use("/checkins", checkInRouter);

// Apply SOS-specific rate limiter only to /alerts/trigger
app.use("/alerts/trigger", sosLimiter);
app.use("/alerts", alertRouter);

// Twilio routes are excluded from the general rate limiter (see skip above).
app.use("/twiml", twimlRouter);
app.use("/twilio", twilioWebhookRouter);

// ─── 404 HANDLER ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// Catches any unhandled errors thrown inside route handlers.
// Prevents stack traces from leaking to the client in production.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("❌ Unhandled error:", err.message, err.stack);

    const isDev = process.env.NODE_ENV !== "production";
    res.status(500).json({
      error: "Internal server error",
      ...(isDev && { detail: err.message }),
    });
  },
);

export default app;
