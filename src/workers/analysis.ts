import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { v4 as uuid } from "uuid";
import { QUEUES } from "../lib/constants.js";
import { generateFileAnalysis } from "../lib/gemini.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import {
  analysisWorkerCompletedJobsRedisKey,
  analysisWorkerTotalJobsRedisKey,
} from "../lib/redis-keys.js";
import redisConnection from "../lib/redis.js";

async function updateRepositoryStatus(repositoryId: string) {
  const analysisWorkerTotalJobsKey =
    analysisWorkerTotalJobsRedisKey + repositoryId;
  const analysisWorkerCompletedJobsKey =
    analysisWorkerCompletedJobsRedisKey + repositoryId;

  const analysisWorkerTotalJobs = await redisConnection.get(
    analysisWorkerTotalJobsKey
  );
  const analysisWorkerCompletedJobs = await redisConnection.get(
    analysisWorkerCompletedJobsKey
  );

  console.log("-------------------------------------------------------");
  console.log("analysisWorkerTotalJobs is ", analysisWorkerTotalJobs);
  console.log("analysisWorkerCompletedJobs is ", analysisWorkerCompletedJobs);
  console.log("-------------------------------------------------------");

  if (analysisWorkerCompletedJobs === analysisWorkerTotalJobs) {
    logger.info("-------------------------------------------------------");
    logger.info(
      "Inside the if of analysisWorkerCompletedJobs === analysisWorkerTotalJobs"
    );
    logger.info("-------------------------------------------------------");

    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.PROCESSING,
      message: "Generated Analysis For all Files...",
    });

    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.SUCCESS },
    });

    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.SUCCESS,
      message: "Please Wait For Few more seconds ...",
    });

    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.SUCCESS,
      message: "Repository processing completed",
    });
  }
}

export const analysisWorker = new Worker(
  QUEUES.ANALYSIS,
  async (job) => {
    const { repositoryId, file } = job.data;
    const analysisWorkerCompletedJobsKey =
      analysisWorkerCompletedJobsRedisKey + repositoryId;

    try {
      const analysis = await generateFileAnalysis(repositoryId, file);

      // console.log("analysis --analysisWorker is ", analysis);
      const updatedFileAnalysis = await prisma.file.update({
        where: {
          id: file.id,
        },
        data: {
          analysis,
        },
      });

      console.log("updatedFileAnalysis: ", updatedFileAnalysis);

      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Generated Analysis for ${file.path}.`,
      });
      await redisConnection.incr(analysisWorkerCompletedJobsKey);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Analysis worker error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Unknown analysis worker error: ${error}`);
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
        message: `Failed to generate file analysis.`,
      });
    } finally {
      await updateRepositoryStatus(repositoryId);
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

analysisWorker.on("failed", (job, error) => {
  const { file } = job?.data;
  logger.error(`Analysis Worker at  ${file.path} processing failed.`);
});

analysisWorker.on("completed", async (job) => {
  const { file } = job.data;
  logger.success(`Analysis Worker at  ${file.path} processing completed.`);
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
