import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { CONCURRENT_WORKERS, QUEUES } from "../lib/constants.js";
import { parseGithubUrl } from "../lib/github.js";
import { prisma } from "../lib/prisma.js";
import {
  getDirectoryWorkerCompletedJobsRedisKey,
  getDirectoryWorkerTotalJobsRedisKey,
} from "../lib/redis/redis-keys.js";
import redisClient from "../lib/redis/redis.js";
import { directoryQueue, logQueue } from "../queues/index.js";

export const repositoryWorker = new Worker(
  QUEUES.REPOSITORY,
  async (job) => {
    console.log("Starting repository worker...");
    const { repositoryId, githubUrl } = job.data;

    const directoryWorkerTotalJobsRedisKey =
      getDirectoryWorkerTotalJobsRedisKey(repositoryId);
    const directoryWorkerCompletedJobsRedisKey =
      getDirectoryWorkerCompletedJobsRedisKey(repositoryId);

    try {
      const { owner, repo, isValid } = parseGithubUrl(githubUrl);

      if (!isValid || !owner) {
        throw new Error("Invalid GitHub URL");
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: {
          status: RepositoryStatus.PROCESSING,
        },
      });

      console.log("About to be added in directoryQueue ", {
        owner,
        repo,
        repositoryId,
        path: "",
      });

      await redisClient
        .multi()
        .set(directoryWorkerTotalJobsRedisKey, 1)
        .set(directoryWorkerCompletedJobsRedisKey, 0)
        .exec();

      await directoryQueue.add(QUEUES.DIRECTORY, {
        owner,
        repo,
        repositoryId,
        path: "",
      });

      return { status: "SUCCESS", message: "Started Processing Repository" };
    } catch (error) {
      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }

      await logQueue.add(
        QUEUES.LOG,
        {
          repositoryId,
          status: RepositoryStatus.FAILED,
          message:
            error instanceof Error
              ? `⚠️ ${error.message}`
              : "⚠️ Oops! Something went wrong. Please try again later. ",
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
        }
      );

      // Update status to failed
      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });
    }
  },
  {
    connection: redisClient,
    concurrency: CONCURRENT_WORKERS,
  }
);

repositoryWorker.on("failed", (error) => {
  if (error instanceof Error) {
    console.log("error.stack is ", error.stack);
    console.log("error.message is ", error.message);
  }
  console.log("Error occurred in repository worker");
});

repositoryWorker.on("completed", () => {
  console.log("Repository worker completed");
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
