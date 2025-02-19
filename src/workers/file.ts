import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { GitHubContent } from "../interfaces/github.js";
import { QUEUES } from "../lib/constants.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import connection from "../lib/redis.js";

export const fileBatchWorker = new Worker(
  QUEUES.FILE_BATCH,
  async (job) => {
    const startTime = Date.now();
    const {
      batch,
      repositoryId,
      directoryId,
      currentPath,
      batchNumber,
      totalBatches,
    } = job.data;

    try {
      // Process files in batch
      batch.map(async (file: GitHubContent) => {
        await prisma.file.create({
          data: {
            path: file.path,
            name: file.name,
            content: file.content || "",
            repositoryId,
            directoryId,
          },
        });
      });

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Processed batch ${batchNumber}/${totalBatches} in ${
          currentPath || "root"
        }`,
      });

      const endTime = Date.now();
      logger.success(
        `Worker processing time for file batch ${batchNumber}/${totalBatches} in ${
          currentPath || "root"
        }: ${endTime - startTime} milliseconds`
      );

      return { status: "SUCCESS" };
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`File batch worker error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Unknown file batch worker error: ${error}`);
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.FAILED,
        message: `Failed processing batch ${batchNumber}/${totalBatches} in ${
          currentPath || "root"
        }`,
      });

      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

fileBatchWorker.on("failed", (job, error) => {
  logger.error(
    `Job ${job?.id} in ${QUEUES.FILE_BATCH} queue failed with error: ${error.message}`
  );
});

fileBatchWorker.on("completed", (job) => {
  logger.success(
    `Job ${job.id} in ${QUEUES.FILE_BATCH} queue completed successfully`
  );
});
