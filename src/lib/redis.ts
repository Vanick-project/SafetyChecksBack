/*
import { Redis } from "ioredis";

export const redisConnection = new Redis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
}); 
*/
import { Redis } from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("Missing REDIS_URL environment variable");
}

const redisUrl = new URL(process.env.REDIS_URL);
console.log("✅ Redis connecting to:", redisUrl.host);

export const redisConnection = new Redis(process.env.REDIS_URL, {
  // Required by BullMQ — disables the default retry limit so workers don't
  // crash after a transient Redis blip.
  maxRetriesPerRequest: null,
  // DO NOT add `tls: {}` here. The `rediss://` scheme in REDIS_URL already
  // tells ioredis to use TLS. Adding it explicitly causes handshake errors
  // with Upstash on Railway.
});

redisConnection.on("connect", () => console.log("✅ Redis connected"));
redisConnection.on("error", (err) =>
  console.error("❌ Redis connection error:", err.message),
);
