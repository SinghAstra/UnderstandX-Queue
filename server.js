import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import userRoutes from "./routes/user.routes.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Basic CRUD endpoints
app.get("/", (req, res) => {
  res.send("Welcome to SemanticX API");
});
app.use("/api/users", userRoutes);

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
