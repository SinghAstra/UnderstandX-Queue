import dotenv from "dotenv";
import { Redis } from "ioredis";

dotenv.config();

const redisURL = process.env.REDIS_URL;

if (!redisURL) {
  throw new Error("Missing REDIS_URL environment variable");
}

const redisConnection = new Redis(redisURL, {
  maxRetriesPerRequest: null,
});

redisConnection.on("connect", () => {
  console.log("Connected to Redis");
});

redisConnection.on("error", () => {
  console.error("Redis Error while connecting.");
});

export default redisConnection;
