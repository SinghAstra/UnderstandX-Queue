import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import redisConnection from "../lib/redis.js";

export const analysisWorker = new Worker(
  QUEUES.ANALYSIS,
  async (job) => {
    const { repositoryId, file } = job.data;
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

// await prisma.repository.update({
//     where: { id: repositoryId },
//     data: { status: RepositoryStatus.SUCCESS },
//   });

//   await sendProcessingUpdate(repositoryId, {
//     id: uuid(),
//     timestamp: new Date(),
//     status: RepositoryStatus.SUCCESS,
//     message: "Please Wait For Few more seconds ...",
//   });

//   await sendProcessingUpdate(repositoryId, {
//     id: uuid(),
//     timestamp: new Date(),
//     status: RepositoryStatus.SUCCESS,
//     message: "Repository processing completed",
//   });
