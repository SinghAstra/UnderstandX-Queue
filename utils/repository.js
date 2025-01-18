export async function processFilesIntoChunks(repoFiles) {
  const chunks = [];
  const CHUNK_SIZE = 1000; // Characters per chunk
  const OVERLAP = 100; // Overlap between chunks to maintain context

  for (const file of repoFiles) {
    // Skip binary files, large files, or unwanted file types
    if (shouldSkipFile(file)) {
      continue;
    }

    const fileContent = file.content;

    // For very small files, create a single chunk
    if (fileContent.length <= CHUNK_SIZE) {
      chunks.push({
        content: fileContent,
        filepath: file.path,
        type: file.type,
        keywords: extractKeywords(fileContent),
        embeddings: [], // Will be populated later
      });
      continue;
    }

    // For larger files, create overlapping chunks
    let startIndex = 0;
    while (startIndex < fileContent.length) {
      const endIndex = Math.min(startIndex + CHUNK_SIZE, fileContent.length);

      // Find a good break point (end of sentence or line)
      const adjustedEndIndex = findBreakPoint(fileContent, endIndex);

      const chunkContent = fileContent.slice(startIndex, adjustedEndIndex);
      // console.log("chunkContent is ", chunkContent);

      chunks.push({
        content: chunkContent,
        filepath: file.path,
        type: file.type,
        keywords: extractKeywords(chunkContent),
        embeddings: [], // Will be populated later
      });

      // Move to next chunk, ensuring forward progress
      if (adjustedEndIndex <= startIndex + OVERLAP) {
        // If we couldn't find a good break point that makes progress,
        // force moving forward by CHUNK_SIZE/2 to prevent infinite loop
        startIndex += Math.floor(CHUNK_SIZE / 2);
      } else {
        startIndex = adjustedEndIndex - OVERLAP;
      }
    }
  }

  return chunks;
}

function shouldSkipFile(file) {
  const SKIP_EXTENSIONS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".ico",
    ".ttf",
    ".woff",
    ".woff2",
    ".eot",
    ".mp3",
    ".mp4",
    ".wav",
    ".avi",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
  ];

  const MAX_FILE_SIZE = 1000000; // 1MB

  // Skip binary files
  if (file.type.includes("binary")) return true;

  // Skip by extension
  if (SKIP_EXTENSIONS.some((ext) => file.path.toLowerCase().endsWith(ext)))
    return true;

  // Skip large files
  if (file.content.length > MAX_FILE_SIZE) return true;

  return false;
}

function findBreakPoint(content, index) {
  // Look for a good break point within 100 characters of the suggested index
  const searchRange = 100;
  const endSearch = Math.min(content.length, index + searchRange);
  const startSearch = Math.max(0, index - searchRange);

  // Priority: paragraph break > sentence break > word break
  const searchSlice = content.slice(startSearch, endSearch);

  // Look for paragraph break
  const paragraphMatch = searchSlice.match(/\n\s*\n/);
  if (paragraphMatch) {
    return startSearch + paragraphMatch.index + paragraphMatch[0].length;
  }

  // Look for sentence break
  const sentenceMatch = searchSlice.match(/[.!?]\s/);
  if (sentenceMatch) {
    return startSearch + sentenceMatch.index + 2;
  }

  // Fall back to word break
  const wordMatch = searchSlice.match(/\s/);
  if (wordMatch) {
    return startSearch + wordMatch.index + 1;
  }

  // If no good break point found, just use the original index
  return index;
}

function extractKeywords(content) {
  const words = content
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3); // Filter out short words

  const commonWords = new Set(["from", "this", "that", "with", "have", "what"]);
  const uniqueWords = [...new Set(words)]
    .filter((word) => !commonWords.has(word))
    .slice(0, 10); // Keep top 10 keywords

  return uniqueWords;
}
