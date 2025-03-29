import "dotenv/config";
import express, { Request, Response } from "express";
import cleanRoutes from "./routes/clean.js";
import queueRoutes from "./routes/queue.js";

const app = express();
const PORT = 5000;

app.use(express.json());

app.use("/api/queue", queueRoutes);
app.use("/api/clean", cleanRoutes);

app.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Server is up" });
});

app.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});
