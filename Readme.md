# UnderstandX-Queue

This project manages asynchronous processing of GitHub repositories, generating summaries and analysis using AI. It leverages a queue-based architecture for efficient task management and utilizes a database for persistent storage. The system includes robust authentication and authorization mechanisms.

## 🧰 Technology Stack

| Technology       | Purpose/Role                                                |
| ---------------- | ----------------------------------------------------------- |
| Node.js          | Server-side JavaScript runtime environment.                 |
| Express.js       | Web framework for creating RESTful APIs.                    |
| TypeScript       | Adds static typing to JavaScript.                           |
| Prisma           | ORM for database access and schema management.              |
| PostgreSQL       | Relational database for persistent data storage.            |
| Redis            | In-memory data store for job queues and caching.            |
| BullMQ           | Queue library for managing asynchronous tasks.              |
| Octokit          | GitHub API client library.                                  |
| Google Gemini AI | AI model for generating code summaries and analysis.        |
| JWT              | JSON Web Tokens for authentication and authorization.       |
| Pusher           | Real-time messaging service for sending processing updates. |

## 📁 File Structure and Purpose

| File Path                                                      | Description                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `package.json`                                                 | Project dependencies, scripts, and metadata.                                                     |
| `tsconfig.json`                                                | TypeScript compiler options.                                                                     |
| `prisma/schema.prisma`                                         | Defines the data model for the application using Prisma.                                         |
| `prisma/migrations/20250424221308_add_log_model/migration.sql` | SQL migration script creating the User table and enums for RepositoryStatus and DirectoryStatus. |
| `prisma/migrations/20250426202017_added_logs/migration.sql`    | SQL migration adding a `status` column to the `Log` table.                                       |
| `prisma/migrations/migration_lock.toml`                        | Prisma migration lock file.                                                                      |
| `src/index.ts`                                                 | Main application entry point.                                                                    |
| `src/lib/constants.ts`                                         | Defines constants related to queues, batch sizes, and concurrent workers.                        |
| `src/lib/gemini.ts`                                            | Interacts with Google Gemini AI for summaries and analysis.                                      |
| `src/lib/github.ts`                                            | Provides functions to interact with the GitHub API.                                              |
| `src/lib/prisma.ts`                                            | Establishes a Prisma Client connection to the database.                                          |
| `src/lib/redis.ts`                                             | Sets up a Redis client connection.                                                               |
| `src/lib/redis-keys.ts`                                        | Defines functions for generating Redis keys.                                                     |
| `src/lib/prompt.ts`                                            | Defines system prompts for generating summaries.                                                 |
| `src/lib/pusher/server.ts`                                     | Initializes a Pusher server instance.                                                            |
| `src/lib/pusher/send-update.ts`                                | Sends processing updates to a Pusher channel.                                                    |
| `src/lib/cancel-jobs.ts`                                       | Cancels all jobs associated with a given repository ID.                                          |
| `src/interfaces/github.ts`                                     | Defines the `GitHubContent` interface.                                                           |
| `src/middleware/verify-service-token.ts`                       | Verifies service tokens using JWT.                                                               |
| `src/middleware/verify-clean-job-token.ts`                     | Verifies clean job tokens using JWT.                                                             |
| `src/controllers/queue.ts`                                     | Controller for adding jobs to the repository queue.                                              |
| `src/controllers/clean.ts`                                     | Controller for handling job cancellation.                                                        |
| `src/routes/queue.ts`                                          | Defines Express.js route for adding jobs to the queue.                                           |
| `src/routes/clean.ts`                                          | Defines Express.js routes for cleaning jobs.                                                     |
| `src/queues/index.ts`                                          | Defines and exports BullMQ queues.                                                               |
| `src/workers/repository.ts`                                    | Manages the overall repository processing workflow.                                              |
| `src/workers/directory.ts`                                     | Fetches GitHub repository content in batches.                                                    |
| `src/workers/analysis.ts`                                      | Processes file analysis using the Gemini library.                                                |
| `src/workers/summary.ts`                                       | Generates summaries for code files using the Gemini library.                                     |
| `src/workers/log.ts`                                           | Handles logging and updates for repository processing.                                           |
| `package-lock.json`                                            | Automatically generated file containing information about project dependencies.                  |
| `Readme.md`                                                    | Placeholder README file.                                                                         |
