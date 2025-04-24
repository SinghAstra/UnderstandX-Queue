import { Log } from "@prisma/client";
import pusherServer from "./server.js";

export const sendProcessingUpdate = async (repositoryId: string, log: Log) => {
  const channel = `repository-${repositoryId}`;
  await pusherServer.trigger(channel, "processing-update", log);
};
