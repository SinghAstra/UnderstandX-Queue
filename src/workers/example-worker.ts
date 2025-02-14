import { Worker } from "bullmq";
import redisConnection from "../config/redis";

const worker = new Worker(
  "exampleQueue",
  async (job) => {
    console.log(`Processing job ${job.id}:`, job.data);
    // Simulate work (e.g., sending email, resizing image)
    await new Promise((res) => setTimeout(res, 3000));
    console.log(`Job ${job.id} completed.`);
  },
  { connection: redisConnection }
);

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} successfully completed.`);
});

worker.on("failed", (job, err) => {
  console.log(`❌ Job ${job?.id} failed:`, err.message);
});

export default worker;
