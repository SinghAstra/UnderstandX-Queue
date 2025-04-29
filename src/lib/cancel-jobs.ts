import { Queue } from "bullmq";
import {
  analysisQueue,
  directoryQueue,
  logQueue,
  summaryQueue,
} from "../queues/index.js";

export async function cancelAllRepositoryJobs(repositoryId: string) {
  // 1. Fetch all waiting/delayed/active jobs in directoryQueue
  const directoryJobs = await directoryQueue.getJobs([
    "waiting",
    "active",
    "delayed",
  ]);

  for (const job of directoryJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 2. Repeat same for summaryQueue
  const summaryJobs = await summaryQueue.getJobs([
    "waiting",
    "active",
    "delayed",
  ]);
  for (const job of summaryJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 3. Repeat for analysisQueue
  const analysisJobs = await analysisQueue.getJobs([
    "waiting",
    "active",
    "delayed",
  ]);
  for (const job of analysisJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  console.log(`✅ Cancelled all jobs for repositoryId: ${repositoryId}`);
}
