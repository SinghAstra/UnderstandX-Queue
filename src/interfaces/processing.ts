import { RepositoryStatus } from "@prisma/client";

export interface ProcessingUpdate {
  id: string;
  timestamp: Date;
  status: RepositoryStatus;
  message: string;
}
