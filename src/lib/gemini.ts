import { GoogleGenAI, Type } from "@google/genai";
import { File } from "@prisma/client";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import {
  generateBatchSummarySystemPrompt,
  generateFileAnalysisSystemPrompt,
  generateOverviewSystemPrompt,
} from "./prompt.js";
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
const model = "gemini-1.5-flash";

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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

async function sleep(times: number) {
  console.log(`Sleeping for ${2 * times} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, 2000 * times));
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
    await sleep(1);
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
  for (let i = 0; i < 100; i++) {
    try {
      const filePaths = new Set(files.map((file) => file.path));

      const prompt = `
      Files:
      ${files
        .map(
          (file, index) =>
            `${index + 1}. path: ${
              file.path
            }\n   content: ${file.content?.substring(0, 500)}...`
        )
        .join("\n")}
      `;

      const tokenCount = await estimateTokenCount(prompt);

      await handleRateLimit(tokenCount);

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.1,
          systemInstruction: generateBatchSummarySystemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                path: { type: Type.STRING },
                summary: { type: Type.STRING },
              },
              required: ["path", "summary"],
              propertyOrdering: ["path", "summary"],
            },
          },
        },
      });

      if (!response || !response.text) {
        throw new Error("Invalid batch summary response format");
      }

      const result = JSON.parse(response.text);

      console.log("result in generateBatchSummaries is ", result);

      if (!isValidBatchSummaryResponse(result, filePaths)) {
        throw new Error("Invalid batch summary response format");
      }

      const summaries: Summary[] = result;
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
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
        console.log("--------------------------------");
      }

      if (
        error instanceof Error &&
        error.message.includes("GoogleGenerativeAI Error")
      ) {
        console.log(`Trying again for ${i + 1} time --generateBatchSummaries`);
        await handleRequestExceeded();
        sleep(i + 1);
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
      }

      throw new Error(
        error instanceof Error
          ? error.message
          : "Unexpected error occurred while generating batch summary."
      );
    }
  }
  throw new Error(`Could not generate batch summary.`);
}

export async function generateRepositoryOverview(repositoryId: string) {
  for (let i = 0; i < 100; i++) {
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

      const userPrompt = `
      ## 📦 Project Overview Structure:

      1.  **Introduction:** 🎯 What Problem does this repository solve? What is the Technology Stack?
      2.  **Key Features:** 🌟 State the project's core functionalities, referencing relevant files where appropriate.
      3.  **Data Flow:** 🔄 Explain how data flows through the system.
      4.  **Conclusion:** ✅ Provide a final summary tying the features and architecture together.

      ## 🛠️ File Summaries:

      ${fileSummaries}

      Generate the MDX project overview.
      `;

      const tokenCount = await estimateTokenCount(userPrompt);

      await handleRateLimit(tokenCount);

      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          temperature: 0.1,
          systemInstruction: generateOverviewSystemPrompt,
        },
      });

      const repositoryOverview = response.text;

      console.log("repositoryOverview is ", repositoryOverview);

      if (!response || !response.text) {
        throw new Error("Invalid repository overview format");
      }

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
        error.message.includes("GoogleGenerativeAI Error")
      ) {
        console.log(
          `Trying again for ${i + 1} time --generateRepositoryOverview`
        );
        await handleRequestExceeded();
        sleep(i + 1);
        continue;
      }

      if (
        error instanceof Error &&
        error.message.includes("Invalid repository overview format")
      ) {
        console.log(
          `Trying again for ${i + 1} time --generateRepositoryOverview`
        );
        sleep(i + 1);
        continue;
      }

      throw new Error("Could Not generate Repository overview.");
    }
  }
}

export async function generateFileAnalysis(repositoryId: string, file: File) {
  for (let i = 0; i < 100; i++) {
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

      const userPrompt = `
        Generate a **structured MDX File Analysis Blog** based on the provided repository overview, short summaries of all files in the repo, and the content of the file to analyze.
        
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
        
        ## File to Analyze:
        ${
          file.content ||
          "No content available—analyze based on path and repo context."
        }
        
        ## 🚀 Guidelines:
        
        *   **MDX format:** Use proper heading levels (#, ##, ###).
        *   **Inline code:** Wrap code snippets in single backticks (e.g., \`exampleFunction()\`).
        *   **Multi-line code:** Use triple backticks with language identifier (e.g., \`\`\`tsx\\n// your code here\\n\`\`\`).
        *   **Lists:** Use \`-\` for bullets, \`1.\` for numbered lists.
        *   **Emojis:** Add relevant emojis before headings for engagement.
        *   **Beginner-friendly:** Briefly define technical terms.
        
        **Analysis Structure:**
        
        1.  **📝 Introduction:**
            *   Describe the file’s role within the project.
            *   Explain what this file does in the project.
            *   Highlight how it connects to the application’s flow.
        2.  **🧩 Code Breakdown by Sections:**
            *   Divide the file into logical sections and describe what each section does in simple, plain English.
            *   Suggest improvements for each section (refactoring, bug fixes, etc.).
        3.  **📜 Key Code:**
            *   Briefly explain code that supports the main logic.
            *   Identify potential issues or areas for optimization.
        4.  **Possible improvements:**
            *   List any possible improvements to the code.
        5.  **🔁 Quick Recap:**
            *   📌 Summarize the file’s purpose, structure, and key takeaways in a concise wrap-up.
        
        ### 🎯 Important: Generate the MDX file analysis directly as plain text, ready to use as-is.
        `;

      const tokenCount = await estimateTokenCount(userPrompt);
      await handleRateLimit(tokenCount);

      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          temperature: 0.2,
          systemInstruction: generateFileAnalysisSystemPrompt,
        },
      });

      console.log("response is ", response);

      if (!response || !response.text) {
        throw new Error("Invalid file analysis format");
      }

      let fileAnalysis = response.text;

      fileAnalysis = fileAnalysis.trim();
      // Clean up response
      if (fileAnalysis.startsWith("```mdx")) {
        console.log("Inside fileAnalysis starts with ```mdx");
        fileAnalysis = fileAnalysis
          .replace(/^```(mdx)\s*/, "")
          .replace(/```$/, "")
          .trim();
      }

      return fileAnalysis;
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
        error.message.includes("GoogleGenerativeAI Error")
      ) {
        console.log(`Trying again for ${i + 1} time --generateFileAnalysis`);
        await handleRequestExceeded();
        sleep(i + 1);
        continue;
      }
      if (
        error instanceof Error &&
        error.message.includes("Invalid file analysis format")
      ) {
        console.log("--------------------------------");
        console.log(
          "In generateFileAnalysis catch block Invalid file analysis format"
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

  throw new Error(`Could not generate file analysis for ${file.path}.`);
}

function isValidBatchSummaryResponse(data: any, filePaths: Set<string>) {
  if (!Array.isArray(data)) {
    return false;
  }
  // Validate each item in the array
  for (const item of data) {
    // Ensure item is an object of type Summary and valid path and not null
    if (!filePaths.has(item.path) || Object.keys(item).length !== 2) {
      return false;
    }
  }

  return true;
}
