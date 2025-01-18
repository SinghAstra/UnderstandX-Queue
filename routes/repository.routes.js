import express from "express";
import {
  repoProcessingController,
  streamProcessingController,
} from "../controllers/repository.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/:id/stream", streamProcessingController);
router.post("/process", verifyToken, repoProcessingController);

export default router;
