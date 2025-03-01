import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import redisConnection from "./redis.js";

dotenv.config();

const REQUEST_LIMIT = 15;
const TOKEN_LIMIT = 1000000;
const RATE_LIMIT_KEY = "global:rate_limit";

type Summary = {
  path: string;
  summary: string;
};

type ParsedSummary = {
  id: string;
  path: string;
  summary: string;
};

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function trackRequest(tokenCount: number) {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const key = `${RATE_LIMIT_KEY}:${currentMinute}`;

  const result = await redisConnection
    .multi()
    .incr(`${key}:requests`)
    .incrby(`${key}:tokens`, tokenCount)
    .expire(`${key}:requests`, 60)
    .expire(`${key}:tokens`, 60)
    .exec();

  if (!result) {
    throw new Error("Redis transaction failed");
  }

  const [requests, tokens] = result.map(([err, res]) => {
    if (err) throw err;
    return res;
  });

  return { requests, tokens };
}

export async function checkLimits() {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const key = `${RATE_LIMIT_KEY}:${currentMinute}`;

  const [requests, tokens] = await redisConnection.mget(
    `${key}:requests`,
    `${key}:tokens`
  );

  return {
    requests: parseInt(requests ?? "0"),
    tokens: parseInt(tokens ?? "0"),
    requestsExceeded: parseInt(requests ?? "0") >= REQUEST_LIMIT,
    tokensExceeded: parseInt(tokens ?? "0") >= TOKEN_LIMIT,
  };
}

async function waitForNextMinute() {
  const now = Date.now();
  const millisecondsUntilNextMinute = 60000 - (now % 60000);
  console.log(
    `Rate limit exceeded. Waiting for ${millisecondsUntilNextMinute}ms...`
  );
  await new Promise((resolve) =>
    setTimeout(resolve, millisecondsUntilNextMinute)
  );
}

export async function estimateTokenCount(
  prompt: string,
  maxOutputTokens = 1000
) {
  const inputTokenCount = await model.countTokens(prompt);
  return inputTokenCount.totalTokens + maxOutputTokens; // rough estimate
}

export async function handleRateLimit(tokenCount: number) {
  const limitsResponse = await checkLimits();

  console.log("--------------------------------------");
  console.log("limitsResponse:", limitsResponse);
  console.log("--------------------------------------");

  const { requestsExceeded, tokensExceeded } = limitsResponse;

  if (requestsExceeded || tokensExceeded) {
    await waitForNextMinute();
  }

  await trackRequest(tokenCount);
}

export async function generateBatchSummaries(
  files: { id: string; path: string; content: string }[]
) {
  try {
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

    const tokenCount = await estimateTokenCount(prompt);

    await handleRateLimit(tokenCount);

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

export async function getRepositoryOverview(repositoryId: string) {
  try {
    // Fetch all file paths and summaries
    const files = await prisma.file.findMany({
      where: { repositoryId },
      select: { path: true, shortSummary: true },
    });

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

    const tokenCount = await estimateTokenCount(prompt);

    await handleRateLimit(tokenCount);

    const result = await model.generateContent(prompt);

    const repositoryOverview = result.response.text();

    console.log("repositoryOverview is ", repositoryOverview);

    return repositoryOverview;
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    return "Failed to generate repository overview.";
  }
}
