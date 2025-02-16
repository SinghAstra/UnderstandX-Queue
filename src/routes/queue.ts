import { Request, Response, Router } from "express";
import { repositoryQueueController } from "../controllers/queue";
import { verifyServiceToken } from "../middleware/verify-service-token";

const router = Router();

router.post("/repository", verifyServiceToken, repositoryQueueController);
router.get("/repository", (req: Request, res: Response) => {
  res.status(200).json({ message: "Welcome to /repository" });
});

export default router;
