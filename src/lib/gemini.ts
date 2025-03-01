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
  console.log("limitsResponse: " + limitsResponse);
  console.log("--------------------------------------");

  const { requestsExceeded, tokensExceeded } = limitsResponse;

  if (requestsExceeded || tokensExceeded) {
    await waitForNextMinute();
  }

  await trackRequest(tokenCount);
}

export async function generateBatchSummaries(
  files: { path: string; id: string; content: string }[]
) {
  try {
    const prompt = `Summarize each of the following files in 1-2 sentences:\n${files
      .map(
        (file, index) =>
          `${index + 1}. path: ${file.path}\ncontent:\n${file.content}`
      )
      .join("\n")}`;

    const tokenCount = await estimateTokenCount(prompt);

    await handleRateLimit(tokenCount);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    });

    const summaries: Summary[] = JSON.parse(result.response.text());

    console.log("summaries is ", summaries);

    return summaries.map((summary) => {
      const file = files.find((f) => f.path === summary.path);
      if (!file) throw new Error(`Unexpected file path: ${summary.path}`);
      return { id: file.id, path: summary.path, summary: summary.summary };
    });
  } catch (error) {
    console.error("Error generating summaries:", error);
    throw error;
  }
}

export async function getRepositoryOverview(repositoryId: string) {
  try {
    const files = await prisma.file.findMany({
      where: { repositoryId },
      select: { path: true, shortSummary: true },
    });

    const fileSummaries = files
      .map(
        (file) =>
          `- ${file.path}: ${file.shortSummary || "No summary available"}`
      )
      .join("\n");

    const prompt = `Generate a structured overview of the repository:\n\n${fileSummaries}`;

    const tokenCount = await estimateTokenCount(prompt);

    await handleRateLimit(tokenCount);

    const result = await model.generateContent(prompt);
    const repositoryOverview = result.response.text();

    console.log("repositoryOverview is ", repositoryOverview);
    return repositoryOverview;
  } catch (error) {
    console.error("Error generating repository overview:", error);
    return "Failed to generate repository overview.";
  }
}
