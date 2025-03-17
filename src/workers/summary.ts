import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { v4 as uuid } from "uuid";
import { QUEUES } from "../lib/constants.js";
import {
  generateBatchSummaries,
  generateRepositoryOverview,
} from "../lib/gemini.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import {
  analysisWorkerCompletedJobsRedisKey,
  analysisWorkerTotalJobsRedisKey,
  summaryWorkerCompletedJobsRedisKey,
  summaryWorkerTotalJobsRedisKey,
} from "../lib/redis-keys.js";
import redisConnection from "../lib/redis.js";
import { analysisQueue } from "../queues/repository.js";

async function generateRepoOverview(repositoryId: string) {
  const summaryWorkerTotalJobsKey =
    summaryWorkerTotalJobsRedisKey + repositoryId;
  const summaryWorkerCompletedJobsKey =
    summaryWorkerCompletedJobsRedisKey + repositoryId;

  const analysisWorkerTotalJobsKey =
    analysisWorkerTotalJobsRedisKey + repositoryId;
  const analysisWorkerCompletedJobsKey =
    analysisWorkerCompletedJobsRedisKey + repositoryId;

  const summaryWorkerTotalJobs = await redisConnection.get(
    summaryWorkerTotalJobsKey
  );
  const summaryWorkerCompletedJobs = await redisConnection.get(
    summaryWorkerCompletedJobsKey
  );

  console.log("-------------------------------------------------------");
  console.log("summaryWorkerTotalJobs is ", summaryWorkerTotalJobs);
  console.log("summaryWorkerCompletedJobs is ", summaryWorkerCompletedJobs);
  console.log("-------------------------------------------------------");

  if (summaryWorkerCompletedJobs === summaryWorkerTotalJobs) {
    logger.info("-------------------------------------------------------");
    logger.info(
      "Inside the if of summaryWorkerCompletedJobs === summaryWorkerTotalJobs"
    );
    logger.info("-------------------------------------------------------");

    // Notify user that summary generation is starting
    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.PROCESSING,
      message: "Generated Summaries For all Files...",
    });

    const repoOverview = await generateRepositoryOverview(repositoryId);
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.PROCESSING, overview: repoOverview },
    });

    const filesWithoutAnalysis = await prisma.file.findMany({
      where: { repositoryId, analysis: null },
      select: { id: true, path: true, content: true },
    });

    redisConnection.set(
      analysisWorkerTotalJobsKey,
      filesWithoutAnalysis.length
    );
    redisConnection.set(analysisWorkerCompletedJobsKey, 0);

    filesWithoutAnalysis.map((file) => {
      analysisQueue.add(QUEUES.ANALYSIS, {
        repositoryId,
        file,
      });
    });

    await redisConnection.del(summaryWorkerCompletedJobsKey);
    await redisConnection.del(summaryWorkerTotalJobsKey);
  }
}

export const summaryWorker = new Worker(
  QUEUES.SUMMARY,
  async (job) => {
    const { repositoryId, files } = job.data;

    const summaryWorkerCompletedJobsKey =
      summaryWorkerCompletedJobsRedisKey + repositoryId;

    try {
      // Generate summaries for this batch
      const summaries = await generateBatchSummaries(files);

      // Update the database with these summaries
      await prisma.$transaction(
        summaries.map((summary: { id: string; summary: string }) =>
          prisma.file.update({
            where: { id: summary.id },
            data: { shortSummary: summary.summary },
          })
        )
      );

      // Update progress
      await redisConnection.incr(summaryWorkerCompletedJobsKey);

      // Notify frontend of progress
      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Generated short summaries for batch another batch of ${files.length} files`,
      });

      return { status: "SUCCESS", processed: files.length };
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Summary worker error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Unknown summary worker error: ${error}`);
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

      // Notify user about failure
      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.FAILED,
        message: `Failed to generate short summary.`,
      });
    } finally {
      await generateRepoOverview(repositoryId);
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

summaryWorker.on("failed", () => {
  logger.error(`Summary Worker failed.`);
});

summaryWorker.on("completed", async () => {
  logger.success(`Summary Worker processing completed.`);
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
