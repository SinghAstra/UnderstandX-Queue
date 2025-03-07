import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { v4 as uuid } from "uuid";
import { FILE_BATCH_SIZE_FOR_AI_ANALYSIS, QUEUES } from "../lib/constants.js";
import {
  generateBatchAnalysis,
  generateBatchSummaries,
  getRepositoryOverview,
  ParsedAnalysis,
} from "../lib/gemini.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import {
  summaryWorkerCompletedJobsRedisKey,
  summaryWorkerTotalJobsRedisKey,
} from "../lib/redis-keys.js";
import redisConnection from "../lib/redis.js";

async function generateRepositoryOverview(repositoryId: string) {
  const summaryWorkerTotalJobsKey =
    summaryWorkerTotalJobsRedisKey + repositoryId;
  const summaryWorkerCompletedJobsKey =
    summaryWorkerCompletedJobsRedisKey + repositoryId;

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

    const repoOverview = await getRepositoryOverview(repositoryId);
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.PROCESSING, overview: repoOverview },
    });

    const filesWithoutAnalysis = await prisma.file.findMany({
      where: { repositoryId, analysis: null },
      select: { id: true, path: true, content: true },
    });

    const batchSizeForAnalysis = FILE_BATCH_SIZE_FOR_AI_ANALYSIS;
    for (
      let i = 0;
      i < filesWithoutAnalysis.length;
      i += batchSizeForAnalysis
    ) {
      const filesWithoutAnalysisBatch = filesWithoutAnalysis.slice(
        i,
        i + batchSizeForAnalysis
      );

      const analyses: ParsedAnalysis[] = await generateBatchAnalysis(
        repositoryId,
        filesWithoutAnalysisBatch,
        repoOverview
      );

      await prisma.$transaction(
        analyses.map((analysis) => {
          return prisma.file.update({
            where: { id: analysis.id },
            data: { analysis: analysis.analysis },
          });
        })
      );

      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Generated Analysis for batch ${Math.ceil(
          (i + batchSizeForAnalysis) / batchSizeForAnalysis
        )} of ${Math.ceil(filesWithoutAnalysis.length / batchSizeForAnalysis)}`,
      });
    }

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
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);
