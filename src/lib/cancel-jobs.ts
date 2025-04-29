import { Queue } from "bullmq";
import {
  analysisQueue,
  directoryQueue,
  logQueue,
  summaryQueue,
} from "../queues/index.js";

export async function cancelAllRepositoryJobs(repositoryId: string) {
  // 1. Fetch all waiting/delayed/active jobs in directoryQueue
  const directoryJobs = await directoryQueue.getJobs(["waiting", "delayed"]);
  console.log("📁 directoryJobs.length is", directoryJobs.length);

  for (const job of directoryJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 2. Repeat same for summaryQueue
  const summaryJobs = await summaryQueue.getJobs(["waiting", "delayed"]);
  console.log("📄 summaryJobs.length is", summaryJobs.length);

  for (const job of summaryJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 3. Repeat for analysisQueue
  const analysisJobs = await analysisQueue.getJobs(["waiting", "delayed"]);
  console.log("📄 analysisJobs.length is", analysisJobs.length);

  for (const job of analysisJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  console.log(`✅ Cancelled all jobs for repositoryId: ${repositoryId}`);
}

export async function cancelAllJobs(repositoryId: string) {
  // 1. Fetch all waiting/delayed/active jobs in directoryQueue
  const directoryJobs = await directoryQueue.getJobs(["waiting", "delayed"]);
  console.log("📁 directoryJobs.length is", directoryJobs.length);

  for (const job of directoryJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 2. Repeat same for summaryQueue
  const summaryJobs = await summaryQueue.getJobs(["waiting", "delayed"]);
  console.log("📄 summaryJobs.length is", summaryJobs.length);
  for (const job of summaryJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 3. Repeat for analysisQueue
  const analysisJobs = await analysisQueue.getJobs(["waiting", "delayed"]);
  console.log("📄 analysisJobs.length is", analysisJobs.length);

  for (const job of analysisJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  // 4. Repeat for logQueue
  const logJobs = await logQueue.getJobs(["waiting", "delayed"]);
  console.log("📜 logJobs.length is", logJobs.length);
  for (const job of logJobs) {
    if (job.data.repositoryId === repositoryId) {
      await job.remove();
    }
  }

  console.log(`✅ Cancelled all jobs for repositoryId: ${repositoryId}`);
}
