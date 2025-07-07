import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { CONCURRENT_WORKERS, QUEUES } from "../lib/constants.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import { getRepositoryCancelledRedisKey } from "../lib/redis/redis-keys.js";
import redisClient from "../lib/redis/redis.js";
import { cancelAllRepositoryJobs } from "../queues/cancel-jobs.js";

export const logWorker = new Worker(
  QUEUES.LOG,
  async (job) => {
    const { repositoryId, message, status } = job.data;

    const isCancelled = await redisClient.get(
      getRepositoryCancelledRedisKey(repositoryId)
    );
    if (isCancelled === "true") {
      console.log(`❌ Log Worker for ${repositoryId} has been cancelled`);
      return;
    }

    const log = await prisma.log.create({
      data: {
        repositoryId,
        message,
        status,
      },
    });

    await sendProcessingUpdate(repositoryId, log);

    if (status === RepositoryStatus.FAILED) {
      console.log("--------------------------------------------------------");
      console.log(
        "logWorker status is FAILED, cancelling all jobs for repositoryId: ",
        repositoryId
      );
      console.log("--------------------------------------------------------");
      await cancelAllRepositoryJobs(repositoryId);
    }
  },
  {
    connection: redisClient,
    concurrency: CONCURRENT_WORKERS,
  }
);
