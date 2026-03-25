import { Barretenberg, Fr, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { API_URL, BUY_THRESHOLD, BUY_CHUNK } from "./config.js";
import type { Credit } from "./credits.js";

export interface ReadyProof {
  commitment: string;
  proofHex: string;
  publicInputs: string[];
  nullifierHashHex: string;
  rootHex: string;
  depth: number;
  counter: number;
}

interface TreeData {
  leaves: string[];
  levels: string[][];
  root: string;
  depth: number;
  zeros?: string[];
}

const MAX_DEPTH = 16;

// Module-level proof queue
const proofQueue: ReadyProof[] = [];
let isPreWarming = false;
let isBuying = false;

function computeMerklePath(treeData: TreeData, commitment: string) {
  const leafIndex = treeData.leaves.findIndex((l) => l === commitment);
  if (leafIndex === -1) return null;

  const siblings: string[] = [];
  const indices: number[] = [];

  for (let i = 0; i < treeData.depth; i++) {
    const levelIndex = leafIndex >> i;
    const siblingIndex = levelIndex % 2 === 0 ? levelIndex + 1 : levelIndex - 1;

    if (siblingIndex < treeData.levels[i].length) {
      siblings.push(treeData.levels[i][siblingIndex]);
    } else {
      siblings.push("0");
    }
    indices.push(levelIndex & 1);
  }

  return { leafIndex, siblings, indices, root: treeData.root, depth: treeData.depth };
}

export async function generateProof(credit: Credit): Promise<ReadyProof> {
  console.log("[prove] Fetching Merkle tree and contract root...");
  const [treeData, contractData] = await Promise.all([
    fetch(`${API_URL}/tree`).then((r) => r.json()),
    fetch(`${API_URL}/contract`).then((r) => r.json()),
  ]);

  // Use the contract root — the TypeScript tree may differ from the contract's Poseidon2IMT root
  const contractRootHex = contractData.root as string;
  const merkleData = computeMerklePath(treeData, credit.commitment);
  if (!merkleData) {
    throw new Error(`Commitment ${credit.commitment} not found in tree. Wait for on-chain sync.`);
  }
  console.log(`[prove] Found commitment at leaf index ${merkleData.leafIndex}`);

  console.log("[prove] Initializing Barretenberg...");
  const bb = await Barretenberg.new({ threads: 1 });

  // Fetch the current counter for this nullifier from the server
  // First compute base nullifier hash (counter=0) to look up counter
  const nullifierFr = new Fr(BigInt(credit.nullifier));
  const baseNullifierHashFr = await bb.poseidon2Hash([nullifierFr, new Fr(0n)]);
  const baseNullifierHashBig = BigInt("0x" + Buffer.from(baseNullifierHashFr.value).toString("hex"));
  const baseNullifierHashHex = "0x" + baseNullifierHashBig.toString(16).padStart(64, "0");

  let currentCounter = 0;
  try {
    const counterRes = await fetch(`${API_URL}/counter/${baseNullifierHashHex}`);
    if (counterRes.ok) {
      const counterData = await counterRes.json() as { counter: number };
      currentCounter = counterData.counter;
    }
  } catch {
    console.warn("[prove] Could not fetch counter, defaulting to 0");
  }
  console.log(`[prove] Current counter: ${currentCounter}`);

  // Compute nullifier hash = poseidon2([nullifier, counter])
  const nullifierHashFr = await bb.poseidon2Hash([nullifierFr, new Fr(BigInt(currentCounter))]);
  const nullifierHashBig = BigInt("0x" + Buffer.from(nullifierHashFr.value).toString("hex"));

  await bb.destroy();

  // Pad to MAX_DEPTH=16
  const paddedIndices = [
    ...merkleData.indices,
    ...Array(MAX_DEPTH - merkleData.depth).fill(0),
  ].map(String);
  const paddedSiblings = [
    ...merkleData.siblings,
    ...Array(MAX_DEPTH - merkleData.depth).fill("0"),
  ];

  // Fetch circuit
  console.log("[prove] Fetching circuit...");
  const circuit = await fetch(`${API_URL}/circuit`).then((r) => r.json());

  // Generate witness
  console.log("[prove] Generating witness...");
  const noir = new Noir(circuit);
  const { witness } = await noir.execute({
    nullifier_hash: nullifierHashBig.toString(),
    root: merkleData.root,
    depth: merkleData.depth.toString(),
    current_counter: currentCounter.toString(),
    nullifier: credit.nullifier,
    secret: credit.secret,
    indices: paddedIndices,
    siblings: paddedSiblings,
  });

  // Generate proof (this takes 30-60 seconds)
  console.log("[prove] Generating ZK proof (this may take 30-60 seconds)...");
  const backend = new UltraHonkBackend(circuit.bytecode);
  const { proof: proofBytes, publicInputs } = await backend.generateProof(witness);
  await backend.destroy();

  const proofHex = "0x" + Buffer.from(proofBytes).toString("hex");
  const rootHex = contractRootHex.startsWith("0x") ? contractRootHex : `0x${contractRootHex}`;
  const nullifierHashHex = "0x" + nullifierHashBig.toString(16).padStart(64, "0");

  console.log("[prove] ✅ Proof generated!");
  return { commitment: credit.commitment, proofHex, publicInputs, nullifierHashHex, rootHex, depth: merkleData.depth, counter: currentCounter };
}

export async function preWarm(allCredits: Credit[]): Promise<void> {
  if (isPreWarming) return;
  isPreWarming = true;

  const queuedCommitments = new Set(proofQueue.map(p => p.commitment));
  const toWarm = allCredits.filter(c => !c.spent && !queuedCommitments.has(c.commitment));

  console.log(`[prewarm] ${toWarm.length} credits to pre-warm, ${proofQueue.length} already ready`);

  for (const credit of toWarm) {
    try {
      console.log(`[prewarm] generating proof for commitment ${credit.commitment.slice(0, 12)}...`);
      const proof = await generateProof(credit);
      proofQueue.push(proof);
      console.log(`[prewarm] ✅ proof ready, queue depth: ${proofQueue.length}`);
    } catch (err) {
      console.error(`[prewarm] ❌ failed for ${credit.commitment.slice(0, 12)}:`, err);
    }
  }

  isPreWarming = false;
}

export function popProof(): ReadyProof | null {
  return proofQueue.shift() ?? null;
}

export function queueDepth(): number {
  return proofQueue.length;
}

// Poll /health until treeSize >= expectedSize (server has indexed our new commitments)
async function waitForIndexing(expectedSize: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  console.log(`[prewarm] waiting for server to index ${expectedSize} leaves...`);
  while (Date.now() - start < timeoutMs) {
    try {
      const health = await fetch(`${API_URL}/health`).then(r => r.json());
      if (health.treeSize >= expectedSize) {
        console.log(`[prewarm] ✅ server indexed (treeSize=${health.treeSize}) in ${Date.now() - start}ms`);
        return;
      }
    } catch { /* ignore, keep polling */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  console.warn(`[prewarm] ⚠️ timeout waiting for indexing after ${timeoutMs}ms — attempting anyway`);
}

export async function checkAndBuy(
  getCredits: () => Credit[],
  onNewCredits: (newCredits: Credit[]) => void
): Promise<void> {
  if (isBuying) return;
  const credits = getCredits();
  const unspent = credits.filter(c => !c.spent);
  if (unspent.length >= BUY_THRESHOLD) return;

  isBuying = true;
  console.log(`[buy] inventory low (${unspent.length} unspent) — buying ${BUY_CHUNK} more...`);
  try {
    const { buyCredits } = await import("./buy.js");

    // Check current tree size before buying so we know what to wait for
    const healthBefore = await fetch(`${API_URL}/health`).then(r => r.json()).catch(() => ({ treeSize: 0 }));
    const newCredits = await buyCredits(BUY_CHUNK);
    onNewCredits(newCredits);
    console.log(`[buy] ✅ bought ${newCredits.length} new credits`);

    // Wait for server to index before pre-warming
    const expectedSize = healthBefore.treeSize + newCredits.length;
    await waitForIndexing(expectedSize);
    preWarm(newCredits).catch(console.error);
  } catch (err) {
    console.error("[buy] ❌ auto-buy failed:", err);
  } finally {
    isBuying = false;
  }
}
