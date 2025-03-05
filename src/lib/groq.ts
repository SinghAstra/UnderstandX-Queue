import dotenv from "dotenv";
import Groq from "groq-sdk";
import { prisma } from "./prisma.js";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("Missing GROQ_API_KEY environment variable.");
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_FALLBACKS = ["llama-3.3-70b-versatile"];
const MAX_RETRIES = MODEL_FALLBACKS.length;

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

export async function generateBatchSummaries(
  files: { id: string; path: string; content: string | null }[]
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const modelName = MODEL_FALLBACKS[attempt];
    try {
      const filePaths = new Set(files.map((file) => file.path));

      const prompt = `
      Summarize each of the following files in 1-2 sentences, focusing on its purpose and main functionality. Return the summaries as a valid JSON array where each object has 'path' and 'summary' properties. Example response:
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

      const result = await groq.chat.completions.create({
        messages: [
          { role: "system", content: "You are a code assistant." },
          { role: "user", content: prompt },
        ],
        model: modelName,
      });

      if (!result.choices[0].message.content) {
        throw new Error(
          "Invalid response from OpenAI model --generateBatchSummaries"
        );
      }

      const summaries: Summary[] = JSON.parse(
        result.choices[0].message.content
      );

      console.log("summaries --groq is ", summaries);

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

      const result = await groq.chat.completions.create({
        messages: [
          { role: "system", content: "You are a code assistant." },
          { role: "user", content: prompt },
        ],
        model: modelName,
      });

      if (!result.choices[0].message.content) {
        throw new Error(
          "Invalid response from OpenAI model --generateBatchSummaries"
        );
      }

      const repositoryOverview = result.choices[0].message.content;

      console.log("repositoryOverview --groq is ", repositoryOverview);

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

export async function generateBatchAnalysis(
  repositoryId: string,
  filesWithoutAnalysis: { path: string; id: string; content: string | null }[],
  repoOverview: string
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const modelName = MODEL_FALLBACKS[attempt];
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
      "I’m giving you a repo overview, short summaries of all files in the repo, and an array of files (with their paths and content) to analyze. I want you to explain each file like you’re writing a blog post for a curious beginner who’s excited to learn programming. Your explanation should include:  
      - A beginner-friendly overview of what the file does in the repo.  
      - A breakdown of key programming concepts (e.g., loops, functions, async patterns) with simple examples or analogies (like comparing a loop to a conveyor belt).  
      - Any underlying theory (e.g., OOP, algorithms like sorting, or data structures like arrays) and why it matters here.  
      - The approach taken—why it’s coded this way, what problems it solves, and any trade-offs or alternatives worth considering.  
      - Tips or insights to help a newbie understand and apply these ideas.  

      - Detailed explanations of all variables and functions—why they exist and how they work. 
      
      Here’s the context:  
      ## 📦 Repository Overview:  
      ${
        repoOverview ||
        "No overview provided—make reasonable guesses based on file paths and content."
      }  
      
      ## 📚 File Summaries:  
      ${
        fileSummaries ||
        "No summaries available—use file paths and content to infer roles."
      }  
      
      ## 🎯 Task:  
      Analyze each file below in detail. For each, return the analysis as part of a **valid JSON array**, where each object has:  
      - **path:** The file path (string).  
      - **analysis:** A detailed explanation in **MDX format** - Aim for 300–500 words per file, adjusting based on complexity..  
      
      ## 🚀 Formatting Guidelines:  
      - Use **emojis** to make it fun and readable, Add emoji before the heading text.
      - Output **direct MDX content** for the analysis—no code blocks around it.  
      - Keep analyses **non-empty**, relevant, and tied to the file’s content or inferred purpose.  
      - If content is missing, base the analysis on the file’s role in the repo (guessed from its path and summaries).  
      - If content is long, focus on key excerpts or its overall structure.  
      - Where relevant, connect the file to others in the repo (e.g., imports or dependencies).  
      
      ## ✅ Example Response:  
      \`\`\`json  
      [  
        {  
          "path": "src/utils.js",  
          "analysis": "### 🔧 What’s This File Do?\nThe \`utils.js\` file is like a toolbox for string tricks, with functions like \`capitalize\` and \`truncate\`.\n\n### 🏗️ Key Concepts\n- **Functions:** Think of them as mini recipes—give them ingredients (parameters), and they cook up a result.\n- **String Manipulation:** It’s like editing a sentence with scissors and glue.\n\n### 🧠 Theory Time\nThis uses functional programming ideas—small, reusable tools instead of big, messy code.\n\n### 🎨 The Approach\nIt’s simple and focused, but could add error checks for empty strings.\n\n### 💡 Beginner Tip\nTry writing your own function to reverse a string!"  
        }  
      ]  
      \`\`\`  
      
      ## 🗂️ Files to Analyze:  
      ${filesWithoutAnalysis
        .map(
          (file) => `
      path: ${file.path}  
      content:  
      ${
        file.content ||
        "No content available—analyze based on path and repo context."
      }  
      `
        )
        .join("\n")}  
      
      **Important:**  
      - Output a **valid JSON array**.  
      - Ensure every file gets a **non-empty analysis**.  
      "`;

      const result = await groq.chat.completions.create({
        messages: [
          { role: "system", content: "You are a code assistant." },
          { role: "user", content: prompt },
        ],
        model: modelName,
      });

      if (!result.choices[0].message.content) {
        throw new Error(
          "Invalid response from OpenAI model --generateBatchSummaries"
        );
      }

      const analyses: Analysis[] = JSON.parse(
        result.choices[0].message.content
      );

      console.log("analyses --groq are ", analyses);

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
