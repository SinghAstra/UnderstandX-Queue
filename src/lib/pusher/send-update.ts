import { v4 as uuid } from "uuid";
import { ProcessingUpdate } from "../../interfaces/processing.js";
import pusherServer from "./server.js";

export const sendProcessingUpdate = async (
  repositoryId: string,
  update: ProcessingUpdate
) => {
  const channel = `repository-${repositoryId}`;
  await pusherServer.trigger(channel, "processing-update", {
    ...update,
    id: uuid(),
    timestamp: new Date(),
  });
};
