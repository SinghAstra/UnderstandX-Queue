import { RepositoryStatus } from "@prisma/client";
import { Worker } from "bullmq";
import { execPath } from "node:process";
import { v4 as uuidv4 } from "uuid";
import { GitHubContent } from "../interfaces/github.js";
import {
  CONCURRENT_PROCESSING,
  FILE_BATCH_SIZE_FOR_AI_ANALYSIS,
  FILE_BATCH_SIZE_FOR_AI_SHORT_SUMMARY,
  FILE_BATCH_SIZE_FOR_PRISMA_TRANSACTION,
  QUEUES,
} from "../lib/constants.js";
import {
  generateBatchAnalysis,
  generateBatchSummaries,
  getRepositoryOverview,
  ParsedAnalysis,
} from "../lib/gemini.js";
import { fetchGithubContent } from "../lib/github.js";
import logger from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendProcessingUpdate } from "../lib/pusher/send-update.js";
import { default as redisConnection } from "../lib/redis.js";
import { directoryQueue } from "../queues/repository.js";

// Redis key prefixes for counters
const ACTIVE_JOBS_KEY = "repository:active_jobs:";
export const PENDING_JOBS_KEY = "repository:pending_jobs:";

let dirPath: string;

async function updateRepositoryStatus(repositoryId: string) {
  const activeJobsKey = ACTIVE_JOBS_KEY + repositoryId;
  const pendingJobsKey = PENDING_JOBS_KEY + repositoryId;

  const activeJobs = await redisConnection.get(activeJobsKey);
  const pendingJobs = await redisConnection.get(pendingJobsKey);

  const activeCount = parseInt(activeJobs || "0");
  const pendingCount = parseInt(pendingJobs || "0");

  console.log("-------------------------------------------------------");
  console.log("dirPath is ", dirPath);
  console.log("activeCount is ", activeCount);
  console.log("pendingCount is ", pendingCount);
  console.log("-------------------------------------------------------");

  // If no jobs are running or pending, mark as success
  if (activeCount === 0 && pendingCount === 0) {
    logger.info("-------------------------------------------------------");
    logger.info("Inside the if of activeCount===0 && pendingCount===0");
    logger.info(`dirPath is ${dirPath}`);
    logger.info("-------------------------------------------------------");

    // Notify user that summary generation is starting
    await sendProcessingUpdate(repositoryId, {
      id: uuidv4(),
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
    for (
      let i = 0;
      i < filesWithoutSummary.length;
      i += batchSizeForShortSummary
    ) {
      const fileWithoutSummaryBatch = filesWithoutSummary.slice(
        i,
        i + batchSizeForShortSummary
      );

      const summaries = await generateBatchSummaries(fileWithoutSummaryBatch);
      await prisma.$transaction(
        summaries.map((summary: { id: string; summary: string }) =>
          prisma.file.update({
            where: { id: summary.id },
            data: { shortSummary: summary.summary },
          })
        )
      );

      await sendProcessingUpdate(repositoryId, {
        id: uuidv4(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Generated summaries for batch ${Math.ceil(
          (i + batchSizeForShortSummary) / batchSizeForShortSummary
        )} of ${Math.ceil(
          filesWithoutSummary.length / batchSizeForShortSummary
        )}`,
      });
    }

    const repoOverview = await getRepositoryOverview(repositoryId);
    const filesWithoutAnalysis = await prisma.file.findMany({
      where: { repositoryId, analysis: null },
      select: { id: true, path: true, content: true },
    });

    const batchSizeForAnalysis = FILE_BATCH_SIZE_FOR_AI_ANALYSIS;
    for (
      let i = 0;
      i < filesWithoutAnalysis.length;
      i += batchSizeForAnalysis
    ) {
      const filesWithoutAnalysisBatch = filesWithoutAnalysis.slice(
        i,
        i + batchSizeForAnalysis
      );

      const analyses: ParsedAnalysis[] = await generateBatchAnalysis(
        repositoryId,
        filesWithoutAnalysisBatch,
        repoOverview
      );

      await prisma.$transaction(
        analyses.map((analysis) => {
          return prisma.file.update({
            where: { id: analysis.id },
            data: { analysis: analysis.analysis },
          });
        })
      );

      await sendProcessingUpdate(repositoryId, {
        id: uuidv4(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Generated Analysis for batch ${Math.ceil(
          (i + batchSizeForAnalysis) / batchSizeForAnalysis
        )} of ${Math.ceil(filesWithoutAnalysis.length / batchSizeForAnalysis)}`,
      });
    }

    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: RepositoryStatus.SUCCESS, overview: repoOverview },
    });

    await sendProcessingUpdate(repositoryId, {
      id: uuidv4(),
      timestamp: new Date(),
      status: RepositoryStatus.SUCCESS,
      message: "Please Wait For Few more seconds ...",
    });

    await sendProcessingUpdate(repositoryId, {
      id: uuidv4(),
      timestamp: new Date(),
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
    dirPath = path;
    const activeJobsKey = ACTIVE_JOBS_KEY + repositoryId;
    const pendingJobsKey = PENDING_JOBS_KEY + repositoryId;

    try {
      // Decrement pending jobs and increment active jobs
      await redisConnection.decr(pendingJobsKey);
      await redisConnection.incr(activeJobsKey);

      // Fetch only the current directory level (do NOT recurse)
      const items = await fetchGithubContent(owner, repo, path, repositoryId);

      // Notify frontend that this directory is being processed
      await sendProcessingUpdate(repositoryId, {
        id: uuidv4(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Processing directory: ${path || "root"}`,
      });

      const directories = items.filter((item) => item.type === "dir");
      const files = items.filter((item) => item.type === "file");

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
            // Increment pending counter after successful queue
            await redisConnection.incr(pendingJobsKey);
          } catch (error) {
            // If queuing fails, we need to adjust the pending counter
            throw error;
          }
        })
      );

      // Notify user that this directory is fully processed
      await sendProcessingUpdate(repositoryId, {
        id: uuidv4(),
        timestamp: new Date(),
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
        id: uuidv4(),
        timestamp: new Date(),
        status: RepositoryStatus.FAILED,
        message: `Failed to process directory: ${path || "root"}`,
      });
    } finally {
      // Decrement active jobs counter
      await redisConnection.decr(activeJobsKey);

      // Check if processing is complete
      await updateRepositoryStatus(repositoryId);
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
      id: uuidv4(),
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
        id: uuidv4(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Saved batch ${i + 1}/${fileBatches.length} (${
          batch.length
        } files) for ${currentPath || "root"}`,
      });
    }

    await sendProcessingUpdate(repositoryId, {
      id: uuidv4(),
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
      id: uuidv4(),
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
