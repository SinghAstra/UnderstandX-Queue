import dotenv from "dotenv";
import Pusher from "pusher";

dotenv.config();
const PUSHER_APP_ID = process.env.PUSHER_APP_ID;
const NEXT_PUBLIC_PUSHER_APP_KEY = process.env.NEXT_PUBLIC_PUSHER_APP_KEY;
const PUSHER_SECRET = process.env.PUSHER_SECRET;
const NEXT_PUBLIC_PUSHER_CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

// Check if required environment variables are present
if (
  !PUSHER_APP_ID ||
  !NEXT_PUBLIC_PUSHER_APP_KEY ||
  !PUSHER_SECRET ||
  !NEXT_PUBLIC_PUSHER_CLUSTER
) {
  throw new Error("Missing pusher environment variable");
}

const pusherServer = new Pusher({
  appId: PUSHER_APP_ID,
  key: NEXT_PUBLIC_PUSHER_APP_KEY,
  secret: PUSHER_SECRET,
  cluster: NEXT_PUBLIC_PUSHER_CLUSTER,
  useTLS: true,
});

export default pusherServer;
