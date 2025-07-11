import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { ANALYSIS_WORKERS, QUEUES } from "../lib/constants.js";
import { generateFileAnalysis } from "../lib/gemini.js";
import { prisma } from "../lib/prisma.js";

import { checkCompletion } from "../lib/redis/atomic-operation.js";
import {
  getAnalysisSetRedisKey,
  getAnalysisWorkerCompletedJobsRedisKey,
  getAnalysisWorkerTotalJobsRedisKey,
  getRepositoryCancelledRedisKey,
} from "../lib/redis/redis-keys.js";
import redisClient from "../lib/redis/redis.js";
import { logQueue } from "../queues/index.js";

async function updateRepositoryStatus(repositoryId: string) {
  const analysisWorkerTotalJobsKey =
    getAnalysisWorkerTotalJobsRedisKey(repositoryId);
  const analysisWorkerCompletedJobsKey =
    getAnalysisWorkerCompletedJobsRedisKey(repositoryId);

  // Use atomic check - only one worker will get true when all summaries are complete
  const allAnalysisComplete = await checkCompletion(
    analysisWorkerCompletedJobsKey,
    analysisWorkerTotalJobsKey
  );

  if (allAnalysisComplete) {
    console.log("-------------------------------------------------------");
    console.log("All analysis workers completed ");
    console.log("-------------------------------------------------------");
  }

  const analysisWorkerTotalJobs = await redisClient.get(
    analysisWorkerTotalJobsKey
  );
  const analysisWorkerCompletedJobs = await redisClient.get(
    analysisWorkerCompletedJobsKey
  );

  if (!analysisWorkerCompletedJobs || !analysisWorkerTotalJobs) {
    console.log("analysisWorker Job Tracking Values not found in redis db.");
    return;
  }

  console.log("-------------------------------------------------------");
  console.log("analysisWorkerTotalJobs is ", analysisWorkerTotalJobs);
  console.log("analysisWorkerCompletedJobs is ", analysisWorkerCompletedJobs);
  console.log("-------------------------------------------------------");

  if (analysisWorkerCompletedJobs >= analysisWorkerTotalJobs) {
    const filesWithoutAnalysis = await prisma.file.findMany({
      where: {
        repositoryId,
        analysis: null,
      },
    });

    if (filesWithoutAnalysis.length > 0) {
      return;
    }

    console.log("-------------------------------------------------------");
    console.log(
      "Inside the if of analysisWorkerCompletedJobs >= analysisWorkerTotalJobs"
    );
    console.log("-------------------------------------------------------");

    await logQueue.add(
      QUEUES.LOG,
      {
        repositoryId,
        status: RepositoryStatus.PROCESSING,
        message:
          "🎉 Amazing! In-depth analysis completed for all files in your repository!",
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );

    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.SUCCESS },
    });

    await logQueue.add(
      QUEUES.LOG,
      {
        repositoryId,
        status: RepositoryStatus.SUCCESS,
        message:
          "✨ Success! Your repository has been fully processed and is ready to explore!",
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );
    await logQueue.add(
      QUEUES.LOG,
      {
        repositoryId,
        status: RepositoryStatus.PROCESSING,
        message: "⏳ Almost there! Redirecting you in a few seconds...",
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );
  }
}

export const analysisWorker = new Worker(
  QUEUES.ANALYSIS,
  async (job) => {
    const { repositoryId, file } = job.data;
    const isCancelled = await redisClient.get(
      getRepositoryCancelledRedisKey(repositoryId)
    );
    if (isCancelled === "true") {
      console.log(`❌ Analysis Worker for ${repositoryId} has been cancelled`);
      return;
    }
    const analysisSetKey = getAnalysisSetRedisKey(repositoryId);
    const isAlreadyProcessed = await redisClient.sismember(
      analysisSetKey,
      file.id
    );
    if (isAlreadyProcessed) {
      console.log("🚫 Skipping duplicate analysis for:", file.path);
      return;
    }
    await redisClient.sadd(analysisSetKey, file.id);
    const analysisWorkerCompletedJobsKey =
      getAnalysisWorkerCompletedJobsRedisKey(repositoryId);

    try {
      const analysis = await generateFileAnalysis(repositoryId, file);

      // console.log("analysis --analysisWorker is ", analysis);
      await prisma.file.update({
        where: {
          id: file.id,
        },
        data: {
          analysis,
        },
      });

      console.log("Generated File Analysis for ", file.path);

      await logQueue.add(
        QUEUES.LOG,
        {
          repositoryId,
          status: RepositoryStatus.PROCESSING,
          message: `⚙️ Analyzing ${file.path}`,
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
        }
      );

      await redisClient.incr(analysisWorkerCompletedJobsKey);
    } catch (error) {
      if (error instanceof Error) {
        console.log("---------------------------------");
        console.log("In Analysis Worker Catch Block");
        console.log("file.path is ", file.path);
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
        console.log("---------------------------------");
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
      await updateRepositoryStatus(repositoryId);
    }
  },
  {
    connection: redisClient,
    concurrency: ANALYSIS_WORKERS,
  }
);

analysisWorker.on("failed", (job, error) => {
  if (error instanceof Error) {
    console.log("error.stack is ", error.stack);
    console.log("error.message is ", error.message);
  }
  console.log("Error occurred in analysis worker");
});

analysisWorker.on("completed", () => {
  console.log("Analysis Worker completed successfully.");
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
