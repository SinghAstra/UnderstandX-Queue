import prisma from "../db/prisma.js";
import { batchGenerateEmbeddings } from "../utils/gemini.js";
import { fetchGitHubRepoData } from "../utils/github.js";
import { processFilesIntoChunks } from "../utils/repository.js";

const clients = new Map();

// Helper function to send SSE updates
export function sendSSEUpdate(repositoryId, data) {
  console.log(data);
  const repositoryClients = clients.get(repositoryId) || [];
  repositoryClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

export const repoProcessingController = (req, res) => {
  console.log("In repoProcessingController.");
  try {
    const { userId, repositoryId } = req.user;
    const { githubUrl } = req.body;
    console.log("userId: " + userId);
    console.log("repositoryId: " + repositoryId);
    console.log("githubUrl: " + githubUrl);
    // Send immediate response
    res.status(200).json({ message: "Processing started" });

    // Start background processing
    processRepositoryInBackground(repositoryId, githubUrl);
  } catch (error) {
    console.error("Repository processing error.");
    if (error instanceof Error) {
      console.error("Error message is ", error.message);
      console.error("Error stack is ", error.stack);
    }
    res.status(500).json({ error: "Failed to process repository" });
  }
};

async function processRepositoryInBackground(repositoryId, githubUrl) {
  try {
    console.log("in processRepositoryInBackground");
    sendSSEUpdate(repositoryId, {
      status: "PROCESSING",
      message: "Fetching repository details",
    });
    // 1. Fetch repository details
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
    });
    console.log("repository is ", repository);

    if (!repository) {
      throw new Error("Repository not found");
    }

    sendSSEUpdate(repositoryId, {
      status: "PROCESSING",
      message: "Fetching files from GitHub",
    });
    // 3. Fetch GitHub repo files
    const repoData = await fetchGitHubRepoData(githubUrl, false);

    sendSSEUpdate(repositoryId, {
      status: "PROCESSING",
      message: "Fetched all files from GitHub",
    });

    console.log("repoData is fetched");
    // 4. Process files into chunks

    const chunks = await processFilesIntoChunks(repoData.files);
    console.log("chunks are processed");
    sendSSEUpdate(repositoryId, {
      status: "PROCESSING",
      message: "Generated Chunks From the File",
    });

    // 5. Save chunks to database
    await prisma.repositoryChunk.createMany({
      data: chunks.map((chunk) => ({
        repositoryId,
        content: chunk.content,
        type: chunk.type,
        filepath: chunk.filepath,
        keywords: chunk.keywords,
      })),
    });

    console.log("Saved Chunks to database");

    const chunksForEmbedding = await prisma.repositoryChunk.findMany({
      where: {
        repositoryId,
        embeddings: { equals: null },
      },
      select: { id: true, content: true },
    });

    console.log("Fetched Chunks with no embedding");

    const BATCH_SIZE = 5;
    if (chunksForEmbedding.length > 0) {
      const chunkTexts = chunksForEmbedding.map((chunk) => chunk.content);
      const embeddingResults = await batchGenerateEmbeddings(
        chunkTexts,
        BATCH_SIZE
      );

      // Update chunks with embeddings
      await Promise.all(
        chunksForEmbedding.map((chunk, index) => {
          const result = embeddingResults[index];
          if (!result.error) {
            return prisma.repositoryChunk.update({
              where: { id: chunk.id },
              data: { embeddings: result.embeddings },
            });
          }
        })
      );
    }

    sendSSEUpdate(repositoryId, {
      status: "PROCESSING",
      message: "Generated Embedding From the Chunks...",
    });

    // 7. Update final status
    console.log("Success");
    await updateStatus(repositoryId, "SUCCESS");
  } catch (error) {
    console.error("Background processing error:", error);
    await updateStatus(repositoryId, "FAILED");
    sendSSEUpdate(repositoryId, {
      status: "FAILED",
      message: error instanceof Error ? error.message : "Processing failed",
    });
  }
}

async function updateStatus(repositoryId, status) {
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { status },
  });
}

export const streamProcessingController = (req, res) => {
  const repositoryId = req.params.id;

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Add this client to the clients map
  const repositoryClients = clients.get(repositoryId) || [];
  clients.set(repositoryId, [...repositoryClients, res]);

  console.log("Client has been added to map");

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30000);

  // Clean up on client disconnect
  req.on("close", () => {
    clearInterval(keepAlive);
    const clients_ = clients.get(repositoryId) || [];
    clients.set(
      repositoryId,
      clients_.filter((client) => client !== res)
    );
  });
};
