import express, { Request, Response } from "express";
import logger from "./lib/logger.js";
import cleanRoutes from "./routes/clean.js";
// import queueRoutes from "./routes/queue.js";
import "dotenv/config";

const app = express();
const PORT = 5000;

app.use(express.json());

// app.use("/api/queue", queueRoutes);
app.use("/api/clean", cleanRoutes);

app.get("/", (req: Request, res: Response) => {
  const obj = {
    name: "Abhay Pratap Singh",
  };
  logger.info(`obj is ${JSON.stringify(obj)}`);
  res.status(200).json({ message: "Welcome to navx-queue" });
});

// app.get("/add-job", async (req: Request, res: Response) => {
//   const date = new Date();
//   await exampleQueue.add("testJob", { date });
//   res.status(200).json({ message: "Task added to queue" });
// });

app.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});
