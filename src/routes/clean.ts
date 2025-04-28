import "dotenv/config";
import { Router } from "express";
import { cleanJobs } from "../controllers/clean.js";
import verifyCleanJobToken from "../middleware/verify-clean-job-token.js";

const router = Router();

router.get("/jobs", verifyCleanJobToken, cleanJobs);

export default router;
