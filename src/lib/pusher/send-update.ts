import { ProcessingUpdate } from "../../interfaces/processing.js";
import pusherServer from "./server.js";

export const sendProcessingUpdate = async (
  repositoryId: string,
  update: ProcessingUpdate
) => {
  const channel = `repository-${repositoryId}`;
  await pusherServer.trigger(channel, "processing-update", update);
};
