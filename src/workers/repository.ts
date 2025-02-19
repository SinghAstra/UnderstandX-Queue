import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import { parseGithubUrl } from "../lib/github.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import connection from "../lib/redis.js";
import { directoryQueue } from "../queues/repository.js";

export const repositoryWorker = new Worker(
  QUEUES.REPOSITORY,
  async (job) => {
    const startTime = Date.now();
    const { repositoryId, githubUrl, userId } = job.data;

    logger.info(`job.data --repositoryWorker is ${JSON.stringify(job.data)}`);

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

      // Send update to frontend that processing has started
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Started processing repository: ${repo}`,
      });

      console.log("About to be added in directoryQueue ", {
        owner,
        repo,
        repositoryId,
        path: "",
      });

      // Queue the root directory for processing
      await directoryQueue.add(QUEUES.DIRECTORY, {
        owner,
        repo,
        repositoryId,
        path: "",
      });

      const endTime = Date.now();
      logger.success(
        `Worker processing time for repository ${repo}: ${
          endTime - startTime
        } milliseconds`
      );

      return { status: "SUCCESS", message: "Started Processing Repository" };
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Repository worker error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Unknown repository worker error: ${error}`);
      }

      // Notify user about failure
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.FAILED,
        message: `Failed to process repository.`,
      });

      // Update status to failed
      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

repositoryWorker.on("failed", (job, error) => {
  logger.error(
    `Job ${job?.id} in ${QUEUES.REPOSITORY} queue failed with error: ${error.message}`
  );
});

repositoryWorker.on("completed", (job) => {
  logger.success(
    `Job ${job.id} in ${QUEUES.REPOSITORY} queue completed successfully`
  );
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
