import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { GitHubContent } from "../interfaces/github.js";
import {
  CONCURRENT_PROCESSING,
  FILE_BATCH_SIZE,
  QUEUES,
} from "../lib/constants.js";
import { fetchGithubContent } from "../lib/github.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import { default as redisConnection } from "../lib/redis.js";
import { directoryQueue } from "../queues/repository.js";

// Redis key prefixes for counters
const ACTIVE_JOBS_KEY = "repository:active_jobs:";
const PENDING_JOBS_KEY = "repository:pending_jobs:";

async function updateRepositoryStatus(repositoryId: string) {
  const activeJobsKey = ACTIVE_JOBS_KEY + repositoryId;
  const pendingJobsKey = PENDING_JOBS_KEY + repositoryId;

  const activeJobs = await redisConnection.get(activeJobsKey);
  const pendingJobs = await redisConnection.get(pendingJobsKey);

  const activeCount = parseInt(activeJobs || "0");
  const pendingCount = parseInt(pendingJobs || "0");

  // If no jobs are running or pending, mark as success
  if (activeCount === 0 && pendingCount === 0) {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.SUCCESS },
    });

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.SUCCESS,
      message: "Repository processing completed",
    });

    await redisConnection.del(activeJobsKey);
    await redisConnection.del(pendingJobsKey);
  }
}

export const directoryWorker = new Worker(
  QUEUES.DIRECTORY,
  async (job) => {
    const { owner, repo, repositoryId, path } = job.data;
    const activeJobsKey = ACTIVE_JOBS_KEY + repositoryId;
    const pendingJobsKey = PENDING_JOBS_KEY + repositoryId;

    try {
      // Increment active jobs counter
      await redisConnection.incr(activeJobsKey);

      // Fetch only the current directory level (do NOT recurse)
      const items = await fetchGithubContent(owner, repo, path, repositoryId);

      // Notify frontend that this directory is being processed
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Processing directory: ${path || "root"}`,
      });

      const directories = items.filter((item) => item.type === "dir");
      const files = items.filter((item) => item.type === "file");

      // Increment pending jobs counter for discovered directories
      if (directories.length > 0) {
        await redisConnection.incrby(pendingJobsKey, directories.length);
      }

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
            // Decrement pending counter after successful queue
            await redisConnection.decr(pendingJobsKey);
          } catch (error) {
            // If queuing fails, we need to adjust the pending counter
            throw error;
          }
        })
      );

      // Notify user that this directory is fully processed
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Finished processing directory: ${path || "root"}`,
      });

      // Decrement active jobs counter
      await redisConnection.decr(activeJobsKey);

      // Check if processing is complete
      await updateRepositoryStatus(repositoryId);

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
        status: RepositoryStatus.FAILED,
        message: `Failed to process directory: ${path || "root"}`,
      });
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
  console.log("directoryId --processFilesInBatches is ", directoryId);
  try {
    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.PROCESSING,
      message: `Processing ${files.length} files in batches for ${
        currentPath || "root"
      }`,
    });

    const fileBatches = [];
    for (let i = 0; i < files.length; i += FILE_BATCH_SIZE) {
      fileBatches.push(files.slice(i, i + FILE_BATCH_SIZE));
    }

    // logger.info(`Total file batches: ${fileBatches.length}`);

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

      const parsedCreatedFiles = createdFiles.map((createdFile) => {
        return {
          id: createdFile.id,
          path: createdFile.path,
          name: createdFile.name,
          directoryId: createdFile.directoryId,
          repositoryId: createdFile.repositoryId,
        };
      });

      console.log(
        "parsedCreatedFiles is ",
        parsedCreatedFiles,
        "path is ",
        currentPath === "" ? "ROOT" : currentPath,
        "parentDirId: ",
        directoryId
      );

      // logger.info(
      //   `Saved batch ${i + 1}/${fileBatches.length} (${batch.length} files)`
      // );
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Saved batch ${i + 1}/${fileBatches.length} (${
          batch.length
        } files) for ${currentPath || "root"}`,
      });
    }

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.SUCCESS,
      message: `Finished processing ${files.length} files in ${
        currentPath || "root"
      }`,
    });

    // logger.success(
    //   `Successfully saved all ${files.length} files in batches for ${
    //     currentPath || "root"
    //   }`
    // );
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`handleLargeFileSet error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
    } else {
      logger.error(`Unknown handleLargeFileSet error: ${error}`);
    }

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.FAILED,
      message: `Failed to save files in ${
        currentPath || "root"
      } --handleLargeFileSet`,
    });

    throw error;
  }
}

directoryWorker.on("failed", (job, error) => {
  logger.error(
    `Job ${job?.id} in ${QUEUES.DIRECTORY} queue failed with error: ${error.message}`
  );
});

directoryWorker.on("completed", async (job) => {
  const { repositoryId } = job.data;
  logger.success(`Repository ${repositoryId} processing completed.`);
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
