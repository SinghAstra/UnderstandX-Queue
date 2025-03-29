import { Octokit } from "@octokit/rest";
import { GitHubContent } from "../interfaces/github.js";
import { sendProcessingUpdate } from "./pusher/send-update.js";

const auth = process.env.GITHUB_ACCESS_TOKEN;

if (!auth) {
  throw new Error("GITHUB_ACCESS_TOKEN is required.");
}

const octokit = new Octokit({
  auth,
});

// This method :
// 1. Checks if repo Url is valid
// 2. Returns owner and repo
export function parseGithubUrl(url: string) {
  const regex = /github\.com\/([^\/]+)\/([^\/]+)/;

  if (!url) {
    return { isValid: false, message: "Please enter a GitHub repository URL" };
  }

  const match = url.match(regex);

  try {
    if (!match) {
      return {
        isValid: false,
        message: "Please enter a valid GitHub repository URL.",
      };
    }

    const [, owner, repo] = match;
    return {
      isValid: true,
      owner,
      repo: repo.replace(".git", ""),
    };
  } catch {
    return {
      isValid: false,
      message: "Please enter a valid URL",
    };
  }
}

export async function fetchGitHubRepoMetaData(owner: string, repo: string) {
  const { data } = await octokit.repos.get({
    owner,
    repo,
  });

  return {
    githubId: data.id,
    name: data.name,
    fullName: data.full_name,
    description: data.description,
    owner: data.owner.login,
    url: data.html_url,
    isPrivate: data.private,
    avatarUrl: data.owner.avatar_url,
    stargazersCount: data.stargazers_count,
    watchersCount: data.watchers_count,
    forksCount: data.forks_count,
  };
}

export async function fetchGithubContent(
  owner: string,
  repo: string,
  path: string,
  repositoryId: string
) {
  const items: GitHubContent[] = [];

  try {
    const { data: contents } = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    for (const item of Array.isArray(contents) ? contents : [contents]) {
      if (item.type === "file" && isProcessableFile(item.name)) {
        const { data: fileData } = await octokit.repos.getContent({
          owner,
          repo,
          path: item.path,
        });

        if ("content" in fileData) {
          const content = Buffer.from(fileData.content, "base64").toString(
            "utf-8"
          );
          items.push({
            type: "file",
            name: item.name,
            path: item.path,
            content,
          });
        }

        await sendProcessingUpdate(repositoryId, {
          status: "PROCESSING",
          message: `Fetching ${item.path}`,
        });
      } else if (item.type === "dir") {
        items.push({
          path: item.path,
          type: "dir",
          name: item.name,
        });
      }
    }
  } catch (error) {
    console.log(`Error fetching content for ${owner}/${repo}/${path}:`, error);
  }

  return items;
}

function isProcessableFile(filename: string): boolean {
  const processableExtensions = [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".go",
    ".rb",
    ".php",
    ".swift",
    ".kt",
    ".rs",
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".xml",
    ".sql",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
  ];

  const extension = filename.toLowerCase().split(".").pop();
  return extension ? processableExtensions.includes(`.${extension}`) : false;
}
