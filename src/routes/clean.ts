import { Queue } from "bullmq";
import "dotenv/config";
import { Request, Response, Router } from "express";
import { QUEUES } from "../lib/constants.js";
import redisConnection from "../lib/redis.js";
import { verifyCleanJobToken } from "../middleware/verify-clean-job-token.js";

const router = Router();
const NODE_ENV = process.env.NODE_ENV;

router.get(
  "/jobs",
  verifyCleanJobToken,
  async (_req: Request, res: Response) => {
    try {
      let cursor = "0";
      let keys: string[] = [];

      do {
        // Scan for batches of keys matching the pattern
        const [nextCursor, scanKeys] = await redisConnection.scan(
          cursor,
          "MATCH",
          "bull:*",
          "COUNT",
          "100"
        );

        cursor = nextCursor;
        keys = keys.concat(scanKeys);

        // Delete keys in batches to avoid memory issues
        if (scanKeys.length > 0) {
          // Delete in smaller chunks to avoid Redis command length limits
          const chunkSize = 100;
          for (let i = 0; i < scanKeys.length; i += chunkSize) {
            const chunk = scanKeys.slice(i, i + chunkSize);
            await redisConnection.del(...chunk);
          }
        }
      } while (cursor !== "0");

      console.log("Total keys found and deleted:", keys.length);

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
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default router;
