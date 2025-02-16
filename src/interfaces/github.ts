export interface GitHubContent {
  name: string;
  type: "file" | "dir";
  path: string;
  content?: string;
}
