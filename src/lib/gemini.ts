import { GoogleGenerativeAI } from "@google/generative-ai";
import { File } from "@prisma/client";
import { error } from "console";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import {
  getGeminiRequestsThisMinuteRedisKey,
  getGeminiTokensConsumedThisMinuteRedisKey,
} from "./redis-keys.js";
import redisClient from "./redis.js";

dotenv.config();

const REQUEST_LIMIT = 12;
const TOKEN_LIMIT = 800000;

type Summary = {
  path: string;
  summary: string;
};

type ParsedSummary = {
  id: string;
  path: string;
  summary: string;
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const modelName = "gemini-2.0-flash";

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = gemini.getGenerativeModel({
  model: modelName,
});

export async function trackRequest(tokenCount: number) {
  const geminiRequestsCountKey = getGeminiRequestsThisMinuteRedisKey();
  const geminiRequestsTokenConsumedKey =
    getGeminiTokensConsumedThisMinuteRedisKey();

  const result = await redisClient
    .multi()
    .incr(geminiRequestsCountKey)
    .incrby(geminiRequestsTokenConsumedKey, tokenCount)
    .expire(geminiRequestsCountKey, 60)
    .expire(geminiRequestsTokenConsumedKey, 60)
    .exec();

  if (!result) {
    throw new Error(
      "Redis connection failed during updating tokens consumed and request count"
    );
  }

  const [requests, tokens] = result.map(([error, response]) => {
    if (error) throw error;
    return response;
  });

  return { requests, tokens };
}

export async function checkLimits() {
  const geminiRequestsCountKey = getGeminiRequestsThisMinuteRedisKey();
  const geminiRequestsTokenConsumedKey =
    getGeminiTokensConsumedThisMinuteRedisKey();

  const [requests, tokens] = await redisClient.mget(
    geminiRequestsCountKey,
    geminiRequestsTokenConsumedKey
  );

  return {
    requests: parseInt(requests ?? "0"),
    tokens: parseInt(tokens ?? "0"),
    requestsExceeded: parseInt(requests ?? "0") >= REQUEST_LIMIT,
    tokensExceeded: parseInt(tokens ?? "0") >= TOKEN_LIMIT,
  };
}

async function sleep() {
  console.log(`Rate limit exceeded. Waiting for 2000ms...`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

export async function estimateTokenCount(
  prompt: string,
  maxOutputTokens = 1000
) {
  return Math.ceil(prompt.length / 4) + maxOutputTokens;
}

export async function handleRateLimit(tokenCount: number) {
  const limitsResponse = await checkLimits();

  console.log("--------------------------------------");
  console.log("limitsResponse:", limitsResponse);
  console.log("--------------------------------------");

  const { requestsExceeded, tokensExceeded } = limitsResponse;

  if (requestsExceeded || tokensExceeded) {
    await sleep();
  }

  await trackRequest(tokenCount);
}

async function handleRequestExceeded() {
  console.log("-------------------------------");
  console.log("In handleRequest exceeded");
  const geminiRequestsCountKey = getGeminiRequestsThisMinuteRedisKey();
  await redisClient.set(geminiRequestsCountKey, 16);
  const limitsResponse = await checkLimits();
  console.log("limitsResponse:", limitsResponse);
  console.log("-------------------------------");
}

export async function generateBatchSummaries(
  files: { id: string; path: string; content: string | null }[]
) {
  let rawResponse;
  for (let i = 0; i < 5; i++) {
    try {
      const filePaths = new Set(files.map((file) => file.path));

      const prompt = `
      You are a code assistant.
      Summarize each of the following files in 1-2 sentences, focusing on its purpose and main functionality. 

      Return your response as a JSON array of objects, ensuring:
      - Return the summaries as a valid JSON array where each object has 'path' and 'summary' properties.
      - All keys and values are strings — the entire JSON must be valid for direct parsing with JSON.parse().

      Example response:
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

      rawResponse = result.response.text();
      console.log("rawResponse --generateBatchSummaries : ", rawResponse);

      rawResponse = rawResponse
        .replace(/```json/g, "") // Remove ```json
        .replace(/```/g, "") // Remove ```
        .trim();

      const parsedResponse = JSON.parse(rawResponse);
      console.log("parsedResponse --generateBatchSummaries : ", parsedResponse);

      if (!isValidBatchSummaryResponse(parsedResponse, filePaths)) {
        throw new Error("Invalid batch summary response format");
      }

      const summaries: Summary[] = parsedResponse;
      const parsedSummaries: ParsedSummary[] = summaries.map((summary) => {
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
        console.log("--------------------------------");
        console.log("rawResponse is ", rawResponse);
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
        console.log("--------------------------------");
      }

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        await handleRequestExceeded();
        sleep();
        continue;
      }

      if (
        error instanceof Error &&
        (error.message.includes("Invalid batch summary response format") ||
          error.stack?.includes("SyntaxError"))
      ) {
        console.log("--------------------------------");
        console.log(`Syntax Error occurred. Trying again for ${i} time`);
        console.log("--------------------------------");
        continue;
      } else {
        throw new Error(
          "Could Not generate batch summaries, maybe ai model is down."
        );
      }
    }
  }
  throw new Error(
    "Could Not generate batch summaries, maybe ai model is down."
  );
}

export async function generateRepositoryOverview(repositoryId: string) {
  for (let i = 0; i < 5; i++) {
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

      const prompt = `
      You are a coding assistant.
      Your task is to generate a **structured MDX project overview** based on the provided file summaries.

      ## 📦 Project Overview Structure:
      1. **Introduction:** 🎯 Briefly explain the purpose of the project, its goals, and its main use cases.
      2. **Key Features:** 🌟 Highlight the project's core functionalities, referencing relevant files where appropriate.
      3. **Architecture Overview:** 🏗️ Summarize how the key components interact — explain how data flows through the system.
      4. **Conclusion:** ✅ Provide a final summary tying the features and architecture together.

      ## 🛠️ File Summaries:
      ${fileSummaries}

      ## 🚀 Guidelines:
      - **MDX format:** Use proper heading levels (#, ##, ###).
      - **Inline code:** Use backticks for code snippets (e.g., \`exampleFunction()\`).
      - **Lists:** Use \`-\` for bullet points, \`1.\` for numbered lists.
      - **Emojis:** Add relevant emojis to make the overview engaging add emoji before the heading text.
      - **No code block wrappers:** Do **not** use triple backticks for MDX content.
      - **Be concise yet insightful.** Don’t over-explain — aim for clarity.

      ## 🎯 Important:
      - Ensure the output is **valid MDX**.
      - The overview should **reference key files** from the provided summaries when relevant.
      - **Directly output MDX content** without wrapping it in code blocks.

      Please generate the MDX project overview as plain text.
      `;

      const tokenCount = await estimateTokenCount(prompt);

      await handleRateLimit(tokenCount);

      const result = await model.generateContent(prompt);

      const repositoryOverview = result.response.text();

      console.log("repositoryOverview is ", repositoryOverview);

      return repositoryOverview;
    } catch (error) {
      if (error instanceof Error) {
        console.log("--------------------------------");
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
        console.log("--------------------------------");
      }

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        await handleRequestExceeded();
        sleep();
        continue;
      }

      throw new Error(
        "Could Not generate Repository overview, maybe ai model is down."
      );
    }
  }
}

export async function generateFileAnalysis(repositoryId: string, file: File) {
  let i;
  for (i = 0; i < 10; i++) {
    try {
      const repository = await prisma.repository.findFirst({
        where: {
          id: repositoryId,
        },
      });

      if (!repository) {
        throw new Error(`Repository not found with id: ${repositoryId}`);
      }

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

      const prompt = `
      "You are a coding assistant.
      Your task is to generate a **structured MDX File Analysis Blog** based on
      the provided repository overview 
      short summaries of all files in the repo, and 
      file Content to analyze. 


      📝 Introduction:  
      -   describe the file’s role within the project.  
      -   Explain what this file does in the project.  
      -   Highlight how it connects to the application’s flow.  

      📑 File Structure Breakdown:  
      -  List and explain the external libraries or modules used, and why they’re included.  
      -  Identify the major parts of the file, like variables, functions, or classes.  
      -  Describe the sequence of operations or logic within the file, if relevant.  

      📜 Code Explanation:  
      -  Begin with the imports or the first significant line of code.  
      -  Break down what each section does in simple, plain language.  

      🔁 Quick Recap:  
      - 📌 Summarize the file’s purpose, structure, and key takeaways in a concise wrap-up.  

      ## Repository Overview:
      ${
        repository.overview ||
        "No overview provided—make reasonable guesses based on file paths and content."
      }

      ## File Summaries:
      ${
        fileSummaries ||
        "No summaries available—use file paths and content to infer roles."
      }

      ##  File to Analyze:
      ${
        file.content ||
        "No content available—analyze based on path and repo context."
      }

      ## 🚀 Guidelines:
      - **MDX format:** Use proper heading levels (#, ##, ###).
      - **Inline code:** Use backticks for code snippets (e.g., \`exampleFunction()\`).
      - **Lists:** Use \`-\` for bullet points, \`1.\` for numbered lists.
      - **Emojis:** Add relevant emojis to make the overview engaging add emoji before the heading text.
      - **No code block wrappers:** Do **not** use triple backticks for MDX content.
      -  Briefly define any technical terms to keep it beginner-friendly.  

      
      
      ### 🎯 Important
      Please generate the MDX file analysis and return it directly as plain text, without any JSON wrapping or additional formatting. The response should be valid MDX content, ready to use as-is.

      "`;

      const tokenCount = await estimateTokenCount(prompt);
      await handleRateLimit(tokenCount);

      const result = await model.generateContent(prompt);

      const rawResponse = result.response.text();

      if (typeof rawResponse !== "string") {
        throw new Error("rawResponse is not a string");
      }

      return rawResponse;
    } catch (error) {
      if (error instanceof Error) {
        console.log("--------------------------------");
        console.log(
          "In generateFileAnalysis catch block if(error instanceof Error)"
        );
        console.log("file.path is ", file.path);
        console.log("error.message is ", error.message);
        console.log("--------------------------------");
      }

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        console.log("--------------------------------");
        console.log(
          'In generateFileAnalysis catch block if(error.message.includes("429 Too Many Requests")'
        );
        console.log("file.path is ", file.path);
        console.log(`Trying again for ${i} time`);
        await handleRequestExceeded();
        sleep();
        console.log("--------------------------------");
        continue;
      }

      if (
        error instanceof Error &&
        error.message.includes("rawResponse is not a string")
      ) {
        console.log("--------------------------------");
        console.log(
          "In generateFileAnalysis catch block rawResponse is not a string"
        );
        console.log("--------------------------------");
        continue;
      }

      throw new Error(
        error instanceof Error
          ? error.message
          : "Unexpected error occurred while generating file analysis."
      );
    }
  }

  throw new Error(`Tried ${i} times but could not generate file analysis.`);
}

function isValidBatchSummaryResponse(data: any, filePaths: Set<string>) {
  if (!Array.isArray(data)) {
    return false;
  }
  // Validate each item in the array
  for (const item of data) {
    // Ensure item is an object of type Summary and valid path and not null
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.path !== "string" ||
      typeof item.summary !== "string" ||
      !filePaths.has(item.path) ||
      Object.keys(item).length !== 2
    ) {
      return false;
    }
  }

  return true;
}
