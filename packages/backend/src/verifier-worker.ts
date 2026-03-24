/**
 * verifier-worker.ts
 *
 * Runs in a Node.js worker thread. Owns a single UltraHonkBackend WASM
 * instance initialized at startup. Receives proof verification requests
 * via parentPort messages and replies with the result.
 *
 * Message protocol:
 *   Request:  { id: number, proofHex: string, publicInputs: string[], bytecode: string }
 *   Response: { id: number, valid: boolean } | { id: number, error: string }
 */

import { parentPort, workerData } from "worker_threads";
import { UltraHonkBackend } from "@aztec/bb.js";

if (!parentPort) throw new Error("Must run as a worker thread");

const { bytecode } = workerData as { bytecode: string };

let backend: UltraHonkBackend;

async function init() {
  backend = new UltraHonkBackend(bytecode);
  // Signal ready
  parentPort!.postMessage({ ready: true });
}

parentPort.on("message", async (msg: {
  id: number;
  proofHex: string;
  publicInputs: string[];
}) => {
  try {
    const proofBytes = Buffer.from(
      msg.proofHex.startsWith("0x") ? msg.proofHex.slice(2) : msg.proofHex,
      "hex"
    );
    const valid = await backend.verifyProof({
      proof: proofBytes,
      publicInputs: msg.publicInputs,
    } as any);
    parentPort!.postMessage({ id: msg.id, valid });
  } catch (err: any) {
    parentPort!.postMessage({ id: msg.id, error: err?.message ?? String(err) });
  }
});

init().catch((err) => {
  console.error("[verifier-worker] init failed:", err);
  process.exit(1);
});
