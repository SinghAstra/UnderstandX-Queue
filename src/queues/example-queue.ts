import { Queue } from "bullmq";
import redisConnection from "../config/redis";

const exampleQueue = new Queue("exampleQueue", {
  connection: redisConnection,
});

export default exampleQueue;
