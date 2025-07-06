import "dotenv/config";
import express, { Request, Response } from "express";
import redisClient from "./lib/redis/redis.js";
import cleanRoutes from "./routes/clean.js";
import queueRoutes from "./routes/queue.js";

const app = express();
const PORT = 5000;

app.use(express.json());

app.use("/api/queue", queueRoutes);
app.use("/api/clean", cleanRoutes);

app.get("/", async (req: Request, res: Response) => {
  try {
    const pong = await redisClient.ping();
    res.status(200).json({
      message: "Service is up",
      redis: pong,
    });
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    res.status(500).json({
      message: "Service is up, but Redis connection failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Service is listening on http://localhost:${PORT}`);
});
