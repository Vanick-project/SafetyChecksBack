import express from "express";
import cors from "cors";

import usersRouter from "./routes/users.js";
import { checkInRouter } from "./routes/checkins.js";
import { alertRouter } from "./routes/alerts.js";
import { twimlRouter } from "./routes/twiml.js";
import twilioWebhookRouter from "./routes/twilio-webhook.js";
//import "./jobs/alertWorker.js";
//import "./jobs/checkin-scheduler.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", message: "SafetyChecks backend is running" });
});

app.use("/users", usersRouter);
app.use("/checkins", checkInRouter);
app.use("/alerts", alertRouter);
app.use("/twiml", twimlRouter);
app.use("/twilio", twilioWebhookRouter);

export default app;
