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

export const directoryWorker = new Worker(
  QUEUES.DIRECTORY,
  async (job) => {
    const { owner, repo, repositoryId, path } = job.data;

    try {
      // Fetch only the current directory level (do NOT recurse)
      const items = await fetchGithubContent(owner, repo, path, repositoryId);

      // Notify frontend that this directory is being processed
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Processing directory: ${path || "root"}`,
      });

      const directories = items.filter((item) => item.type === "dir");
      const files = items.filter((item) => item.type === "file");

      // const parentPath = dir.path.split("/").slice(0, -1).join("/");
      const directory = await prisma.directory.findFirst({
        where: {
          repositoryId,
          path,
        },
      });
      const parentDirId = directory?.id || null;
      console.log(
        "parentDirId is ",
        parentDirId,
        "path is ",
        path === "" ? "ROOT" : path,
        "parentDirId: ",
        parentDirId
      );

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
      const createdDirectories = await prisma.$transaction(directoryData);
      console.log(
        "createdDirectories: ",
        createdDirectories,
        "path is ",
        path === "" ? "ROOT" : path,
        "parentDirId: ",
        parentDirId
      );

      await processFilesInBatches(files, repositoryId, path, parentDirId);

      // Queue subdirectories for processing
      await Promise.all(
        directories.map(async (dir) => {
          await redisConnection.incr(`repo:${repositoryId}:pending_jobs`);
          await directoryQueue.add("process-directory", {
            owner,
            repo,
            repositoryId,
            path: dir.path,
          });
        })
      );

      // Notify user that this directory is fully processed
      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `Finished processing directory: ${path || "root"}`,
      });

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

  // Decrement the job counter
  const remainingJobs = await redisConnection.decr(
    `repo:${repositoryId}:pending_jobs`
  );

  // Fetch the current repository status
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { status: true },
  });

  if (
    remainingJobs === 0 &&
    repository?.status === RepositoryStatus.PROCESSING
  ) {
    // Mark repository as successfully processed
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.SUCCESS },
    });

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.SUCCESS,
      message: `All directories and files have been processed.`,
    });

    logger.success(`Repository ${repositoryId} processing completed.`);
  } else {
    logger.info(
      `Job ${job.id} completed. Remaining jobs: ${remainingJobs}, Repo Status: ${repository?.status}`
    );
  }
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
