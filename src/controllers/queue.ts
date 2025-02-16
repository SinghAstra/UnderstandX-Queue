import { Request, Response } from "express";
import { repositoryQueue } from "../queues/repository.js";

export const repositoryQueueController = async (
  req: Request,
  res: Response
) => {
  try {
    const { repositoryId, userId, githubUrl } = req.body.auth;
    console.log("req.body.auth --repositoryQueue is ", req.body.auth);

    // Add job to the repository queue
    await repositoryQueue.add(
      "process-repository",
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
    console.error("Error queueing repository job:", error);
    res.status(500).json({ error: "Failed to queue repository job" });
  }
};
