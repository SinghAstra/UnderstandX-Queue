import "dotenv/config";
import { Router } from "express";
import { cleanUserJobs } from "../controllers/clean.js";
import verifyCleanJobToken from "../middleware/verify-clean-job-token.js";

const router = Router();

router.get("/user-jobs", verifyCleanJobToken, cleanUserJobs);

export default router;
