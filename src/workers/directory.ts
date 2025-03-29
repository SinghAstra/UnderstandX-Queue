import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { GitHubContent } from "../interfaces/github.js";
import {
  CONCURRENT_PROCESSING,
  FILE_BATCH_SIZE_FOR_AI_SHORT_SUMMARY,
  FILE_BATCH_SIZE_FOR_PRISMA_TRANSACTION,
  QUEUES,
} from "../lib/constants.js";
import { fetchGithubContent } from "../lib/github.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import {
  getDirectoryWorkerCompletedJobsRedisKey,
  getDirectoryWorkerTotalJobsRedisKey,
  getSummaryWorkerCompletedJobsRedisKey,
} from "../lib/redis-keys.js";
import redisClient from "../lib/redis.js";
import { directoryQueue, summaryQueue } from "../queues/repository.js";

let dirPath: string;

async function startSummaryWorker(repositoryId: string) {
  const directoryWorkerTotalJobsKey =
    getDirectoryWorkerTotalJobsRedisKey(repositoryId);
  const directoryWorkerCompletedJobsKey =
    getDirectoryWorkerCompletedJobsRedisKey(repositoryId);
  const summaryWorkerTotalJobsKey =
    getSummaryWorkerCompletedJobsRedisKey(repositoryId);

  const directoryWorkerCompletedJobs = await redisClient.get(
    directoryWorkerCompletedJobsKey
  );
  const directoryWorkerTotalJobs = await redisClient.get(
    directoryWorkerTotalJobsKey
  );

  console.log("-------------------------------------------------------");
  console.log("dirPath is ", dirPath);
  console.log("directoryWorkerCompletedJobs is ", directoryWorkerCompletedJobs);
  console.log("directoryWorkerTotalJobs is ", directoryWorkerTotalJobs);
  console.log("-------------------------------------------------------");

  if (directoryWorkerCompletedJobs === directoryWorkerTotalJobs) {
    console.log("-------------------------------------------------------");
    console.log(
      "Inside the if of directoryWorkerCompletedJobs === directoryWorkerTotalJobs"
    );
    console.log(`dirPath is ${dirPath}`);
    console.log("-------------------------------------------------------");

    // Notify user that summary generation is starting
    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.PROCESSING,
      message: "🔍 Now analyzing your files to create summaries...",
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

    redisClient.set(summaryWorkerTotalJobsKey, totalBatchesForShortSummary);

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
  }
}

export const directoryWorker = new Worker(
  QUEUES.DIRECTORY,
  async (job) => {
    const { owner, repo, repositoryId, path } = job.data;
    dirPath = path;
    const directoryWorkerTotalJobsKey =
      getDirectoryWorkerTotalJobsRedisKey(repositoryId);
    const directoryWorkerCompletedJobsKey =
      getDirectoryWorkerCompletedJobsRedisKey(repositoryId);
    const dirName = path ? path.split("/").pop() : "root";

    try {
      // Fetch only the current directory level (do NOT recurse)
      const items = await fetchGithubContent(owner, repo, path, repositoryId);

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `📂 Exploring the ${dirName} directory...`,
      });

      const directories = items.filter((item) => item.type === "dir");
      const files = items.filter((item) => item.type === "file");

      // Update the directory Worker Total Jobs
      redisClient.incrby(directoryWorkerTotalJobsKey, directories.length);

      // Check if Parent Directory exists
      const directory = await prisma.directory.findFirst({
        where: {
          repositoryId,
          path,
        },
      });
      const parentDirId = directory?.id || null;

      const createDirectory = directories.map((dir) => {
        return prisma.directory.create({
          data: {
            path: dir.path,
            repositoryId,
            parentId: parentDirId,
          },
        });
      });

      // Run everything inside a transaction to limit connections
      await prisma.$transaction(createDirectory);

      await processFilesInBatches(files, repositoryId, path, parentDirId);

      // Queue subdirectories for processing
      await Promise.all(
        directories.map(async (dir) => {
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
        message: `✅ Finished scanning the ${dirName} directory`,
      });

      await redisClient.incr(directoryWorkerCompletedJobsKey);

      return { status: "SUCCESS", processed: items.length };
    } catch (error) {
      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }

      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: RepositoryStatus.FAILED },
      });

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.FAILED,
        message: `❌ Oops! We couldn't process the ${dirName} directory. Please try again later.`,
      });
    } finally {
      // Check if processing is complete
      await startSummaryWorker(repositoryId);
    }
  },
  {
    connection: redisClient,
    concurrency: CONCURRENT_PROCESSING,
  }
);

async function processFilesInBatches(
  files: GitHubContent[],
  repositoryId: string,
  currentPath: string,
  directoryId: string | null
) {
  let dirName = currentPath.split("/").pop();
  dirName = dirName ? dirName : "root";
  try {
    const fileCount = files.length;

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.PROCESSING,
      message: `📄 Processing ${fileCount} ${
        fileCount === 1 ? "file" : "files"
      } in ${dirName}...`,
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

      console.log("Files saved in database", createdFiles.length);

      const currentBatch = i + 1;
      const totalBatches = fileBatches.length;
      const progress = Math.round((currentBatch / totalBatches) * 100);

      await sendProcessingUpdate(repositoryId, {
        status: RepositoryStatus.PROCESSING,
        message: `⏳ Saving files in ${dirName}: ${progress}% complete`,
      });
    }

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.PROCESSING,
      message: `🎉 Successfully processed all ${files.length} ${
        files.length === 1 ? "file" : "files"
      } in ${dirName}!`,
    });
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }

    await sendProcessingUpdate(repositoryId, {
      status: RepositoryStatus.FAILED,
      message: `❌ Unable to process files in ${dirName}. We're looking into this issue.`,
    });

    throw error;
  }
}

directoryWorker.on("failed", (job, error) => {
  if (error instanceof Error) {
    console.log("error.stack is ", error.stack);
    console.log("error.message is ", error.message);
  }
  console.log("Error occurred in directory worker");
});

directoryWorker.on("completed", async (job) => {
  console.log("Directory Worker completed successfully.");
});

// Gracefully shutdown Prisma when worker exits
const shutdown = async () => {
  console.log("Shutting down worker gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
