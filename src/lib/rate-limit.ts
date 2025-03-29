import redisConnection from "./redis.js";

const REQUEST_LIMIT = 15; // max requests per minute
const TOKEN_LIMIT = 1000000; // adjust based on your needs

const RATE_LIMIT_KEY = "global:rate_limit";

export async function trackRequest(tokenCount: number) {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000); // round to the nearest minute

  const key = `${RATE_LIMIT_KEY}:${currentMinute}`;

  const result = await redisConnection
    .multi()
    .incr(`${key}:requests`)
    .incrby(`${key}:tokens`, tokenCount)
    .expire(`${key}:requests`, 60)
    .expire(`${key}:tokens`, 60)
    .exec();

  if (!result) {
    throw new Error("Redis transaction failed");
  }

  const [requests, tokens] = result.map(([err, res]) => {
    if (err) throw err;
    return res;
  });

  return { requests, tokens };
}

export async function checkLimits() {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const key = `${RATE_LIMIT_KEY}:${currentMinute}`;

  const [requests, tokens] = await redisConnection.mget(
    `${key}:requests`,
    `${key}:tokens`
  );

  return {
    requests: parseInt(requests ?? "0"),
    tokens: parseInt(tokens ?? "0"),
    requestsExceeded: parseInt(requests ?? "0") >= REQUEST_LIMIT,
    tokensExceeded: parseInt(tokens ?? "0") >= TOKEN_LIMIT,
  };
}
