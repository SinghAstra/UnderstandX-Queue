import dotenv from "dotenv";
import { Redis } from "ioredis";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error("REDIS_URL missing environment variable");
}

const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    console.log("retrying redis connection");
    if (times > 10) {
      console.log("lost connection and exhausted attempts : ", times);
      return null;
    }
    // reconnect after
    return Math.min(times * 600, 6000);
  },
});

redisClient.on("error", (error) => {
  console.log("----------------------------------------");
  console.log("Redis connection error.");
  if (error instanceof Error) {
    console.log("error.stack is ", error.stack);
    console.log("error.message is ", error.message);
  }
  console.log("----------------------------------------");
});

redisClient.on("connect", () => {
  console.log("Successfully connected to Redis");
});

redisClient.on("end", () => {
  console.log("shutting down Redis service due to lost Redis connection");
});

export default redisClient;
