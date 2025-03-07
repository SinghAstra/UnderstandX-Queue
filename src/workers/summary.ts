import { Worker } from "bullmq";
import { QUEUES } from "../lib/constants.js";
import { generateBatchSummaries } from "../lib/gemini.js";
import { prisma } from "../lib/prisma.js";

export const summaryWorker = new Worker(
  QUEUES.SUMMARY,
  async (job) => {
    const { repositoryId, files } = job.data;

    try {
      // Generate summaries for this batch
      const summaries = await generateBatchSummaries(files);

      // Update the database with these summaries
      await prisma.$transaction(
        summaries.map((summary: { id: string; summary: string }) =>
          prisma.file.update({
            where: { id: summary.id },
            data: { shortSummary: summary.summary },
          })
        )
      );

      // Update progress
      await redisConnection.incr(`summary_jobs_completed:${repositoryId}`);

      // Notify frontend of progress
      await sendProcessingUpdate(repositoryId, {
        id: uuidv4(),
        timestamp: new Date(),
        status: RepositoryStatus.PROCESSING,
        message: `Generated summaries for batch ${batchNumber} of ${totalBatches}`,
      });

      return { status: "SUCCESS", processed: files.length };
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Summary worker error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Unknown summary worker error: ${error}`);
      }

      // Still increment the counter to avoid deadlocks
      await redisConnection.incr(`summary_jobs_completed:${repositoryId}`);

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 5, // Set parallel processing with max 5 concurrent jobs
  }
);
