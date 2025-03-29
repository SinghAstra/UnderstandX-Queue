import { Router } from "express";
import { addJobToRepositoryQueue } from "../controllers/queue.js";
import { verifyServiceToken } from "../middleware/verify-service-token.js";

const router = Router();

router.post("/repository", verifyServiceToken, addJobToRepositoryQueue);

export default router;
