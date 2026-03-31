import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { createPublicClient, http, webSocket, parseAbi, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { Barretenberg, Fr } from "@aztec/bb.js";
import { VerifierPool } from "./verifier-pool.js";
import { createToken, getToken, deductToken, TOKEN_TTL_SECONDS, INITIAL_BALANCE } from "./token-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Initialize Barretenberg for Poseidon2 hashing ────────────
// bb.js poseidon2Hash is the ONLY correct Poseidon2 implementation
// that matches Noir's Poseidon2::hash and the on-chain LibPoseidon2.
// DO NOT use poseidon-lite — its "poseidon2" is original Poseidon with 2 inputs,
// which is a completely different hash function.
let bb: Barretenberg;

async function poseidon2Hash(left: bigint, right: bigint): Promise<bigint> {
  const result = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
  return BigInt(result.toString());
}

// ─── Precomputed zero hashes (computed at startup) ────────────
const MAX_DEPTH = 16;
let zeros: bigint[] = [];

async function precomputeZeros() {
  zeros = new Array(MAX_DEPTH);
  // Poseidon2IMT: zeros[0] = poseidon2(0, 0), zeros[i+1] = poseidon2(zeros[i], zeros[i])
  zeros[0] = await poseidon2Hash(0n, 0n);
  for (let i = 0; i < MAX_DEPTH - 1; i++) {
    zeros[i + 1] = await poseidon2Hash(zeros[i], zeros[i]);
  }
  console.log("Zero hashes precomputed.");
}

// ─── Configuration ────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const VENICE_API_KEY = process.env.VENICE_API_KEY as string;
if (!VENICE_API_KEY) throw new Error("VENICE_API_KEY is required — set it in packages/api-server/.env");
const VENICE_BASE_URL =
  process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}`;
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const WS_URL = process.env.WS_URL || "";
const NULLIFIER_FILE = process.env.NULLIFIER_FILE || "./data/spent-nullifiers.json";

// Circuit bytecode path — loaded by VerifierPool for UltraHonk proof verification
const CIRCUIT_PATH = process.env.CIRCUIT_PATH || path.resolve(
  __dirname,
  "../../circuits/target/circuits.json"
);

// Worker pool for proof verification (initialized in start())
let verifierPool: VerifierPool;

// ─── On-Chain Root Verification ───────────────────────────────
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// WebSocket client for real-time event watching (if WS_URL configured)
const wsClient = WS_URL
  ? createPublicClient({ chain: base, transport: webSocket(WS_URL) })
  : null;

const API_CREDITS_ABI = parseAbi([
  "function getTreeData() view returns (uint256 size, uint256 depth, uint256 root)",
]);

// ─── Historical Root Tracking (Privacy Fix) ───────────────────
// PROBLEM: Accepting only the current onchain root creates a timing
// correlation attack. When a new commitment is registered, the root
// changes. Any proof generated against the old root is rejected,
// forcing users to regenerate proofs immediately — which reveals
// who they are in a low-traffic system.
//
// FIX: Maintain a rolling set of all historical Merkle roots.
// Accept any proof against a root that existed within the last
// VALID_ROOT_WINDOW blocks (~24h on Base). We replay all
// CreditRegistered events on startup to build the full history,
// then poll for new events to keep it updated.

const VALID_ROOT_WINDOW = 7200n; // ~24h on Base (2s block time)

// root hex string → block number when it became the active root
const validRoots = new Map<string, bigint>();

// Persistent Semaphore-style tree state for incremental root computation.
// This mirrors the contract's filledNodes array exactly.
const treeFilledNodes: bigint[] = new Array(MAX_DEPTH).fill(0n);
let treeSize = 0;

// Cached tree leaves for /tree endpoint (avoids RPC calls per request)
const treeLeaves: bigint[] = [];

// The latest (current) root — never pruned from the valid set
let currentRoot: string | null = null;

// Last block processed by the event watcher
let lastProcessedBlock = 0n;

function rootToHex(root: bigint): string {
  return "0x" + root.toString(16).padStart(64, "0");
}

/**
 * Compute the Merkle root from the current filledNodes state.
 * Replicates the contract's _computeRoot logic exactly.
 */
async function computeRootFromFilledNodes(size: number): Promise<bigint> {
  if (size === 0) return 0n;

  let node = 0n;
  let nodeLevel = -1;
  let hasNode = false;

  for (let i = 0; i < MAX_DEPTH; i++) {
    if (((size >> i) & 1) === 1) {
      if (!hasNode) {
        node = treeFilledNodes[i];
        nodeLevel = i;
        hasNode = true;
      } else {
        for (let lvl = nodeLevel; lvl < i; lvl++) {
          node = await poseidon2Hash(node, zeros[lvl]);
        }
        node = await poseidon2Hash(treeFilledNodes[i], node);
        nodeLevel = i + 1;
      }
    }
  }

  return node;
}

/**
 * Insert a leaf into the incremental tree and return the new root.
 * Replicates the contract's Semaphore-style _insert + _computeRoot.
 */
async function insertLeafAndGetRoot(commitment: bigint): Promise<bigint> {
  treeLeaves.push(commitment);
  let node = commitment;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (((treeSize >> i) & 1) === 0) {
      treeFilledNodes[i] = node;
      break;
    } else {
      node = await poseidon2Hash(treeFilledNodes[i], node);
    }
  }
  treeSize++;
  return computeRootFromFilledNodes(treeSize);
}

/**
 * Prune roots older than VALID_ROOT_WINDOW blocks.
 * The current root is never pruned.
 */
async function pruneOldRoots(): Promise<void> {
  try {
    const currentBlock = await publicClient.getBlockNumber();
    const cutoff = currentBlock > VALID_ROOT_WINDOW
      ? currentBlock - VALID_ROOT_WINDOW
      : 0n;
    let pruned = 0;

    for (const [root, blockNum] of validRoots) {
      if (blockNum < cutoff && root !== currentRoot) {
        validRoots.delete(root);
        pruned++;
      }
    }

    if (pruned > 0) {
      console.log(
        `Pruned ${pruned} roots older than block ${cutoff}. ${validRoots.size} remain.`
      );
    }
  } catch (err) {
    console.error("Error pruning old roots:", err);
  }
}

/**
 * Replay all CreditRegistered events to build the full set of historical roots.
 * Each insertion produces a new root; we store every root with its block number.
 */
async function buildHistoricalRoots(): Promise<void> {
  console.log("Building historical root set from CreditRegistered events...");

  const events = await publicClient.getLogs({
    address: CONTRACT_ADDRESS,
    event: parseAbiItem(
      "event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)"
    ),
    fromBlock: 0n,
  });

  if (events.length === 0) {
    console.log("No CreditRegistered events found.");
    return;
  }

  // Sort by index to replay insertions in correct order
  const sorted = events.sort(
    (a, b) => Number(a.args.index!) - Number(b.args.index!)
  );

  // Populate treeLeaves from events (needed for /tree endpoint)
  for (const event of sorted) {
    treeLeaves.push(event.args.commitment!);
  }
  treeSize = treeLeaves.length;

  const lastBlock = sorted[sorted.length - 1]?.blockNumber ?? 0n;

  // Add onchain root (Solidity Poseidon2IMT — different from bb.js Poseidon2)
  try {
    const [, , contractRoot] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: API_CREDITS_ABI,
      functionName: "getTreeData",
    });
    const contractRootHex = rootToHex(contractRoot);
    currentRoot = contractRootHex;
    validRoots.set(contractRootHex, lastBlock);
    console.log(`✓ Onchain root: ${contractRootHex}`);
  } catch (err) {
    console.error("Could not fetch onchain root:", err);
  }

  // Add compact root (bb.js Poseidon2 — matches Noir circuit / client proofs)
  const compactRoot = await computeCompactRoot(treeLeaves);
  if (compactRoot !== null) {
    const compactRootHex = rootToHex(compactRoot);
    validRoots.set(compactRootHex, lastBlock);
    console.log(`✓ Compact root: ${compactRootHex}`);
  }

  console.log(
    `Loaded ${treeLeaves.length} leaves from ${events.length} events.`
  );

  // Prune roots outside the validity window
  await pruneOldRoots();
}

/**
 * Poll for new CreditRegistered events every 10 seconds.
 * Updates the tree state and valid roots set incrementally.
 */
/**
 * Compute the compact Merkle root from a list of leaves.
 * depth = ceil(log2(n)), padded with zeros[0] on right.
 * This is the root clients generate proofs against via /tree.
 */
async function computeCompactRoot(leaves: bigint[]): Promise<bigint | null> {
  const n = leaves.length;
  if (n === 0) return null;

  let depth = 0;
  let tmp = n;
  while (tmp > 1) { depth++; tmp = Math.ceil(tmp / 2); }

  const level0Size = depth === 0 ? 1 : 1 << depth;
  let level: bigint[] = new Array(level0Size);
  for (let i = 0; i < level0Size; i++) {
    level[i] = i < n ? leaves[i] : zeros[0];
  }
  for (let lvl = 0; lvl < depth; lvl++) {
    const parentSize = level.length >> 1;
    const parent: bigint[] = new Array(parentSize);
    for (let j = 0; j < parentSize; j++) {
      parent[j] = await poseidon2Hash(level[j * 2], level[j * 2 + 1]);
    }
    level = parent;
  }
  return level[0];
}

async function handleNewEvent(event: {
  args: { commitment?: bigint; index?: bigint };
  blockNumber: bigint | null;
}): Promise<void> {
  if (!event.args.commitment || event.blockNumber === null) return;

  // Update treeLeaves
  treeLeaves.push(event.args.commitment);
  treeSize = treeLeaves.length;

  // Add onchain root
  try {
    const [, , newRoot] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: API_CREDITS_ABI,
      functionName: "getTreeData",
    });
    const newRootHex = rootToHex(newRoot);
    validRoots.set(newRootHex, event.blockNumber);
    currentRoot = newRootHex;
    console.log(`New onchain root: ${newRootHex}`);
  } catch (err) {
    console.error("Failed to fetch new onchain root:", err);
  }

  // Add compact root (matches what clients prove against via /tree)
  const compactRoot = await computeCompactRoot(treeLeaves);
  if (compactRoot !== null) {
    const compactRootHex = rootToHex(compactRoot);
    validRoots.set(compactRootHex, event.blockNumber);
    console.log(`New compact root: ${compactRootHex}`);
  }

  if (event.blockNumber > lastProcessedBlock) lastProcessedBlock = event.blockNumber;
}
function startEventWatcher(): void {
  const eventAbi = parseAbiItem(
    "event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)"
  );

  if (wsClient) {
    // ── WebSocket path: fires within ~1 block (~2s) of tx confirmation ──
    wsClient.watchContractEvent({
      address: CONTRACT_ADDRESS,
      abi: [eventAbi],
      eventName: "CreditRegistered",
      onLogs: async (logs) => {
        const sorted = [...logs].sort((a, b) => Number(a.args.index!) - Number(b.args.index!));
        for (const log of sorted) {
          await handleNewEvent(log).catch(err =>
            console.error("Event handler error:", err)
          );
        }
      },
      onError: (err) => console.error("WebSocket watcher error:", err),
    });
    console.log("Event watcher started (WebSocket — real-time).");
  }

  // ── Polling fallback: runs every 2s regardless (catches WS gaps) ──
  setInterval(async () => {
    try {
      const currentBlock = await publicClient.getBlockNumber();
      if (currentBlock <= lastProcessedBlock) return;

      const events = await publicClient.getLogs({
        address: CONTRACT_ADDRESS,
        event: eventAbi,
        fromBlock: lastProcessedBlock + 1n,
        toBlock: currentBlock,
      });

      if (events.length > 0) {
        const sorted = events.sort((a, b) => Number(a.args.index!) - Number(b.args.index!));
        for (const event of sorted) {
          await handleNewEvent(event).catch(err =>
            console.error("Poll handler error:", err)
          );
        }
      } else {
        lastProcessedBlock = currentBlock;
      }
    } catch (err) {
      console.error("Poll watcher error:", err);
    }
  }, 2_000);

  if (!wsClient) console.log("Event watcher started (polling every 2s — set WS_URL for real-time).");
}

// ─── Redis Nullifier Storage ──────────────────────────────────
// Atomic SADD/SISMEMBER — no file corruption, no write races, crash-safe.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
const NULLIFIER_KEY = "nullifiers";
const pendingNullifiers = new Set<string>();

async function isNullifierSpent(hash: string): Promise<boolean> {
  return !!(await redis.sismember(NULLIFIER_KEY, hash));
}

async function saveNullifier(hash: string): Promise<void> {
  await redis.sadd(NULLIFIER_KEY, hash);
}

async function getNullifierCount(): Promise<number> {
  return redis.scard(NULLIFIER_KEY);
}

// Migrate existing file-based nullifiers into Redis on startup (one-time)
async function migrateNullifiersFromFile(): Promise<number> {
  try {
    const data = JSON.parse(fs.readFileSync(NULLIFIER_FILE, "utf-8")) as string[];
    if (data.length === 0) return 0;
    await redis.sadd(NULLIFIER_KEY, ...data as [string, ...string[]]);
    console.log(`[startup] Migrated ${data.length} nullifiers from file → Redis`);
    return data.length;
  } catch {
    return 0; // file doesn't exist or empty — that's fine
  }
}

// ─── Model ───────────────────────────────────────────────────
const MODEL = process.env.VENICE_MODEL || "zai-org-glm-5";
const E2EE_MODEL = process.env.VENICE_E2EE_MODEL || "e2ee-glm-5";

// ─── Venice Pricing ──────────────────────────────────────────
const PRICING: Record<string, { input: number; output: number }> = {
  "zai-org-glm-5":  { input: 1.00 / 1_000_000, output: 3.20 / 1_000_000 },
  "e2ee-glm-5":     { input: 1.10 / 1_000_000, output: 4.15 / 1_000_000 },
};
const DEFAULT_PRICING = PRICING[MODEL] ?? PRICING["zai-org-glm-5"];
const MAX_COST_USD = 0.05;
const COST_MULTIPLIER = parseFloat(process.env.COST_MULTIPLIER || "1.0");

function computeVeniceCost(usage: { prompt_tokens?: number; completion_tokens?: number }, isE2EE = false): number {
  const pricing = isE2EE ? (PRICING[E2EE_MODEL] ?? DEFAULT_PRICING) : DEFAULT_PRICING;
  const inputCost = (usage.prompt_tokens ?? 0) * pricing.input;
  const outputCost = (usage.completion_tokens ?? 0) * pricing.output;
  return (inputCost + outputCost) * COST_MULTIPLIER;
}

function detectE2EEFromHeaders(req: express.Request): boolean {
  return !!req.headers["x-venice-tee-client-pub-key"];
}

// ─── Express App ──────────────────────────────────────────────
const app = express();

// Trust proxy headers (required for correct IP detection behind AWS/Cloudflare)
app.set("trust proxy", 1);

app.use(cors({
  exposedHeaders: ["x-conversation-balance", "x-conversation-ended"],
}));
app.use(express.json({ limit: "1mb" }));

// ─── Rate Limiting ────────────────────────────────────────────
// /v1/chat/start involves CPU-heavy ZK proof verification (~2s).
// Without throttling, an attacker can saturate the verifier with garbage proofs.
// Token-based /v1/chat calls are lighter (no ZK verify) and get a higher limit.
const chatLimiter = rateLimit({
  windowMs: 60_000,           // 1-minute rolling window
  max: parseInt(process.env.RATE_LIMIT_CHAT || "10"),  // 10 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment and try again" },
});

// Lighter limiter for token-based chat (no ZK verification CPU cost)
const tokenLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_TOKEN || "30"),  // 30 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment and try again" },
});

// Light limiter for read endpoints (tree, circuit, stats) — prevents scraping/hammering
const readLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_READ || "60"),  // 60 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Health check
app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    spentNullifiers: await getNullifierCount(),
    currentRoot,
    validRoots: validRoots.size,
    treeSize,
  });
});

// Get server stats
app.get("/stats", async (_req, res) => {
  res.json({
    spentNullifiers: await getNullifierCount(),
    currentRoot,
    validRoots: validRoots.size,
    treeSize,
  });
});

// Check if a nullifier has been spent
app.get("/nullifier/:hash", async (req, res) => {
  const spent = await isNullifierSpent(req.params.hash);
  res.json({ spent });
});

// ─── Contract Info ─────────────────────────────────────────────
// GET /contract — returns current contract address + onchain root (for update.sh auto-sync)
app.get("/contract", async (_req, res) => {
  // Fetch current root from contract (not TypeScript-computed)
  let rootHex = currentRoot ?? "0";
  try {
    const [, , contractRoot] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: API_CREDITS_ABI,
      functionName: "getTreeData",
    });
    rootHex = rootToHex(contractRoot);
  } catch { /* use cached */ }
  res.json({ address: CONTRACT_ADDRESS, chainId: 8453, root: rootHex });
});

// ─── TEE Attestation Proxy ────────────────────────────────────
// GET /v1/tee/attestation?model=<model>&nonce=<hex>
// Proxies Venice's TEE attestation endpoint so the browser can
// establish E2EE without needing the Venice API key.
// The browser generates the nonce and verifies it in the response.
app.get("/v1/tee/attestation", readLimiter, async (req, res) => {
  const { model, nonce } = req.query;
  if (!model || !nonce || typeof model !== "string" || typeof nonce !== "string") {
    res.status(400).json({ error: "Missing required query params: model, nonce" });
    return;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(nonce)) {
    res.status(400).json({ error: "nonce must be 32 bytes (64 hex chars)" });
    return;
  }

  try {
    const url = `${VENICE_BASE_URL}/tee/attestation?model=${encodeURIComponent(model)}&nonce=${nonce}`;
    const attRes = await fetch(url, {
      headers: { Authorization: `Bearer ${VENICE_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!attRes.ok) {
      const body = await attRes.text();
      res.status(attRes.status).json({ error: `Venice attestation failed: ${body}` });
      return;
    }

    const attestation = await attRes.json();
    res.json(attestation);
  } catch (err: any) {
    console.error("[attestation] proxy error:", err);
    res.status(502).json({ error: "Failed to fetch attestation from Venice" });
  }
});

// ─── Circuit Artifact ──────────────────────────────────────────
// GET /circuit
// Returns the compiled Noir circuit JSON for client-side proof generation
app.get("/circuit", readLimiter, (_req, res) => {
  try {
    const circuitPath = process.env.CIRCUIT_PATH || path.resolve(__dirname, "../../circuits/target/circuits.json");
    const circuit = JSON.parse(fs.readFileSync(circuitPath, "utf-8"));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(circuit);
  } catch (err: any) {
    res.status(500).json({ error: "Circuit not found: " + err.message });
  }
});

// ─── Full Tree Data (Privacy-Preserving) ──────────────────────
// GET /tree
// readLimiter: tree rebuild is O(n) Poseidon hashes — cap it
// Returns ALL tree data (leaves, precomputed levels, root, depth, zeros).
// The client computes its own Merkle path locally — the server never learns
// which commitment is about to be used. This replaces /merkle-path/:commitment.
app.get("/tree", readLimiter, async (_req, res) => {
  const tTree = Date.now();
  try {
    const leaves = treeLeaves;
    const numLeaves = leaves.length;

    if (numLeaves === 0) {
      res.json({
        leaves: [],
        levels: [],
        root: "0",
        depth: 0,
        zeros: zeros.map((z) => z.toString()),
      });
      return;
    }

    // Use the actual tree depth (ceil(log2(numLeaves))) for Merkle paths.
    // The circuit uses MAX_DEPTH=16 — clients pad indices/siblings to 16.
    // The root must match the incremental Semaphore-style tree, so we
    // compute depth levels for path extraction, then fold remaining
    // levels up to MAX_DEPTH using zero hashes (same as the contract).
    let treeDepth = 0;
    {
      let tmp = numLeaves;
      while (tmp > 1) {
        treeDepth++;
        tmp = Math.ceil(tmp / 2);
      }
    }

    // Build full level-by-level tree from cached leaves (no RPC calls)
    const levels: bigint[][] = [];
    const level0Size = treeDepth === 0 ? 1 : 1 << treeDepth;
    levels[0] = new Array(level0Size);
    for (let i = 0; i < level0Size; i++) {
      levels[0][i] = i < numLeaves ? leaves[i] : zeros[0];
    }
    for (let lvl = 0; lvl < treeDepth; lvl++) {
      const parentSize = levels[lvl].length >> 1;
      levels[lvl + 1] = new Array(parentSize);
      for (let j = 0; j < parentSize; j++) {
        levels[lvl + 1][j] = await poseidon2Hash(levels[lvl][j * 2], levels[lvl][j * 2 + 1]);
      }
    }

    const treeRoot = levels[treeDepth]?.[0] ?? leaves[0];

    console.log(`[tree] built ${numLeaves} leaves (depth ${treeDepth}) in ${Date.now() - tTree}ms`);
    res.json({
      leaves: leaves.map((l) => l.toString()),
      levels: levels.map((level) => level.map((n) => n.toString())),
      root: treeRoot.toString(),
      depth: treeDepth,
      zeros: zeros.map((z) => z.toString()),
    });
  } catch (err: any) {
    console.error(`[tree] error after ${Date.now() - tTree}ms:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /v1/chat/start
 * Burns nullifier, creates conversation token, returns first LLM response.
 * Subsequent calls use /v1/chat with Bearer token.
 *
 * Body: {
 *   "proof": "<hex string>",
 *   "nullifier_hash": "0x...",
 *   "root": "0x...",
 *   "depth": <number>,
 *   "messages": [{ "role": "user", "content": "..." }],
 * }
 *
 * Response: {
 *   "token": "<bearer token>",
 *   "balanceRemaining": <dollars remaining>,
 *   "response": <venice chat completions response>,
 * }
 */
app.post("/v1/chat/start", chatLimiter, async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const ts = () => `+${Date.now() - t0}ms`;
  console.log(`[${reqId}] POST /v1/chat/start — received`);

  const {
    proof,
    nullifier_hash,
    root,
    depth,
    messages,
    encrypted_messages,
  } = req.body;

  const isE2EE = detectE2EEFromHeaders(req) || !!encrypted_messages;
  if (req.body.model && req.body.model !== MODEL && !isE2EE) {
    console.log(`[${reqId}] client requested model "${req.body.model}" — ignored, using "${MODEL}"`);
  }

  if (!proof || !nullifier_hash || !root || depth === undefined) {
    res.status(400).json({ error: "Missing required fields: proof, nullifier_hash, root, depth" });
    return;
  }
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "Missing required field: messages" });
    return;
  }

  if (pendingNullifiers.has(nullifier_hash)) {
    res.status(429).json({ error: "This nullifier is currently being processed — try again in a moment" });
    return;
  }
  if (await isNullifierSpent(nullifier_hash)) {
    res.status(403).json({ error: "Nullifier already spent" });
    return;
  }
  pendingNullifiers.add(nullifier_hash);
  console.log(`[${reqId}] nullifier + root checks passed (${ts()})`);

  try {
    if (validRoots.size === 0) {
      res.status(403).json({ error: "No commitments registered yet" });
      return;
    }
    if (!validRoots.has(root)) {
      console.log(`[${reqId}] root check FAILED — root=${root}, validRoots=[${[...validRoots.keys()].join(", ")}]`);
      res.status(403).json({ error: "Invalid root — not in valid root set" });
      return;
    }
    if (verifierPool.activeCount >= verifierPool.size) {
      res.status(503).json({ error: "Server busy — all verifier workers occupied, please retry in a moment" });
      return;
    }

    const tVerifyStart = Date.now();
    console.log(`[${reqId}] starting proof verification (${ts()})`);
    const pubInputs = [
      nullifier_hash,
      root,
      "0x" + BigInt(depth).toString(16).padStart(64, "0"),
    ];
    console.log(`[${reqId}] publicInputs:`, pubInputs.map(p => p.slice(0, 20) + "..."));
    let proofValid = false;
    try {
      proofValid = await verifyProof(proof, nullifier_hash, root, depth);
      const verifyMs = Date.now() - tVerifyStart;
      if (!proofValid) {
        console.log(`[${reqId}] proof INVALID — ${verifyMs}ms`);
        res.status(403).json({ error: "Invalid proof" });
        return;
      }
      console.log(`[${reqId}] proof verified ✅ — ${verifyMs}ms`);
    } catch (verifyError: any) {
      console.error(`[${reqId}] proof verification threw:`, verifyError);
      res.status(403).json({ error: "Proof verification failed", details: verifyError.message });
      return;
    }

    let tokenId: string;
    try {
      tokenId = await createToken(nullifier_hash, root, depth);
      console.log(`[${reqId}] token created: ${tokenId.slice(0, 16)}... (${ts()})`);
    } catch (tokenError: any) {
      console.error(`[${reqId}] token creation failed:`, tokenError);
      res.status(500).json({ error: "Failed to create session token" });
      return;
    }

    console.log(`[${reqId}] calling Venice (${ts()})${isE2EE ? " [E2EE 🔒]" : ""}`);
    try {
      const { veniceData, costUsd, veniceMs } = await callVenice(req, reqId, messages, null, isE2EE);
      const totalMs = Date.now() - t0;

      if (costUsd > 0) {
        await deductToken(tokenId, costUsd);
        console.log(`[${reqId}] deducted $${costUsd.toFixed(6)} from token`);
      }

      await saveNullifier(nullifier_hash);
      console.log(`[${reqId}] nullifier burned (${ts()})`);

      const tokenData = await getToken(tokenId);
      console.log(`[${reqId}] ✅ done — Venice: ${veniceMs}ms | total: ${totalMs}ms`);

      res.json({
        token: tokenId,
        balanceRemaining: tokenData?.balanceRemaining ?? INITIAL_BALANCE,
        expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
        response: veniceData,
      });
    } catch (veniceError: any) {
      const statusCode = veniceError.statusCode || 500;
      const isTimeout = veniceError?.name === "TimeoutError" || veniceError?.name === "AbortError";
      if (isTimeout) {
        console.error(`[${reqId}] Venice timed out — nullifier NOT burned, safe to retry`);
        res.status(504).json({ error: "Venice API timed out — nullifier NOT burned, safe to retry" });
      } else if (statusCode === 400 || statusCode === 502) {
        res.status(statusCode).json({ error: veniceError.message });
      } else {
        console.error(`[${reqId}] Venice request failed:`, veniceError);
        res.status(502).json({ error: "Failed to reach Venice API", details: veniceError.message });
      }
      return;
    }
  } catch (error: any) {
    console.error(`[${reqId}] unexpected error (${ts()}):`, error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    pendingNullifiers.delete(nullifier_hash);
  }
});

/**
 * Extract bearer token from Authorization header or request body.
 */
function extractBearerToken(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  if (req.body?.token && typeof req.body.token === "string") {
    return req.body.token;
  }
  return null;
}

/**
 * Call Venice and return the response data.
 * Shared between token-based and proof-based flows.
 *
 * E2EE mode (detected via headers): uses E2EE model + streaming (required by Venice).
 * Aggregates SSE chunks into a normal response with encrypted_chunks for proxy decryption.
 */
async function callVenice(
  req: express.Request,
  reqId: string,
  messages: any,
  _encrypted_messages: any,
  _isE2EELegacy: boolean,
): Promise<{ veniceData: any; costUsd: number; veniceMs: number }> {
  const isE2EE = detectE2EEFromHeaders(req) || _isE2EELegacy;

  const veniceHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${VENICE_API_KEY}`,
  };
  const e2eeHeaderNames = [
    "x-venice-tee-client-pub-key",
    "x-venice-tee-model-pub-key",
    "x-venice-tee-signing-algo",
  ];
  for (const h of e2eeHeaderNames) {
    const val = req.headers[h] as string | undefined;
    if (val) veniceHeaders[h] = val;
  }

  const estimatedInputBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  const estimatedInputTokens = Math.ceil(estimatedInputBytes / 4);
  const pricing = isE2EE ? (PRICING[E2EE_MODEL] ?? DEFAULT_PRICING) : DEFAULT_PRICING;
  const estimatedInputCost = estimatedInputTokens * pricing.input;

  if (estimatedInputCost > MAX_COST_USD) {
    const maxBytes = Math.floor((MAX_COST_USD / pricing.input) * 4);
    throw Object.assign(
      new Error(`Request too large — max ~${maxBytes.toLocaleString()} bytes ($${MAX_COST_USD} budget)`),
      { statusCode: 400 },
    );
  }

  const veniceModel = isE2EE ? E2EE_MODEL : MODEL;
  const veniceBody: Record<string, any> = {
    model: veniceModel,
    messages,
    stream: isE2EE,
  };
  if (isE2EE) {
    veniceBody.stream_options = { include_usage: true };
  }

  const VENICE_TIMEOUT_MS = parseInt(process.env.VENICE_TIMEOUT_MS || "90000");
  const tStart = Date.now();
  const veniceResponse = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: veniceHeaders,
    body: JSON.stringify(veniceBody),
    signal: AbortSignal.timeout(VENICE_TIMEOUT_MS),
  });
  const veniceMs = Date.now() - tStart;

  if (!veniceResponse.ok) {
    const errorText = await veniceResponse.text();
    console.error(`[${reqId}] Venice error ${veniceResponse.status} — ${veniceMs}ms:`, errorText);
    throw Object.assign(new Error("Venice API error"), { statusCode: 502 });
  }

  if (isE2EE) {
    const { chunks, usage } = await aggregateSSEStream(veniceResponse, reqId);
    const veniceData: Record<string, any> = {
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      encrypted_chunks: chunks,
    };
    const costUsd = usage ? computeVeniceCost(usage, true) : 0;
    return { veniceData, costUsd, veniceMs };
  }

  const veniceData = await veniceResponse.json();
  const costUsd = veniceData?.usage ? computeVeniceCost(veniceData.usage, false) : 0;
  return { veniceData, costUsd, veniceMs };
}

/**
 * Read a Venice SSE stream and aggregate encrypted content chunks + usage.
 */
async function aggregateSSEStream(
  response: Response,
  reqId: string,
): Promise<{ chunks: string[]; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let usage = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) chunks.push(content);
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // skip malformed chunks
      }
    }
  }

  console.log(`[${reqId}] E2EE stream: collected ${chunks.length} encrypted chunks`);
  return { chunks, usage };
}

/**
 * POST /v1/chat — Conversation continuation (bearer token) or legacy proof-based call
 *
 * Bearer token flow (conversation credits):
 *   Authorization: Bearer <token>  (or { "token": "<token>" } in body)
 *   { "messages": [...] }
 *
 * Legacy proof flow (backwards compatible):
 *   { "proof": "0x...", "nullifier_hash": "0x...", "root": "0x...", "depth": N, "messages": [...] }
 */
app.post("/v1/chat", tokenLimiter, async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const ts = () => `+${Date.now() - t0}ms`;

  // ─── Check for bearer token (conversation continuation) ───
  const bearerToken = extractBearerToken(req);

  if (bearerToken) {
    // ─── Token-based flow: no ZK proof needed ───────────────
    console.log(`[${reqId}] POST /v1/chat [token] — ${bearerToken.slice(0, 16)}...`);

    const { messages } = req.body;
    const isE2EE = detectE2EEFromHeaders(req);

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "Missing required field: messages" });
      return;
    }

    const tokenData = await getToken(bearerToken);
    if (!tokenData) {
      console.log(`[${reqId}] token not found or expired (${ts()})`);
      res.status(401).json({ error: "Invalid or expired session token" });
      return;
    }
    if (tokenData.balanceRemaining <= 0) {
      console.log(`[${reqId}] token balance depleted (${ts()})`);
      res.status(402).json({ error: "Chat session balance depleted — start a new chat session" });
      return;
    }
    console.log(`[${reqId}] token valid, balance: $${tokenData.balanceRemaining.toFixed(6)} (${ts()})`);

    try {
      const { veniceData, costUsd, veniceMs } = await callVenice(req, reqId, messages, null, isE2EE);

      let balanceRemaining = tokenData.balanceRemaining;
      let conversationEnded = false;

      if (costUsd > 0) {
        const result = await deductToken(bearerToken, costUsd);
        if (result) {
          balanceRemaining = result.balanceRemaining;
          conversationEnded = result.conversationEnded;
        }
        console.log(`[${reqId}] deducted $${costUsd.toFixed(6)}, remaining: $${balanceRemaining.toFixed(6)}${conversationEnded ? " [ENDED]" : ""}`);
      }

      res.setHeader("x-conversation-balance", balanceRemaining.toString());
      if (conversationEnded) {
        res.setHeader("x-conversation-ended", "true");
      }

      const totalMs = Date.now() - t0;
      console.log(`[${reqId}] ✅ done [token] — Venice: ${veniceMs}ms | total: ${totalMs}ms`);
      res.json(veniceData);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      if (isTimeout) {
        console.error(`[${reqId}] Venice timed out — balance NOT deducted`);
        res.status(504).json({ error: "Venice API timed out — please retry" });
      } else if (statusCode === 400 || statusCode === 502) {
        res.status(statusCode).json({ error: error.message });
      } else {
        console.error(`[${reqId}] unexpected error (${ts()}):`, error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
    return;
  }

  // ─── Legacy proof-based flow (backwards compatible) ───────
  console.log(`[${reqId}] POST /v1/chat [proof] — received`);

  const {
    proof,
    nullifier_hash,
    root,
    depth,
    messages,
    encrypted_messages,
  } = req.body;

  const isE2EE = detectE2EEFromHeaders(req) || !!encrypted_messages;

  if (!proof || !nullifier_hash || !root || depth === undefined) {
    res.status(400).json({ error: "Missing required fields: proof, nullifier_hash, root, depth (or provide a bearer token)" });
    return;
  }
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "Missing required field: messages" });
    return;
  }

  if (pendingNullifiers.has(nullifier_hash)) {
    res.status(429).json({ error: "This nullifier is currently being processed — try again in a moment" });
    return;
  }
  if (await isNullifierSpent(nullifier_hash)) {
    res.status(403).json({ error: "Nullifier already spent" });
    return;
  }
  pendingNullifiers.add(nullifier_hash);
  console.log(`[${reqId}] nullifier + root checks passed (${ts()})`);

  try {
    if (validRoots.size === 0) {
      res.status(403).json({ error: "No commitments registered yet" });
      return;
    }
    if (!validRoots.has(root)) {
      res.status(403).json({ error: "Invalid root — not in valid root set (may be expired or incorrect)" });
      return;
    }

    if (verifierPool.activeCount >= verifierPool.size) {
      res.status(503).json({ error: "Server busy — all verifier workers occupied, please retry in a moment" });
      return;
    }

    const tVerifyStart = Date.now();
    console.log(`[${reqId}] starting proof verification (${ts()})`);
    try {
      const proofValid = await verifyProof(proof, nullifier_hash, root, depth);
      const verifyMs = Date.now() - tVerifyStart;
      if (!proofValid) {
        console.log(`[${reqId}] proof INVALID — ${verifyMs}ms`);
        res.status(403).json({ error: "Invalid proof" });
        return;
      }
      console.log(`[${reqId}] proof verified ✅ — ${verifyMs}ms`);
    } catch (verifyError: any) {
      const verifyMs = Date.now() - tVerifyStart;
      console.error(`[${reqId}] proof verification threw — ${verifyMs}ms:`, verifyError);
      res.status(403).json({ error: "Proof verification failed", details: verifyError.message });
      return;
    }

    try {
      const { veniceData, costUsd, veniceMs } = await callVenice(req, reqId, messages, null, isE2EE);
      const totalMs = Date.now() - t0;

      if (veniceData?.usage) {
        const actualCost = computeVeniceCost(veniceData.usage);
        console.log(`[${reqId}] Venice usage: ${veniceData.usage.prompt_tokens} in + ${veniceData.usage.completion_tokens || 0} out = $${actualCost.toFixed(6)} (cap $${MAX_COST_USD})`);
      }
      console.log(`[${reqId}] ✅ done [proof] — Venice: ${veniceMs}ms | total: ${totalMs}ms`);

      await saveNullifier(nullifier_hash);
      console.log(`[${reqId}] nullifier burned (${ts()})`);

      res.json(veniceData);
    } catch (veniceError: any) {
      const statusCode = veniceError.statusCode || 500;
      const isTimeout = veniceError?.name === "TimeoutError" || veniceError?.name === "AbortError";
      if (isTimeout) {
        console.error(`[${reqId}] Venice timed out — nullifier NOT burned, safe to retry`);
        res.status(504).json({ error: "Venice API timed out — your credit was NOT spent, please retry" });
      } else if (statusCode === 400 || statusCode === 502) {
        res.status(statusCode).json({ error: veniceError.message });
      } else {
        console.error(`[${reqId}] Venice request failed:`, veniceError);
        res.status(502).json({ error: "Failed to reach Venice API", details: veniceError.message });
      }
    }
  } catch (error: any) {
    console.error(`[${reqId}] unexpected error (${ts()}):`, error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    pendingNullifiers.delete(nullifier_hash);
  }
});

// ─── Proof Verification ───────────────────────────────────────
async function verifyProof(
  proofHex: string,
  nullifierHash: string,
  root: string,
  depth: number,
): Promise<boolean> {
  try {
    const publicInputs = [
      nullifierHash,
      root,
      "0x" + BigInt(depth).toString(16).padStart(64, "0"),
    ];
    return await verifierPool.verify(proofHex, publicInputs);
  } catch (error) {
    console.error("Proof verification error:", error);
    return false;
  }
}

// ─── Start Server ─────────────────────────────────────────────
async function start() {
  console.log("Initializing Barretenberg (Poseidon2 WASM)...");
  bb = await Barretenberg.new({ threads: 1 });
  console.log("Barretenberg ready.");

  // Precompute zero hashes (must happen after bb is initialized)
  await precomputeZeros();

  // Build historical root set from all past events
  await buildHistoricalRoots();

  // Initialize verifier worker pool
  const poolSize = Math.max(1, os.cpus().length - 1);
  console.log(`Initializing verifier pool (${poolSize} workers)...`);
  const workerScript = path.resolve(__dirname, "verifier-worker.js");
  const circuit = JSON.parse(fs.readFileSync(CIRCUIT_PATH, "utf-8"));
  verifierPool = new VerifierPool(circuit.bytecode, workerScript, poolSize);
  await verifierPool.init();
  console.log(`Verifier pool ready (${poolSize} workers, WASM hot)`);

  // Record current block for incremental watching
  try {
    lastProcessedBlock = await publicClient.getBlockNumber();
  } catch {
    lastProcessedBlock = 0n;
  }

  // Migrate any existing file-based nullifiers to Redis (one-time, idempotent)
  await migrateNullifiersFromFile();

  // Start polling for new commitment events
  startEventWatcher();

  const nullifierCount = await getNullifierCount();

  app.listen(PORT, () => {
    console.log(`\n🔐 ZK API Credits Server`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Model: ${MODEL}`);
    console.log(`   Venice: ${VENICE_BASE_URL}`);
    console.log(`   Circuit: ${CIRCUIT_PATH}`);
    console.log(`   Contract: ${CONTRACT_ADDRESS}`);
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   WS:  ${WS_URL || "(not set — WebSocket disabled, using 2s polling)"}`);
    console.log(`   Current root: ${currentRoot || "(no commitments yet)"}`);
    console.log(`   Valid roots: ${validRoots.size} (window: ${VALID_ROOT_WINDOW} blocks)`);
    console.log(`   Tree size: ${treeSize} commitments`);
    console.log(`   Spent nullifiers: ${nullifierCount} (Redis)`);
    console.log(`   Upstash: ${process.env.UPSTASH_REDIS_REST_URL}`);
    console.log(`   Hash function: bb.js Poseidon2 (Noir-compatible)`);
    console.log(`   Tree type: Standard binary with zero-padding (Semaphore-style)`);
    console.log(`   Verifier pool: ${verifierPool.size} workers (UltraHonkBackend pre-warmed)`);
    console.log(`   Cost multiplier: ${COST_MULTIPLIER}x`);
    console.log(`\n   POST /v1/chat/start — ZK proof → session token + first response`);
    console.log(`   POST /v1/chat       — Bearer token continuation (or legacy proof)`);
    console.log(`   GET  /health        — Server health + valid roots count`);
    console.log(`   GET  /stats         — Server stats`);
    console.log(`\n   1 credit = 1 chat session ($${INITIAL_BALANCE.toFixed(2)}). No wallet. No identity.\n`);
  });
}

start().catch(console.error);
