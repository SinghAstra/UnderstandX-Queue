import "dotenv/config";
import { Router } from "express";
import { cleanJobs, cleanUserJobs } from "../controllers/clean.js";
import verifyCleanJobToken from "../middleware/verify-clean-job-token.js";

const router = Router();

router.get("/jobs", cleanJobs);
router.get("/user-jobs", verifyCleanJobToken, cleanUserJobs);

export default router;
