import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import redisClient from "../lib/redis.js";
import { logQueue } from "../queues/repository.js";

export const criticalLogWorker = new Worker(
  QUEUES.CRITICAL_LOG,
  async (job) => {
    const { repositoryId, message, status } = job.data;

    const jobs = await logQueue.getJobs(["waiting", "delayed"]);
    for (const job of jobs) {
      if (job.data.repositoryId === repositoryId) {
        await job.remove();
      }
    }

    console.log("logWorker repositoryId is ", repositoryId);

    const log = await prisma.log.create({
      data: {
        repositoryId,
        message,
        status,
      },
    });

    await sendProcessingUpdate(repositoryId, log);
  },
  {
    connection: redisClient,
    concurrency: 1,
  }
);
