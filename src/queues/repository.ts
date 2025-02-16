import { Queue } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import connection from "../lib/redis.js";

export const repositoryQueue = new Queue(QUEUES.REPOSITORY, {
  connection,
});
export const directoryQueue = new Queue(QUEUES.DIRECTORY, { connection });
export const fileBatchQueue = new Queue(QUEUES.FILE_BATCH, { connection });
