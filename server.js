const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

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

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
