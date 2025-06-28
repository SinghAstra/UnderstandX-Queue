import redisClient from "./redis.js";

/**
 * Atomically increment completed jobs and check if all jobs are done
 * Returns true if this increment completed all jobs, false otherwise
 */
export async function checkCompletion(
  completedKey: string,
  totalKey: string
): Promise<boolean> {
  // Add logging to debug the keys
  console.log("🔍 checkCompletion called with:", {
    completedKey,
    totalKey,
    completedKeyType: typeof completedKey,
    totalKeyType: typeof totalKey,
  });

  // Validate inputs
  if (
    !completedKey ||
    !totalKey ||
    typeof completedKey !== "string" ||
    typeof totalKey !== "string"
  ) {
    throw new Error(
      `Invalid keys provided: completedKey=${completedKey}, totalKey=${totalKey}`
    );
  }

  const luaScript = `
    local completedKey = KEYS[1]
    local totalKey = KEYS[2]
    
    -- Fetch completed jobs & total jobs
    local completed = redis.call('GET', completedKey)
    local total = redis.call('GET', totalKey)
    
    -- Convert to numbers for comparison
    completed = tonumber(completed) or 0
    total = tonumber(total) or 0
    
    -- Return 1 if completed equals total, 0 otherwise
    if completed == total and total > 0 then
      return 1
    else
      return 0
    end
  `;

  const result = (await redisClient.eval(
    luaScript,
    2,
    completedKey,
    totalKey
  )) as number;

  return result === 1;
}

// Atomically check rate limits and increment counters if within limits
// Returns { allowed: boolean, currentRequests: number }

export async function checkAndIncrementRateLimit(
  requestsKey: string,
  requestLimit: number
): Promise<{
  allowed: boolean;
  currentRequests: number;
}> {
  const reqCount = await redisClient.get(requestsKey);
  console.log("Before Hand reqCount ", reqCount);
  // Add logging to debug the parameters
  console.log("🔍 checkAndIncrementRateLimit called with:", {
    requestsKey,
    requestLimit,
    requestsKeyType: typeof requestsKey,
    requestLimitType: typeof requestLimit,
  });

  // Validate inputs
  if (!requestsKey || typeof requestsKey !== "string") {
    throw new Error(`Invalid requestsKey: ${requestsKey}`);
  }
  if (typeof requestLimit !== "number" || requestLimit <= 0) {
    throw new Error(`Invalid requestLimit: ${requestLimit}`);
  }

  const luaScript = `
    local requestsKey = KEYS[1]
    local requestLimit = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    
    -- Get current values
    local currentRequests = tonumber(redis.call('GET', requestsKey)) or 0
    
    -- Check if adding this request would exceed limits
    local newRequests = currentRequests + 1
    
    if newRequests > requestLimit then
      -- Return current values without incrementing
      return {0, currentRequests}
    else
      -- Increment counters and set TTL
      redis.call('INCR', requestsKey)
      redis.call('EXPIRE', requestsKey, ttl)
      
      -- Return success with new values
      return {1, newRequests}
    end
  `;

  const result = (await redisClient.eval(
    luaScript,
    1,
    requestsKey,
    requestLimit.toString(),
    "60" // TTL in seconds
  )) as [number, number];

  const [allowed, currentRequests] = result;

  return {
    allowed: allowed === 1,
    currentRequests,
  };
}
