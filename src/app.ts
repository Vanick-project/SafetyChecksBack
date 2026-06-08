// ─── src/app.ts ───────────────────────────────────────────────────────────────

import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import usersRouter from "./routes/users.js";
import { checkInRouter } from "./routes/checkins.js";
import { alertRouter } from "./routes/alerts.js";
import { twimlRouter } from "./routes/twiml.js";
import twilioWebhookRouter from "./routes/twilio-webhook.js";
import debugRouter from "./routes/debug.js";
import "./jobs/alertWorker.js";
import "./jobs/checkin-scheduler.js";

const app = express();

// FIX: Railway utilise un proxy — sans trust proxy, express-rate-limit
// plante avec ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in 15 minutes." },
  skip: (req) =>
    req.path.startsWith("/twilio") || req.path.startsWith("/twiml"),
});
app.use(apiLimiter);

const sosLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many SOS alerts. Please contact support." },
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", message: "SafetyChecks backend is running" });
});

app.use("/users", usersRouter);
app.use("/checkins", checkInRouter);
app.use("/alerts/trigger", sosLimiter);
app.use("/alerts", alertRouter);
app.use("/twiml", twimlRouter);
app.use("/twilio", twilioWebhookRouter);

// Route debug — seulement en dev (jamais en prod)
/*
if (process.env.NODE_ENV !== "production") {
  app.use("/debug", debugRouter);
  console.log("🛠️ Debug routes enabled (dev mode)");
}*/
// ✅ Temporaire — pour déboguer le FCM
app.use("/debug", debugRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Unhandled error:", err.message, err.stack);
  const isDev = process.env.NODE_ENV !== "production";
  res.status(500).json({
    error: "Internal server error",
    ...(isDev && { detail: err.message }),
  });
});

export default app;
