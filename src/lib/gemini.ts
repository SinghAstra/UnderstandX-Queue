import { GoogleGenerativeAI } from "@google/generative-ai";
import { File } from "@prisma/client";
import dotenv from "dotenv";
import { prisma } from "./prisma.js";
import redisConnection from "./redis.js";

dotenv.config();

const REQUEST_LIMIT = 15;
const TOKEN_LIMIT = 800000;
const RATE_LIMIT_KEY = "global:rate_limit";

const MODEL_FALLBACKS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash-8b",
];
const MAX_RETRIES = MODEL_FALLBACKS.length;

type Summary = {
  path: string;
  summary: string;
};

type Analysis = {
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const modelName = MODEL_FALLBACKS[attempt];
    const model = genAI.getGenerativeModel({ model: modelName });
    try {
      const inputTokenCount = await model.countTokens(prompt);
      return inputTokenCount.totalTokens + maxOutputTokens;
    } catch (error) {
      // rough estimate
      console.log(
        `Attempt ${attempt + 1} with ${modelName} failed: ${
          error instanceof Error && error.message
        }`
      );

      if (attempt + 1 === MAX_RETRIES) {
        throw new Error(`All retries (${MAX_RETRIES}) exhausted.`);
      }

      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }
    }
  }
  throw new Error("Could Not estimate token, maybe ai model is down.");
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const modelName = MODEL_FALLBACKS[attempt];
    const model = genAI.getGenerativeModel({ model: modelName });
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
      console.log(
        `Attempt ${attempt + 1} with ${modelName} failed: ${
          error instanceof Error && error.message
        }`
      );

      if (attempt + 1 === MAX_RETRIES) {
        throw new Error(`All retries (${MAX_RETRIES}) exhausted.`);
      }

      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }
    }
  }
  throw new Error(
    "Could Not generate batch summaries, maybe ai model is down."
  );
}

export async function getRepositoryOverview(repositoryId: string) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const modelName = MODEL_FALLBACKS[attempt];
    const model = genAI.getGenerativeModel({ model: modelName });
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
      console.log(
        `Attempt ${attempt + 1} with ${modelName} failed: ${
          error instanceof Error && error.message
        }`
      );

      if (attempt + 1 === MAX_RETRIES) {
        throw new Error(`All retries (${MAX_RETRIES}) exhausted.`);
      }

      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }
    }
  }
  throw new Error(
    "Could Not generate Repository overview, maybe ai model is down."
  );
}

export async function generateFileAnalysis(repositoryId: string, file: File) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const modelName = MODEL_FALLBACKS[attempt];
    const model = genAI.getGenerativeModel({ model: modelName });
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
      "I’m giving you a repo overview, short summaries of all files in the repo, and an file Content to analyze. I want you to explain file like you’re writing a blog post for a curious beginner who’s excited to learn programming. Your explanation should include:
      - A beginner-friendly overview of what the file does in the repo.
      - Any underlying theory (e.g., OOP, algorithms like sorting, or data structures like arrays) and why it matters here.
      - Detailed explanations of all variables and functions—why they exist and how they work.
      - The approach taken—why it’s coded this way, what problems it solves, and any trade-offs or alternatives worth considering.
      - Tips or insights to help a newbie understand and apply these ideas.


      Here’s the context:
      ## 📦 Repository Overview:
      ${
        repository.overview ||
        "No overview provided—make reasonable guesses based on file paths and content."
      }

      ## 📚 File Summaries:
      ${
        fileSummaries ||
        "No summaries available—use file paths and content to infer roles."
      }

      ## 🎯 Task:
      Analyze file below in detail. For return the analysis in **MDX format** - Aim for 300–700 words per file, adjusting based on complexity..

      ## 🚀 Formatting Guidelines:
      - Use **emojis** to make it fun and readable, Add emoji before the heading text.
      - Output **direct MDX content** for the analysis—no code blocks around it.
      - If content is long, focus on key excerpts or its overall structure.
      - Where relevant, connect the file to others in the repo (e.g., imports or dependencies).


      ## 🗂️ File to Analyze:
      ${`
      path: ${file.path}
      content:
      ${
        file.content ||
        "No content available—analyze based on path and repo context."
      }
      `}
      
      ## 📝 Example Response (for reference):
      Below is a snippet of how the analysis might look for a simple file:

      ---
      ✨ # Understanding utils/sortArray.js

      Hey there, coding newbie! Today, we’re diving into utils/sortArray.js, a handy little file in our repo that helps organize messy lists of numbers or words. Think of it like a librarian sorting books alphabetically—it makes everything neat and tidy! This file is part of a bigger project (check out the repo overview), and it’s often used by main.js to prep data before displaying it.

      🌟 ### What It Does
      This file exports a function called sortArray that takes an array (like [3, 1, 4, 1]) and returns it sorted ([1, 1, 3, 4]). It’s super useful whenever we need order—like ranking scores or listing names.

      🧠 ### The Theory: Sorting Algorithms
      Sorting is a classic problem in programming. Here, we’re using JavaScript’s built-in sort() method, which under the hood uses a fast algorithm (often QuickSort or similar). Why does this matter? It saves us time compared to writing our own sorting logic from scratch!

      🔍 ### Breaking Down the Code
      - **Variable: arr**  
        This is the input array you pass in. It could be numbers, strings—whatever you want sorted!
      - **Function: sortArray(arr)**  
        This takes arr, calls arr.sort(), and returns the result. Simple, right? The sort() method rearranges arr in place, so we don’t need extra memory.

      ⚙️ ### Why This Approach?
      Using sort() is quick and reliable, but it has a trade-off: it modifies the original array. If we wanted to keep the original, we’d need to clone it first with [...arr]. For now, this works since main.js doesn’t care about the original order.

      💡 ### Tips for Newbies
      Try playing with sort() in your browser console! Type [5, 2, 9].sort() and see what happens. Want a challenge? Research how to sort numbers correctly with a comparison function like arr.sort((a, b) => a - b).

      ---

      This is just a taste—your analysis should expand on this style!
      "`;

      const tokenCount = await estimateTokenCount(prompt);
      await handleRateLimit(tokenCount);

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      const analysis = JSON.parse(result.response.text());

      console.log("path --generateFileAnalysis is ", file.path);
      console.log("typeof analysis is ", typeof analysis);

      // console.log("analysis is ", analysis);

      return analysis;
    } catch (error) {
      console.log(
        `Attempt ${attempt + 1} with ${modelName} failed: ${
          error instanceof Error && error.message
        }`
      );

      if (attempt + 1 === MAX_RETRIES) {
        throw new Error(`All retries (${MAX_RETRIES}) exhausted.`);
      }

      if (error instanceof Error) {
        console.log("error.stack is ", error.stack);
        console.log("error.message is ", error.message);
      }
    }
  }
  throw new Error("Could Not generate batch analysis, maybe ai model is down.");
}
