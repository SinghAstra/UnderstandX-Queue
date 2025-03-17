import { GoogleGenerativeAI } from "@google/generative-ai";
import { File } from "@prisma/client";
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

type ParsedSummary = {
  id: string;
  path: string;
  summary: string;
};

const geminiApiKey = process.env.GEMINI_API_KEY;
const modelName = "gemini-2.0-flash";

if (!geminiApiKey) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}
const gemini = new GoogleGenerativeAI(geminiApiKey);
const model = gemini.getGenerativeModel({
  model: modelName,
});

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

async function sleepForOneMinute() {
  console.log(`Rate limit exceeded. Waiting for 1000ms...`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

export async function estimateTokenCount(
  prompt: string,
  maxOutputTokens = 1000
) {
  try {
    return Math.ceil(prompt.length / 4) + maxOutputTokens;
  } catch (error) {
    console.log("Could not estimate token Count");
    if (error instanceof Error) {
      console.log("--------------------------------------");
      console.log("error.stack is ", error.stack);
      console.log("error.message is ", error.message);
      console.log("--------------------------------------");
    }
    throw new Error("Could not estimate token count.");
  }
}

export async function handleRateLimit(tokenCount: number) {
  const limitsResponse = await checkLimits();

  console.log("--------------------------------------");
  console.log("limitsResponse:", limitsResponse);
  console.log("--------------------------------------");

  const { requestsExceeded, tokensExceeded } = limitsResponse;

  if (requestsExceeded || tokensExceeded) {
    await sleepForOneMinute();
  }

  await trackRequest(tokenCount);
}

async function handleRequestExceeded() {
  console.log("-------------------------------");
  console.log("In handleRequest exceeded");
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const key = `${RATE_LIMIT_KEY}:${currentMinute}:requests`;
  await redisConnection.set(key, 16);
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
        sleepForOneMinute();
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
    throw new Error(
      "Could Not generate Repository overview, maybe ai model is down."
    );
  }
}

export async function generateFileAnalysis(repositoryId: string, file: File) {
  for (let i = 0; i < 5; i++) {
    let rawResponse;
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
      Your task is to generate a **structured MDX File Analysis** based on
      the provided repository overview 
      short summaries of all files in the repo, and 
      file Content to analyze. 

      📝 Introduction:  
      - 🔍 **Context About the File:** Briefly describe the file’s role within the project.  
      - 🎯 **Purpose:** Explain what this file does in the project.  
      - 🔗 **Role in Execution:** Highlight how it connects to the application’s flow.  

      📑 File Structure Breakdown:  
      - 📦 **Imports/Dependencies:** List and explain the external libraries or modules used, and why they’re included.  
      - 🏗️ **Key Sections:** Identify the major parts of the file, like variables, functions, or classes.  
      - 🔄 **Flow:** Describe the sequence of operations or logic within the file, if relevant.  

      📜 Step-by-Step Code Explanation:  
      - 🔝 **Start at the Top:** Begin with the imports or the first significant line of code.  
      - 🧠 **Focus on Logic:** Break down what each section does in simple, plain language.  
      - 🚫 **Avoid Jargon Overload:** Briefly define any technical terms to keep it beginner-friendly.  

      🔁 Quick Recap:  
      - 📌 Summarize the file’s purpose, structure, and key takeaways in a concise wrap-up.  

      Here’s the context:
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

      ## 🚀 Guidelines:
      - **MDX format:** Use proper heading levels (#, ##, ###).
      - **Inline code:** Use backticks for code snippets (e.g., \`exampleFunction()\`).
      - **Lists:** Use \`-\` for bullet points, \`1.\` for numbered lists.
      - **Emojis:** Add relevant emojis to make the overview engaging add emoji before the heading text.
      - **No code block wrappers:** Do **not** use triple backticks for MDX content.


      ##  File to Analyze:
      - path: ${file.path}
      - content:
      ${
        file.content ||
        "No content available—analyze based on path and repo context."
      }
      
        ## 🎯 Important:
      - Ensure the output is **valid MDX**.
      - **Directly output MDX content** without wrapping it in code blocks.

      Please generate the MDX file analysis as plain text.
      "`;

      const tokenCount = await estimateTokenCount(prompt);
      await handleRateLimit(tokenCount);

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      rawResponse = result.response.text();

      rawResponse = rawResponse
        .replace(/```json/g, "") // Remove ```json
        .replace(/```/g, "") // Remove ```
        .trim();

      return rawResponse;
    } catch (error) {
      console.log("--------------------------------");
      console.log("file.path is ", file.path);
      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);

        if (
          error.message.includes("Bad control character") ||
          error.message.includes("Bad escaped character")
        ) {
          const res = error.message.match(/at position (\d+)/);
          if (!res) {
            console.log("res is undefined");
            return;
          }

          const position = parseInt(res[1]);
          if (!rawResponse) {
            console.log("rawResponse is undefined");
            return;
          }
          console.log(
            `Character at position ${position}: ${rawResponse[position]}`
          );
          console.log(
            `Context around position ${position}: ${rawResponse.slice(
              position - 10,
              position + 10
            )}`
          );
        }
      }
      console.log("--------------------------------");

      if (
        error instanceof Error &&
        error.message.includes("429 Too Many Requests")
      ) {
        await handleRequestExceeded();
        sleepForOneMinute();
        continue;
      }

      if (
        error instanceof Error &&
        (error.message.includes("Invalid file Analysis response format") ||
          error.stack?.includes("SyntaxError"))
      ) {
        console.log("--------------------------------");
        console.log(`Syntax Error occurred. Trying again for ${i} time`);
        console.log("--------------------------------");
        continue;
      } else {
        throw new Error(
          "Could Not generate file analysis, maybe ai model is down."
        );
      }
    }
  }

  throw new Error("Could Not generate batch analysis, maybe ai model is down.");
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
