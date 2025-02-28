import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import { acquireRateLimit } from "./rateLimiter.js";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Function to get summary from Gemini AI
export const getFileShortSummary = async (
  filePath: string,
  fileContent: string
) => {
  try {
    await acquireRateLimit();

    const prompt = `
      You are a code assistant. Summarize this file in 1-2 sentences, focusing on its purpose and main functionality.
      Path: ${filePath}
      Code: 
      ${fileContent}
    `;

    const result = await model.generateContent(prompt);

    return result.response.text();
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    return "Failed to generate shortSummary for files.";
  }
};

export const getRepositoryOverview = async (repositoryId: string) => {
  try {
    // Fetch all file paths and summaries
    const files = await prisma.file.findMany({
      where: { repositoryId },
      select: { path: true, shortSummary: true },
    });

    await acquireRateLimit();

    // Format file summaries for the prompt
    const fileSummaries = files
      .map(
        (file) =>
          `- ${file.path}: ${file.shortSummary || "No summary available"}`
      )
      .join("\n");

    // Construct the prompt
    const prompt = `You are a code assistant. Based on the following file summaries, generate a structured overview of the repository:\n\n${fileSummaries}\n\nThe overview should answer the following points clearly:
    Why this project exists: Explain the main purpose or problem this project aims to solve.
    How the project functions: Describe the core logic, workflow, or architecture, mentioning how different components (files) interact.
    What makes this project special: Highlight any unique features, innovative solutions, or interesting design choices.
    Keep the explanation concise yet informative, maintaining a professional tone.`;

    const repositoryOverview = await model.generateContent(prompt);

    console.log("repositoryOverview is ", repositoryOverview);

    return repositoryOverview.response.text();
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    return "Failed to generate repository overview.";
  }
};
