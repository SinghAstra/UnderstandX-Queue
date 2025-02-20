import { Queue } from "bullmq";
import { Request, Response, Router } from "express";
import { QUEUES } from "../lib/constants.js";
import redisConnection from "../lib/redis.js";

const router = Router();

router.get("/jobs", async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV !== "development") {
    res.status(403).json({
      error: "This endpoint is only available in development mode",
    });
    return;
  }

  try {
    // Get all keys that match BullMQ job patterns
    const keys = await redisConnection.keys("bull:*");

    if (keys.length === 0) {
      res.status(200).json({ message: "No jobs found to clean" });
      return;
    }

    // Delete all BullMQ related keys
    if (keys.length > 0) {
      await redisConnection.del(...keys);
    }

    const queueNames = [QUEUES.DIRECTORY, QUEUES.REPOSITORY];

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
    console.error("Error cleaning jobs:", error);
    res.status(500).json({
      error: "Failed to clean jobs",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
