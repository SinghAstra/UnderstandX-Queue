import express, { Request, Response } from "express";
import exampleQueue from "./queues/example-queue";

const app = express();
const PORT = 5000;

app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Welcome to navx-queue" });
});

app.get("/add-job", async (req: Request, res: Response) => {
  const date = new Date();
  await exampleQueue.add("testJob", { date });
  res.status(200).json({ message: "Task added to queue" });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
