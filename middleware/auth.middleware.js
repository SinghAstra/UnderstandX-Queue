import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;

export const verifyToken = (req, res, next) => {
  console.log("JWT_SECRET", JWT_SECRET);
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if token has expired
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      res.status(401).json({ error: "Token has expired" });
      return;
    }

    req.user = decoded;
    console.log("Decoded token", decoded);
    next();
  } catch (error) {
    res.status(401).json({ error: "Internal Server Error" });
    return;
  }
};
