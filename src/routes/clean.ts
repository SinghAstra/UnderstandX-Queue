import { Queue } from "bullmq";
import "dotenv/config";
import { Request, Response, Router } from "express";
import { QUEUES } from "../lib/constants.js";
import redisConnection from "../lib/redis.js";

const router = Router();
const NODE_ENV = process.env.NODE_ENV;

router.get("/jobs", async (_req: Request, res: Response) => {
  // router.get("/jobs", async (_req: Request, res: Response) => {

  console.log("NODE_ENV is ", NODE_ENV);
  if (NODE_ENV !== "development") {
    res.status(403).json({
      message: "This endpoint is only available in development mode",
    });
    return;
  }

  try {
    // Get all keys that match BullMQ job patterns
    const keys = await redisConnection.keys("bull:*");
    console.log("keys is ", keys);

    if (keys.length === 0) {
      res.status(200).json({ message: "No jobs found to clean" });
      return;
    }

    // Delete all BullMQ related keys
    if (keys.length > 0) {
      await redisConnection.del(...keys);
    }

    const queueNames = [
      QUEUES.DIRECTORY,
      QUEUES.REPOSITORY,
      QUEUES.ANALYSIS,
      QUEUES.SUMMARY,
    ];

    for (const queueName of queueNames) {
      const queue = new Queue(queueName, { connection: redisConnection });
      await queue.obliterate({ force: true });
      await queue.close();
    }

    res.status(200).json({
      message: `Successfully cleaned ${keys.length} BullMQ related keys`,
      queuesEmptied: queueNames,
    });
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    res.status(500).json({
      message: "Failed to clean jobs",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
