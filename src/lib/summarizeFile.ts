import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { acquireRateLimit } from "./rateLimiter.js";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function to get summary from Gemini AI
export const getFileShortSummary = async (
  filePath: string,
  fileContent: string
) => {
  try {
    await acquireRateLimit();

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `
      You are a code assistant. Summarize this file in 1-2 sentences, focusing on its purpose and main functionality.
      Path: ${filePath}
      Code: 
      ${fileContent}
    `;

    const result = await model.generateContent(prompt);

    const fileInfo = {
      filePath,
      content: fileContent,
    };

    console.log("fileInfo is ", fileInfo);
    return result.response.text();
  } catch (err) {
    console.error("Error generating summary:", err);
    return "Failed to generate summary.";
  }
};
