import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis.js";

export const alertQueue = new Queue("alertQueue", {
  connection: redisConnection,
});
