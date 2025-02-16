import dotenv from "dotenv";
import Pusher from "pusher";

dotenv.config();
const appId = process.env.PUSHER_APP_ID;
const key = process.env.NEXT_PUBLIC_PUSHER_APP_KEY;
const secret = process.env.PUSHER_SECRET;
const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

// Check if required environment variables are present
if (!appId || !cluster || !secret || !key) {
  throw new Error("Missing pusher environment variable");
}

const pusherServer = new Pusher({
  appId,
  key,
  secret,
  cluster,
  useTLS: true,
});

export default pusherServer;
