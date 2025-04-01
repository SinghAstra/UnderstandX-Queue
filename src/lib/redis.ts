import dotenv from "dotenv";
import { Redis } from "ioredis";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error("REDIS_URL missing environment variable");
}

const redisClient = new Redis(REDIS_URL, {
  retryStrategy: () => null,
  maxRetriesPerRequest: null,
  tls: {
    rejectUnauthorized: false,
  },
});

redisClient.on("end", () => {
  console.log("shutting down Redis service due to lost Redis connection");
});

export default redisClient;
