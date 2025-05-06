import { Queue } from "bullmq";
import { Request, Response } from "express";
import { cancelAllRepositoryJobs } from "../lib/cancel-jobs.js";
import { QUEUES } from "../lib/constants.js";
import { prisma } from "../lib/prisma.js";
import redisClient from "../lib/redis.js";

export const cleanJobs = async (_req: Request, res: Response) => {
  try {
    const NODE_ENV = process.env.NODE_ENV;

    if (process.env.NODE_ENV !== "development") {
      throw new Error("This route is not available in production mode");
    }
    let cursor = "0";
    let keys: string[] = [];

    do {
      // Scan for batches of keys matching the pattern
      const [nextCursor, scanKeys] = await redisClient.scan(
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
          await redisClient.del(...chunk);
        }
      }
    } while (cursor !== "0");

    console.log("Total keys found and deleted:", keys.length);

    const queueNames = [
      QUEUES.REPOSITORY,
      QUEUES.DIRECTORY,
      QUEUES.SUMMARY,
      QUEUES.ANALYSIS,
      QUEUES.LOG,
    ];

    for (const queueName of queueNames) {
      const queue = new Queue(queueName, { connection: redisClient });
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
      message: error instanceof Error ? error.message : "Failed to Clean Jobs",
    });
  }
};

export const cleanUserJobs = async (req: Request, res: Response) => {
  try {
    console.log("----------------------------------");
    console.log("----------------------------------");
    console.log("In Clean User Jobs");
    const userId = req.body.auth.userId;
    console.log("req.body.auth is ", req.body.auth);
    console.log("userId is ", userId);
    const repositories = await prisma.repository.findMany({
      where: {
        status: {
          in: ["PROCESSING", "PENDING"],
        },
        userId,
      },
    });

    console.log("repositories are ", repositories);

    repositories.map(async (repository) => {
      console.log("repository.id is ", repository.id);
      await cancelAllRepositoryJobs(repository.id);
    });

    res.status(200).json({
      message: `Successfully cleaned all Jobs `,
    });
    console.log("----------------------------------");
    console.log("----------------------------------");
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    res.status(500).json({
      message:
        error instanceof Error ? error.message : "Failed to Clean User Jobs",
    });
  }
};
