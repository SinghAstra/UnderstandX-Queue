import { Queue } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import redisClient from "../lib/redis/redis.js";

export const repositoryQueue = new Queue(QUEUES.REPOSITORY, {
  connection: redisClient,
});

export const directoryQueue = new Queue(QUEUES.DIRECTORY, {
  connection: redisClient,
});

export const summaryQueue = new Queue(QUEUES.SUMMARY, {
  connection: redisClient,
});

export const analysisQueue = new Queue(QUEUES.ANALYSIS, {
  connection: redisClient,
});

export const logQueue = new Queue(QUEUES.LOG, {
  connection: redisClient,
});
