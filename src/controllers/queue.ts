import { RepositoryStatus } from "@prisma/client";
import { Request, Response } from "express";
import { QUEUES } from "../lib/constants.js";
import { parseGithubUrl } from "../lib/github.js";
import { logQueue, repositoryQueue } from "../queues/repository.js";

export const addJobToRepositoryQueue = async (req: Request, res: Response) => {
  try {
    const { repositoryId, userId, githubUrl } = req.body.auth;
    const { repo } = parseGithubUrl(githubUrl);
    console.log("req.body.auth --addJobToRepositoryQueue is ", req.body.auth);

    await logQueue.add(
      QUEUES.LOG,
      {
        status: RepositoryStatus.PROCESSING,
        message: `📥 Downloading repository: ${repo}... `,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );

    // Add job to the repository queue
    await repositoryQueue.add(
      QUEUES.REPOSITORY,
      {
        repositoryId,
        userId,
        githubUrl,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );

    res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    res
      .status(500)
      .json({ success: false, message: "Failed to queue repository job" });
  }
};
