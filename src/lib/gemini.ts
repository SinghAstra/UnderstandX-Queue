import { GoogleGenAI, Type } from "@google/genai";
import { File } from "@prisma/client";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import {
  generateBatchSummarySystemPrompt,
  generateFileAnalysisSystemPrompt,
  generateOverviewSystemPrompt,
} from "./prompt.js";
import { checkAndIncrementRateLimit } from "./redis/atomic-operation.js";
import { getGeminiRequestsThisMinuteRedisKey } from "./redis/redis-keys.js";

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
const model = "gemini-2.0-flash";

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function sleep(times: number) {
  console.log(`Sleeping for ${60 * times} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, 60000 * times));
}

export async function handleAtomicRateLimit() {
  const geminiRequestsCountKey = getGeminiRequestsThisMinuteRedisKey();

  const result = await checkAndIncrementRateLimit(
    geminiRequestsCountKey,
    REQUEST_LIMIT
  );

  console.log("--------------------------------------");
  console.log("Rate limit check result:", {
    allowed: result.allowed,
    currentRequests: result.currentRequests,
  });
  console.log("--------------------------------------");

  if (!result.allowed) {
    console.log("Rate limit exceeded, waiting...");
    await sleep(1);
    return false;
  }

  return true;
}

/**
 * Wait for rate limits to reset and retry the atomic check
 */
async function waitForRateLimitReset(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    const allowed = await handleAtomicRateLimit();
    if (allowed) {
      return; // Successfully acquired rate limit slot
    }

    // Wait before retrying
    await sleep(1);
  }
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

      // Atomic rate limiting - will wait until allowed
      await waitForRateLimitReset();

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
        sleep(i + 1);
        continue;
      }

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        console.log(`Trying again for ${i + 1} time --generateBatchSummaries`);
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

      1. 🎯 **Introduction:**  What Problem does this repository solve? What is the Technology Stack?
      2. 🌟 **Key Features:**  State the project's core functionalities, referencing relevant files where appropriate.
      3. 🔄 **Data Flow:**  Explain how data flows through the system.
      4. ✅ **Conclusion:**  Provide a final summary tying the features and architecture together.

      ## 🛠️ File Summaries:

      ${fileSummaries}

      Generate the MDX project overview.
      `;

      // Atomic rate limiting - will wait until allowed
      await waitForRateLimitReset();

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
        sleep(i + 1);
        continue;
      }

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        console.log(
          `Trying again for ${i + 1} time --generateRepositoryOverview`
        );
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

        
        ## ✅ Example Output Format:

        \`\`\`mdx
        # 📄  Authentication Logic

        ## 📝 Introduction

        This file handles authentication logic in a Next.js API route. It verifies user credentials and generates JWT tokens. It connects to the user database using Prisma and is critical for login functionality.

        ## 🧩 Code Breakdown by Sections

        ### 🔐 Import Dependencies
        \`\`\`ts
        import { sign } from 'jsonwebtoken';
        import prisma from '@/lib/prisma';
        \`\`\`
        These imports bring in JWT handling and Prisma client for database queries.

        ### 🔍 Validate Request Body
        \`\`\`ts
        if (!req.body.email || !req.body.password) {
          return res.status(400).json({ error: 'Missing credentials' });
        }
        \`\`\`
        Ensures the client provided both email and password. Could be improved by using a schema validator like Zod.

        ### 🧠 Query User & Compare Password
        \`\`\`ts
        const user = await prisma.user.findUnique({ where: { email } });
        // password comparison logic
        \`\`\`
        Fetches user from database. Password should be hashed and compared using bcrypt.

        ## 📜 Key Code

        - \`sign()\` creates a JWT token.
        - \`prisma.user.findUnique()\` is used to locate the user in the DB.

        ## 🛠️ Possible improvements

        - Use schema validation (e.g., Zod).
        - Abstract token creation into a separate utility function.
        - Add rate limiting to prevent brute-force attacks.

        ## 🔁 Quick Recap

        - 📌 This file is the backend auth entry point.
        - 🧩 Handles input validation, user lookup, and JWT issuance.
        - 🛠️ Can be improved with better security practices and abstraction.
        \`\`\`
        
        ### 🎯 Important: Generate the MDX file analysis directly as plain text, ready to use as-is.
        `;

      // Atomic rate limiting - will wait until allowed
      await waitForRateLimitReset();

      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          temperature: 0.2,
          systemInstruction: generateFileAnalysisSystemPrompt,
        },
      });

      if (!response || !response.text) {
        throw new Error("Invalid file analysis format");
      }

      let fileAnalysis = response.text;

      console.log("fileAnalysis is ", fileAnalysis);

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
        sleep(i + 1);
        continue;
      }

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        console.log(`Trying again for ${i + 1} time --generateFileAnalysis`);
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
