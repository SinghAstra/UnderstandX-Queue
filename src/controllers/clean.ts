import { Request, Response } from "express";
import { cancelAllRepositoryJobs } from "../lib/cancel-jobs.js";
import { prisma } from "../lib/prisma.js";

export const cleanUserJobs = async (req: Request, res: Response) => {
  try {
    console.log("In Clean User Jobs");
    const userId = req.body.auth.userId;
    console.log("req.body.auth is ", req.body.auth);
    console.log("userId is ", userId);
    const repositories = await prisma.repository.findMany({
      where: {
        status: {
          in: ["PROCESSING", "PENDING"],
        },
        userId,
      },
    });

    repositories.map(async (repository) => {
      console.log("repository.id is ", repository.id);
      await cancelAllRepositoryJobs(repository.id);
    });

    res.status(200).json({
      message: `Successfully cleaned all Jobs `,
    });
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    res.status(500).json({
      message:
        error instanceof Error ? error.message : "Failed to Clean User Jobs",
    });
  }
};
