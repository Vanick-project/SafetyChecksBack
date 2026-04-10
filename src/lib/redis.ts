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
  throw new Error("Missing REDIS_URL");
}

export const redisConnection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
