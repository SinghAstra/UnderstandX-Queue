export const QUEUES = {
  REPOSITORY: "repository-queue",
  DIRECTORY: "directory-queue",
  SUMMARY: "summary-queue",
  ANALYSIS: "analysis-queue",
  LOG: "log-queue",
};

export const FILE_BATCH_SIZE_FOR_PRISMA_TRANSACTION = 50;
export const CONCURRENT_WORKERS = 5;
export const ANALYSIS_WORKERS = 3;
export const FILE_BATCH_SIZE_FOR_AI_SHORT_SUMMARY = 10;
export const FILE_BATCH_SIZE_FOR_AI_ANALYSIS = 2;
