import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import connection from "../config/redis.js";
import { QUEUES } from "../lib/constants.js";
import { parseGithubUrl } from "../lib/github.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";

export const repositoryWorker = new Worker(
  QUEUES.REPOSITORY,
  async (job) => {
    const startTime = Date.now();
    const { repositoryId, githubUrl, auth } = job.data;

    logger.info(`job.data --repositoryWorker is ${job.data}`);

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

      // Queue the root directory for processing
      // await directoryQueue.add("process-directory", {
      //   owner,
      //   repo,
      //   repositoryId,
      //   path: "",
      //   auth,
      // });

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
  logger.error(
    `Job ${job.id} in ${QUEUES.REPOSITORY} queue completed successfully`
  );
});
