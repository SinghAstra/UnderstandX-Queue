import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { v4 as uuid } from "uuid";
import { GitHubContent } from "../interfaces/github.js";
import {
  CONCURRENT_PROCESSING,
  FILE_BATCH_SIZE_FOR_AI_SHORT_SUMMARY,
  FILE_BATCH_SIZE_FOR_PRISMA_TRANSACTION,
  QUEUES,
} from "../lib/constants.js";
import { fetchGithubContent } from "../lib/github.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import {
  directoryWorkerCompletedJobsRedisKey,
  directoryWorkerTotalJobsRedisKey,
  summaryWorkerCompletedJobsRedisKey,
  summaryWorkerTotalJobsRedisKey,
} from "../lib/redis-keys.js";
import { default as redisConnection } from "../lib/redis.js";
import { directoryQueue, summaryQueue } from "../queues/repository.js";

let dirPath: string;

async function startSummaryWorker(repositoryId: string) {
  const directoryWorkerTotalJobsKey =
    directoryWorkerTotalJobsRedisKey + repositoryId;

  const directoryWorkerCompletedJobsKey =
    directoryWorkerCompletedJobsRedisKey + repositoryId;

  const summaryWorkerTotalJobsKey =
    summaryWorkerTotalJobsRedisKey + repositoryId;

  const summaryWorkerCompletedJobsKey =
    summaryWorkerCompletedJobsRedisKey + repositoryId;

  const directoryWorkerCompletedJobs = await redisConnection.get(
    directoryWorkerCompletedJobsKey
  );
  const directoryWorkerTotalJobs = await redisConnection.get(
    directoryWorkerTotalJobsKey
  );

  console.log("-------------------------------------------------------");
  console.log("dirPath is ", dirPath);
  console.log("directoryWorkerCompletedJobs is ", directoryWorkerCompletedJobs);
  console.log("directoryWorkerTotalJobs is ", directoryWorkerTotalJobs);
  console.log("-------------------------------------------------------");

  if (directoryWorkerCompletedJobs === directoryWorkerTotalJobs) {
    logger.info("-------------------------------------------------------");
    logger.info(
      "Inside the if of directoryWorkerCompletedJobs === directoryWorkerTotalJobs"
    );
    logger.info(`dirPath is ${dirPath}`);
    logger.info("-------------------------------------------------------");

    // Notify user that summary generation is starting
    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.PROCESSING,
      message: "Starting to generate file summaries...",
    });

    // Fetch the Files of the repository that do not have short summary
    const filesWithoutSummary = await prisma.file.findMany({
      where: { repositoryId, shortSummary: null },
      select: { id: true, path: true, content: true },
    });

    const batchSizeForShortSummary = FILE_BATCH_SIZE_FOR_AI_SHORT_SUMMARY;
    const totalBatchesForShortSummary = Math.ceil(
      filesWithoutSummary.length / batchSizeForShortSummary
    );

    redisConnection.set(summaryWorkerTotalJobsKey, totalBatchesForShortSummary);
    redisConnection.set(summaryWorkerCompletedJobsKey, 0);

    for (
      let i = 0;
      i < filesWithoutSummary.length;
      i += batchSizeForShortSummary
    ) {
      const fileWithoutSummaryBatch = filesWithoutSummary.slice(
        i,
        i + batchSizeForShortSummary
      );

      await summaryQueue.add(QUEUES.SUMMARY, {
        repositoryId,
        files: fileWithoutSummaryBatch,
      });
    }

    await redisConnection.del(directoryWorkerCompletedJobsKey);
    await redisConnection.del(directoryWorkerTotalJobsKey);
  }
}

export const directoryWorker = new Worker(
  QUEUES.DIRECTORY,
  async (job) => {
    const { owner, repo, repositoryId, path } = job.data;
    dirPath = path;
    const directoryWorkerTotalJobsKey =
      directoryWorkerTotalJobsRedisKey + repositoryId;

    const directoryWorkerCompletedJobsKey =
      directoryWorkerCompletedJobsRedisKey + repositoryId;

    try {
      // Fetch only the current directory level (do NOT recurse)
      const items = await fetchGithubContent(owner, repo, path, repositoryId);

      // Notify frontend that this directory is being processed
      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Processing directory: ${path || "root"}`,
      });

      const directories = items.filter((item) => item.type === "dir");
      const files = items.filter((item) => item.type === "file");

      // Update the directory Worker Total Jobs
      redisConnection.incrby(directoryWorkerTotalJobsKey, directories.length);

      const directory = await prisma.directory.findFirst({
        where: {
          repositoryId,
          path,
        },
      });
      const parentDirId = directory?.id || null;

      // Save directories in parallel
      const directoryData = directories.map((dir) => {
        return prisma.directory.create({
          data: {
            path: dir.path,
            repositoryId,
            parentId: parentDirId,
          },
        });
      });

      // Run everything inside a transaction to limit connections
      await prisma.$transaction(directoryData);

      await processFilesInBatches(files, repositoryId, path, parentDirId);

      // Queue subdirectories for processing
      await Promise.all(
        directories.map(async (dir) => {
          try {
            await directoryQueue.add("process-directory", {
              owner,
              repo,
              repositoryId,
              path: dir.path,
            });
          } catch (error) {
            // If queuing fails, we need to adjust the pending counter
            throw error;
          }
        })
      );

      // Notify user that this directory is fully processed
      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Finished processing directory: ${path || "root"}`,
      });

      await redisConnection.incr(directoryWorkerCompletedJobsKey);

      return { status: "SUCCESS", processed: items.length };
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Directory worker error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Unknown directory worker error: ${error}`);
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

      // Notify user about failure
      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.FAILED,
        message: `Failed to process directory: ${path || "root"}`,
      });
    } finally {
      // Check if processing is complete
      await startSummaryWorker(repositoryId);
    }
  },
  {
    connection: redisConnection,
    concurrency: CONCURRENT_PROCESSING,
  }
);

async function processFilesInBatches(
  files: GitHubContent[],
  repositoryId: string,
  currentPath: string,
  directoryId: string | null
) {
  try {
    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.PROCESSING,
      message: `Processing ${files.length} files in batches for ${
        currentPath || "root"
      }`,
    });

    const fileBatches = [];
    for (
      let i = 0;
      i < files.length;
      i += FILE_BATCH_SIZE_FOR_PRISMA_TRANSACTION
    ) {
      fileBatches.push(
        files.slice(i, i + FILE_BATCH_SIZE_FOR_PRISMA_TRANSACTION)
      );
    }

    for (let i = 0; i < fileBatches.length; i++) {
      const batch = fileBatches[i];

      const createdFiles = await prisma.$transaction(
        batch.map((file) =>
          prisma.file.create({
            data: {
              path: file.path,
              name: file.name,
              content: file.content || "",
              repositoryId,
              directoryId,
            },
          })
        )
      );

      logger.info(`createdFiles.length is ${createdFiles.length}`);

      await sendProcessingUpdate(repositoryId, {
        id: uuid(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Saved batch ${i + 1}/${fileBatches.length} (${
          batch.length
        } files) for ${currentPath || "root"}`,
      });
    }

    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.PROCESSING,
      message: `Finished processing ${files.length} files in ${
        currentPath || "root"
      }.`,
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`handleLargeFileSet error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
    } else {
      logger.error(`Unknown handleLargeFileSet error: ${error}`);
    }

    await sendProcessingUpdate(repositoryId, {
      id: uuid(),
      timestamp: new Date(),
      status: RepositoryStatus.FAILED,
      message: `Failed to save files in ${
        currentPath || "root"
      } --handleLargeFileSet`,
    });

    throw error;
  }
}

directoryWorker.on("failed", (job, error) => {
  const { path } = job?.data;
  logger.error(`Directory at  ${path} processing failed.`);
});

directoryWorker.on("completed", async (job) => {
  const { path } = job.data;
  logger.success(`Directory at  ${path} processing completed.`);
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
