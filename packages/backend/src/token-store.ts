/**
 * token-store.ts — Redis-backed conversation bearer tokens
 *
 * 1 credit = 1 chat session = $1.00 balance.
 * The ZK proof is burned once at chat session start; subsequent messages
 * use the bearer token until the balance runs out or it expires (24h).
 *
 * Keys:
 *   token:{id}                     → Hash { balanceRemaining, nullifierHash, root, depth, createdAt, lastUsed }
 *   token_by_nullifier:{nullifier} → Set of tokenIds (reference only)
 */

import crypto from "crypto";
import { Redis } from "@upstash/redis";

// ─── Redis instance (same Upstash DB as nullifiers) ───────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export const TOKEN_TTL_SECONDS = 86400; // 24 hours
export const INITIAL_BALANCE = 1.0; // USD

export interface TokenData {
  balanceRemaining: number;
  nullifierHash: string;
  root: string;
  depth: number;
  createdAt: number;
  lastUsed: number;
}

/**
 * Create a new conversation token after proof verification.
 * Returns a 256-bit random hex tokenId.
 */
export async function createToken(
  nullifierHash: string,
  root: string,
  depth: number,
): Promise<string> {
  const tokenId = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const key = `token:${tokenId}`;

  await redis.hset(key, {
    balanceRemaining: INITIAL_BALANCE.toString(),
    nullifierHash,
    root,
    depth: depth.toString(),
    createdAt: now.toString(),
    lastUsed: now.toString(),
  });
  await redis.expire(key, TOKEN_TTL_SECONDS);

  // Reference index: nullifier → tokenIds (for debugging/cleanup)
  const nullifierKey = `token_by_nullifier:${nullifierHash}`;
  await redis.sadd(nullifierKey, tokenId);
  await redis.expire(nullifierKey, TOKEN_TTL_SECONDS);

  return tokenId;
}

/**
 * Look up a conversation token. Returns null if not found or expired.
 */
export async function getToken(tokenId: string): Promise<TokenData | null> {
  const key = `token:${tokenId}`;
  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) return null;

  return {
    balanceRemaining: parseFloat(data.balanceRemaining as string),
    nullifierHash: data.nullifierHash as string,
    root: data.root as string,
    depth: parseInt(data.depth as string, 10),
    createdAt: parseInt(data.createdAt as string, 10),
    lastUsed: parseInt(data.lastUsed as string, 10),
  };
}

export interface DeductResult extends TokenData {
  conversationEnded: boolean;
}

/**
 * Deduct cost from a token's balance. Updates lastUsed.
 * Allows overshoot on the final call — if balance < cost, the call still
 * succeeds but balance drops to $0 and conversationEnded is set.
 * Returns null only if the token is not found or balance is already 0.
 */
export async function deductToken(
  tokenId: string,
  costUsd: number,
): Promise<DeductResult | null> {
  const token = await getToken(tokenId);
  if (!token) return null;

  if (token.balanceRemaining <= 0) return null;

  const newBalance = Math.max(0, token.balanceRemaining - costUsd);
  const now = Date.now();
  const key = `token:${tokenId}`;

  await redis.hset(key, {
    balanceRemaining: newBalance.toString(),
    lastUsed: now.toString(),
  });

  return {
    ...token,
    balanceRemaining: newBalance,
    lastUsed: now,
    conversationEnded: newBalance <= 0,
  };
}

/**
 * Count active (non-expired) tokens. Uses SCAN to avoid blocking.
 */
export async function countActiveTokens(): Promise<number> {
  let count = 0;
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(Number(cursor), { match: "token:*", count: 100 }) as [string, string[]];
    cursor = String(nextCursor);
    // Filter out token_by_nullifier keys
    count += keys.filter(k => !k.startsWith("token_by_nullifier:")).length;
  } while (cursor !== "0");
  return count;
}
