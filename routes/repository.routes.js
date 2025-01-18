import express from "express";
import { repoProcessingController } from "../controllers/repository.controller.js";

const router = express.Router();

// router.get("/:id/process/stream", streamProcessingController);
router.post("/process", repoProcessingController);

export default router;
