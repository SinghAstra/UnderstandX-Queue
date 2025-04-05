import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import { generateFileAnalysis } from "../lib/gemini.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";

import {
  getAnalysisWorkerCompletedJobsRedisKey,
  getAnalysisWorkerTotalJobsRedisKey,
} from "../lib/redis-keys.js";
import redisClient from "../lib/redis.js";

async function updateRepositoryStatus(repositoryId: string) {
  const analysisWorkerTotalJobsKey =
    getAnalysisWorkerTotalJobsRedisKey(repositoryId);
  const analysisWorkerCompletedJobsKey =
    getAnalysisWorkerCompletedJobsRedisKey(repositoryId);

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
      "Inside the if of analysisWorkerCompletedJobs === analysisWorkerTotalJobs"
    );
    console.log("-------------------------------------------------------");

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.PROCESSING,
      message:
        "🎉Amazing! In-depth analysis completed for all files in your repository!",
    });

    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.SUCCESS },
    });

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.SUCCESS,
      message:
        "✨Success! Your repository has been fully processed and is ready to explore!",
    });

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.SUCCESS,
      message: "⏳Almost there! Redirecting you in a few seconds...",
    });
  }
}

export const analysisWorker = new Worker(
  QUEUES.ANALYSIS,
  async (job) => {
    const { repositoryId, file } = job.data;
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

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `🔎Analyzing ${file.path}`,
      });
      await redisClient.incr(analysisWorkerCompletedJobsKey);
    } catch (error) {
      if (error instanceof Error) {
        console.log("---------------------------------");
        console.log("In Analysis Worker Catch Block");
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
        console.log("---------------------------------");
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.FAILED,
        message: `⚠️Oops! We hit a snag while analyzing "${file.path}". Please try again later. `,
      });
    } finally {
      await updateRepositoryStatus(repositoryId);
    }
  },
  {
    connection: redisClient,
    concurrency: 5,
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
