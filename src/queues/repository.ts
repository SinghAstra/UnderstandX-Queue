import { Queue } from "bullmq";
import connection from "../config/redis";
import { QUEUES } from "../lib/constants";

export const repositoryQueue = new Queue(QUEUES.REPOSITORY, {
  connection,
});
export const directoryQueue = new Queue(QUEUES.DIRECTORY, { connection });
export const fileBatchQueue = new Queue(QUEUES.FILE_BATCH, { connection });
