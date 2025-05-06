import { GoogleGenAI, Type } from "@google/genai";
import { File } from "@prisma/client";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import { generateBatchSummarySystemPrompt } from "./prompt.js";
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

      const prompt = `
      You are a coding assistant.
      Your task is to generate a **structured MDX project overview** based on the provided file summaries.

      ## 📦 Project Overview Structure:
      1. **Introduction:** 🎯 What Problem does this repository solve ? What is the Technology Stack ? 
      2. **Key Features:** 🌟 State the project's core functionalities, referencing relevant files where appropriate.
      3. **Data Flow:** 🔄  explain how data flows through the system.
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
        error.message.includes("GoogleGenerativeAI Error")
      ) {
        console.log(
          `Trying again for ${i + 1} time --generateRepositoryOverview`
        );
        await handleRequestExceeded();
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

      🧩 Code Breakdown by Sections:  
      -  Divide the file into logical sections and describe what each section does in simple , plain english language.


      📜 Key Code:  
      -  Briefly explain code that support the main logic. 

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
    - **Inline code:** Wrap code snippets in single backticks (e.g., \`exampleFunction()\`).
    - **Multi-line code:** Use triple backticks with language identifier (e.g., \`\`\`tsx\n// your code here\n\`\`\`).
    - **Lists:** Use \`-\` for bullets, \`1.\` for numbered lists.
    - **Emojis:** Add relevant emojis before headings for engagement.
    - **Beginner-friendly:** Briefly define technical terms.
    - **Output:** Return valid MDX content as plain text, without JSON or extra wrappers.

    ### 🎯 Important:
    Generate the MDX file analysis directly as plain text, ready to use as-is.

      "`;

      const tokenCount = await estimateTokenCount(prompt);
      await handleRateLimit(tokenCount);

      const result = await model.generateContent(prompt);

      let rawResponse = result.response.text();
      rawResponse = rawResponse.trim();
      // Clean up response
      if (
        rawResponse.startsWith("```mdx") ||
        rawResponse.startsWith("```json")
      ) {
        console.log("Inside rawResponse starts with ```mdx");
        console.log("rawResponse is ", rawResponse);
        rawResponse = rawResponse
          .replace(/^```(mdx|json)\s*/, "")
          .replace(/```$/, "")
          .trim();
      }

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
        error.message.includes("GoogleGenerativeAI Error")
      ) {
        console.log(`Trying again for ${i + 1} time --generateFileAnalysis`);
        await handleRequestExceeded();
        sleep(i + 1);
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
