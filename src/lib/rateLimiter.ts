import { RateLimiter } from "limiter";

// Configure based on your API's limits
// For Gemini, start conservative and adjust as needed
const REQUESTS_PER_MINUTE = 15;

// Create a singleton limiter instance
export const aiRequestLimiter = new RateLimiter({
  tokensPerInterval: REQUESTS_PER_MINUTE,
  interval: "minute",
  fireImmediately: false, // This makes removeTokens() wait instead of failing
});

/**
 * Acquire a rate limit token before making an API call
 * @returns {Promise<void>} Resolves when a token is available
 */
export async function acquireRateLimit(): Promise<void> {
  // This will pause execution until a token is available
  await aiRequestLimiter.removeTokens(1);
}
