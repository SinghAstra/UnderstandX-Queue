import { Worker } from "bullmq";
import redisConnection from "../config/redis";

const worker = new Worker(
  "exampleQueue",
  async (job) => {
    console.log(`Processing job ${job.id}:`, job.data);
    let num = 1;
    const interval = setInterval(() => {
      console.log("num is", num);
      console.log("date is", new Date());
      num++;
      if (num >= 10000) clearInterval(interval); // Stop after 200 iterations
    }, 100);
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
