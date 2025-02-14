import dotenv from "dotenv";
import Redis from "ioredis";

dotenv.config();

const redisConnection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

redisConnection.on("connect", () => {
  console.log("Connected to Redis");
});

redisConnection.on("error", (err) => {
  console.error("Redis Error:", err);
});

export default redisConnection;
