import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import redisConnection from "./redis.js";

dotenv.config();

const REQUEST_LIMIT = 15;
const TOKEN_LIMIT = 800000;
const RATE_LIMIT_KEY = "global:rate_limit";

type Summary = {
  path: string;
  summary: string;
};

type Analysis = {
  path: string;
  analysis: string;
};

export type ParsedAnalysis = {
  id: string;
  path: string;
  analysis: string;
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
  files: { id: string; path: string; content: string | null }[]
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

    const prompt = `
      You are a coding assistant. Your task is to generate a **structured MDX project overview** based on the provided file summaries.
      
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
      - **Emojis:** Add relevant emojis to make the overview engaging.  
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
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    throw error;
  }
}

export async function generateBatchAnalysis(
  repositoryId: string,
  filesWithoutAnalysis: { path: string; id: string; content: string | null }[],
  repoOverview: string
) {
  try {
    const filePaths = new Set(filesWithoutAnalysis.map((file) => file.path));

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
      You are a code analysis assistant. Your task is to provide **detailed insights** for each file in the repository. 
      
      ## 📦 Repository Overview:
      ${repoOverview}
      
      ## 📚 File Summaries:
      ${fileSummaries}
      
      ## 🎯 Task:
      Analyze each file below in detail. Return the analysis as a **valid JSON array** where each object contains:
      - **path:** The file path (string).
      - **analysis:** A detailed analysis in **MDX format**.  
      
      ### Focus on:
      1. **High-Level Overview:** Briefly explain the file's purpose.  
      2. **Key Components:** Highlight important classes, functions, or data structures.  
      3. **Usage:** Provide an example of how this file might be used.  
      4. **Potential Issues:** Mention any challenges or suggest issues to raise.  
      5. **Conclusion:** Summarize the file's role in the project.  
      
      ## 🚀 Formatting Guidelines:
      - Use **emojis** to enhance readability.  
      - **Directly output MDX content** for the analysis — do not wrap it in code blocks.  
      - Ensure all analyses are **non-empty** and relevant to the file's content.
      
      ## ✅ Example Response:
      \`\`\`json
      [
        {
          "path": "src/utils.js",
          "analysis": "### 🔧 High-Level Overview\nThe \`utils.js\` file defines helper functions for string manipulation, including \`capitalize\` and \`truncate\`.\n\n### 🏗️ Key Components\n- \`capitalize(text: string)\`\n- \`truncate(text: string, length: number)\`\n\n### 🚀 Usage\nThese functions are imported in \`main.js\` for formatting user inputs.\n\n### ⚠️ Potential Issues\nConsider adding unit tests for edge cases like empty strings.\n\n### ✅ Conclusion\nThis file provides essential utilities to format user data consistently."
        },
        {
          "path": "src/api.js",
          "analysis": "..."
        }
      ]
      \`\`\`
      
      ## 🗂️ Files to Analyze:
      ${filesWithoutAnalysis
        .map(
          (file) => `
      path: ${file.path}
      content:
      ${file.content || "No content available"}
      `
        )
        .join("\n")}
      
      **Important:**  
      - Ensure the output is a **valid JSON array**.  
      - Each file must have a **non-empty** \`analysis\`.  
      `;

    const tokenCount = await estimateTokenCount(prompt);
    await handleRateLimit(tokenCount);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const analyses: Analysis[] = JSON.parse(result.response.text());

    console.log("analyses are ", analyses);

    const parsedAnalyses: ParsedAnalysis[] = analyses.map((analysis) => {
      if (
        typeof analysis !== "object" ||
        typeof analysis.path !== "string" ||
        typeof analysis.analysis !== "string" ||
        !filePaths.has(analysis.path) ||
        analysis.analysis.trim() === ""
      ) {
        throw new Error(
          `Invalid summary format or unexpected file path: ${JSON.stringify(
            analysis
          )}`
        );
      }
      const file = filesWithoutAnalysis.find((f) => f.path === analysis.path);
      if (!file) {
        throw new Error(
          `File path not found in the provided files array: ${analysis.path}`
        );
      }

      return {
        id: file.id,
        path: file.path,
        analysis: analysis.analysis,
      };
    });

    return parsedAnalyses;
  } catch (error) {
    if (error instanceof Error) {
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
    }
    throw error;
  }
}
