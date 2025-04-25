import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import redisClient from "../lib/redis.js";

export const logWorker = new Worker(
  QUEUES.LOG,
  async (job) => {
    const { repositoryId, message, status } = job.data;

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
