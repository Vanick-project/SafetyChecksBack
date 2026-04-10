/*
import { Redis } from "ioredis";

export const redisConnection = new Redis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
}); 
*/
let redisConnection: any = null;

if (process.env.REDIS_URL) {
  const { Redis } = require("ioredis");
  redisConnection = new Redis(process.env.REDIS_URL);
} else {
  console.log("⚠️ Redis disabled (no REDIS_URL)");
}

export { redisConnection };
