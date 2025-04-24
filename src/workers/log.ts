import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import redisClient from "../lib/redis.js";

export const logWorker = new Worker(
  QUEUES.LOG,
  async (job) => {
    const { repositoryId, message, status } = job.data;

    await sendProcessingUpdate(repositoryId, {
      status,
      message,
    });

    await prisma.log.create({
      data: {
        repositoryId,
        message,
      },
    });
  },
  {
    connection: redisClient,
    concurrency: 1,
  }
);
