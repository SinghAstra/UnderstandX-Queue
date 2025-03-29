import { RepositoryStatus } from "@prisma/client";

export interface ProcessingUpdate {
  status: RepositoryStatus;
  message: string;
}
