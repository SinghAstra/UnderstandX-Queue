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

type Summary = {
  path: string;
  summary: string;
};

type ParsedSummary = {
  id: string;
  path: string;
  summary: string;
};

export async function generateBatchSummaries(
  files: { id: string; path: string; content: string }[]
) {
  try {
    await acquireRateLimit();
    const filePaths = new Set(files.map((file) => file.path));

    const prompt = `
      You are a code assistant. Summarize each of the following files in 1-2 sentences, focusing on its purpose and main functionality. Return the summaries as a valid JSON array where each object has 'path' and 'summary' properties. Example response:
      [
        {"path": "src/file1.js", "summary": "This file contains utility functions for string manipulation."},
        {"path": "src/file2.py", "summary": "This script processes CSV data and generates a report."}
      ]

      Files:
      ${files
        .map(
          (file, index) => `
            ${index + 1}. path: ${file.path}
            content:
            ${file.content}
          `
        )
        .join("\n")}
    `;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const summaries: Summary[] = JSON.parse(result.response.text());

    console.log("summaries is ", summaries);

    // First Perform the Check that are the summaries created properly
    // Summaries should be an array of object with two properties path and summary
    // Check if the path is present in the files array and if the summary is not empty
    // If any of the checks fails, throw an error with the problematic file path
    const parsedSummaries: ParsedSummary[] = summaries.map((summary) => {
      if (
        typeof summary !== "object" ||
        typeof summary.path !== "string" ||
        typeof summary.summary !== "string" ||
        !filePaths.has(summary.path) ||
        summary.summary.trim() === ""
      ) {
        throw new Error(
          `Invalid summary format or unexpected file path: ${JSON.stringify(
            summary
          )}`
        );
      }

      const file = files.find((f) => f.path === summary.path);
      if (!file) {
        throw new Error(
          `File path not found in the provided files array: ${summary.path}`
        );
      }

      return {
        id: file.id,
        path: summary.path,
        summary: summary.summary,
      };
    });

    return parsedSummaries;
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    throw error;
  }
}

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
