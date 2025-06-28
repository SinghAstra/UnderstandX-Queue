import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { CONCURRENT_WORKERS, QUEUES } from "../lib/constants.js";
import {
  generateBatchSummaries,
  generateRepositoryOverview,
} from "../lib/gemini.js";
import { prisma } from "../lib/prisma.js";
import { checkCompletion } from "../lib/redis/atomic-operation.js";
import {
  getAnalysisWorkerTotalJobsRedisKey,
  getRepositoryCancelledRedisKey,
  getSummaryWorkerCompletedJobsRedisKey,
  getSummaryWorkerTotalJobsRedisKey,
} from "../lib/redis/redis-keys.js";
import redisClient from "../lib/redis/redis.js";
import { analysisQueue, logQueue } from "../queues/index.js";

async function generateRepoOverview(repositoryId: string) {
  const summaryWorkerTotalJobsKey =
    getSummaryWorkerTotalJobsRedisKey(repositoryId);
  const summaryWorkerCompletedJobsKey =
    getSummaryWorkerCompletedJobsRedisKey(repositoryId);
  const analysisWorkerTotalJobsKey =
    getAnalysisWorkerTotalJobsRedisKey(repositoryId);

  console.log("🔍 Redis keys in generateRepoOverview:", {
    summaryWorkerTotalJobsKey,
    summaryWorkerCompletedJobsKey,
    analysisWorkerTotalJobsKey,
  });

  // Use atomic check - only one worker will get true when all summaries are complete
  const allSummariesComplete = await checkCompletion(
    summaryWorkerCompletedJobsKey,
    summaryWorkerTotalJobsKey
  );

  if (allSummariesComplete) {
    console.log("-------------------------------------------------------");
    console.log("All summary workers completed - starting overview generation");
    console.log("-------------------------------------------------------");

    await logQueue.add(
      QUEUES.LOG,
      {
        repositoryId,
        status: RepositoryStatus.PROCESSING,
        message: "✅ All file summaries successfully generated!",
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );

    const repoOverview = await generateRepositoryOverview(repositoryId);
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.PROCESSING, overview: repoOverview },
    });

    const filesWithoutAnalysis = await prisma.file.findMany({
      where: { repositoryId, analysis: null },
      select: { id: true, path: true, content: true },
    });

    redisClient.set(analysisWorkerTotalJobsKey, filesWithoutAnalysis.length);

    filesWithoutAnalysis.map((file) => {
      analysisQueue.add(QUEUES.ANALYSIS, {
        repositoryId,
        file,
      });
    });
  }
}

export const summaryWorker = new Worker(
  QUEUES.SUMMARY,
  async (job) => {
    const { repositoryId, files } = job.data;
    const isCancelled = await redisClient.get(
      getRepositoryCancelledRedisKey(repositoryId)
    );
    if (isCancelled === "true") {
      console.log(`❌ Summary Worker for ${repositoryId} has been cancelled`);
      return;
    }

    const summaryWorkerCompletedJobsKey =
      getSummaryWorkerCompletedJobsRedisKey(repositoryId);

    try {
      // Generate summaries for this batch
      const summaries = await generateBatchSummaries(files);

      const updateSummary = summaries.map((summary) => {
        return prisma.file.update({
          where: { id: summary.id },
          data: { shortSummary: summary.summary },
        });
      });

      await prisma.$transaction(updateSummary);

      // Update progress
      await redisClient.incr(summaryWorkerCompletedJobsKey);

      await logQueue.add(
        QUEUES.LOG,
        {
          repositoryId,
          status: RepositoryStatus.PROCESSING,
          message: `🤔 Generating summary for files...`,
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
        }
      );

      return { status: "SUCCESS", processed: files.length };
    } catch (error) {
      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

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
    } finally {
      await generateRepoOverview(repositoryId);
    }
  },
  {
    connection: redisClient,
    concurrency: CONCURRENT_WORKERS,
  }
);

summaryWorker.on("failed", (job, error) => {
  if (error instanceof Error) {
    console.log("error.stack is ", error.stack);
    console.log("error.message is ", error.message);
  }
  console.log("Error occurred in Summary worker");
});

summaryWorker.on("completed", async () => {
  console.log("Summary Worker completed successfully.");
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
