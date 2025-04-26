import { Queue } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import connection from "../lib/redis.js";

export const repositoryQueue = new Queue(QUEUES.REPOSITORY, {
  connection,
});

export const directoryQueue = new Queue(QUEUES.DIRECTORY, { connection });

export const summaryQueue = new Queue(QUEUES.SUMMARY, {
  connection,
});

export const analysisQueue = new Queue(QUEUES.ANALYSIS, {
  connection,
});

export const logQueue = new Queue(QUEUES.LOG, {
  connection,
});

export const criticalLogQueue = new Queue(QUEUES.CRITICAL_LOG, {
  connection,
});
