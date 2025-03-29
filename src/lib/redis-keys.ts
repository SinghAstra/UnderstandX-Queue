export const analysisWorkerTotalJobsRedisKey = "analysisWorkerTotalJobs:";
export const analysisWorkerCompletedJobsRedisKey =
  "analysisWorkerCompletedJobs:";

export function getDirectoryWorkerTotalJobsRedisKey(repositoryId: string) {
  return `${repositoryId}:directoryWorkerTotalJobs`;
}

export function getDirectoryWorkerCompletedJobsRedisKey(repositoryId: string) {
  return `${repositoryId}:directoryWorkerCompletedJobs`;
}

export function getSummaryWorkerTotalJobsRedisKey(repositoryId: string) {
  return `${repositoryId}:summaryWorkerTotalJobs`;
}

export function getSummaryWorkerCompletedJobsRedisKey(repositoryId: string) {
  return `${repositoryId}:summaryWorkerCompletedJobs`;
}
