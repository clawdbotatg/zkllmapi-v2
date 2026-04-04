/**
 * e2e.ts — Automated end-to-end test for zkllmapi-v2 production system
 *
 * Usage:
 *   tsx src/e2e.ts
 *
 * Requires:
 *   - An unspent credit in credits.json, OR PRIVATE_KEY env var to buy one
 *   - VENICE_API_KEY env var for E2EE attestation
 *
 * Exits 0 on success, 1 on failure.
 */

import "dotenv/config"
import { API_URL } from "./config.js"
import { loadCredits, saveCredits, type Credit } from "./credits.js"
import { generateProof, type ReadyProof, type ProofTimings } from "./prove.js"
import { encryptChatRequest } from "./e2ee.js"

const MODEL = process.env.MODEL ?? "zai-org-glm-5"

type StepStatus = "PASS" | "FAIL" | "SKIP"

interface StepResult {
  name: string
  status: StepStatus
  ms: number
  error?: string
}

const results: StepResult[] = []
let failed = false
let proofTimings: ProofTimings | null = null
let chatRoundTripMs = 0
let chatBackendVerifyMs = 0
let chatVeniceMs = 0
let chatTokenMs = 0

async function runStep<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T | null> {
  if (failed) {
    results.push({ name, status: "SKIP", ms: 0 })
    return null
  }

  const start = Date.now()
  try {
    const result = await fn()
    results.push({ name, status: "PASS", ms: Date.now() - start })
    return result
  } catch (err: any) {
    const ms = Date.now() - start
    results.push({ name, status: "FAIL", ms, error: err.message })
    failed = true
    console.error(`[e2e] FAIL: ${name} — ${err.message}`)
    return null
  }
}

function printResults(totalMs: number) {
  const nameWidth = 28
  const resultWidth = 12

  console.log()
  console.log(`\u250c${"".padEnd(nameWidth + resultWidth + 3, "\u2500")}\u2510`)
  console.log(`\u2502  zkllmapi E2E Test Results${"".padEnd(nameWidth + resultWidth + 3 - 28, " ")}\u2502`)
  console.log(`\u251c${"".padEnd(nameWidth + 2, "\u2500")}\u252c${"".padEnd(resultWidth, "\u2500")}\u2524`)
  console.log(
    `\u2502  ${"Step".padEnd(nameWidth)}\u2502  ${"Result".padEnd(resultWidth - 2)}\u2502`
  )
  console.log(`\u251c${"".padEnd(nameWidth + 2, "\u2500")}\u253c${"".padEnd(resultWidth, "\u2500")}\u2524`)

  for (const r of results) {
    const icon = r.status === "PASS" ? "\u2705" : r.status === "FAIL" ? "\u274c" : "\u23ed\ufe0f"
    const detail =
      r.status === "SKIP"
        ? "SKIPPED"
        : `${icon} ${r.ms}ms`
    console.log(
      `\u2502  ${r.name.padEnd(nameWidth)}\u2502  ${detail.padEnd(resultWidth - 2)}\u2502`
    )
  }

  console.log(`\u251c${"".padEnd(nameWidth + 2, "\u2500")}\u253c${"".padEnd(resultWidth, "\u2500")}\u2524`)
  console.log(
    `\u2502  ${"Total".padEnd(nameWidth)}\u2502  ${`${totalMs}ms`.padEnd(resultWidth - 2)}\u2502`
  )
  console.log(`\u2514${"".padEnd(nameWidth + 2, "\u2500")}\u2534${"".padEnd(resultWidth, "\u2500")}\u2518`)
  console.log()
}

function printTimingReport() {
  console.log("=" .repeat(60))
  console.log("  TIMING REPORT")
  console.log("=" .repeat(60))

  // ── ZK Proof Generation ───────────────────────────────
  if (proofTimings) {
    const t = proofTimings
    console.log()
    console.log("  ZK PROOF GENERATION (client-side)")
    console.log(`  \u2502  fetch Merkle tree (from backend)    ${String(t.fetchTree).padStart(5)}ms`)
    console.log(`  \u2502  compute Merkle path (local)         ${String(t.computePath).padStart(5)}ms`)
    console.log(`  \u2502  init Barretenberg (WASM load)      ${String(t.initBarretenberg).padStart(5)}ms`)
    console.log(`  \u2502  Poseidon2 hash (nullifier)          ${String(t.poseidon2Hash).padStart(5)}ms`)
    console.log(`  \u2502  fetch circuit artifact (backend)    ${String(t.fetchCircuit).padStart(5)}ms`)
    console.log(`  \u2502  generate witness (Noir/ACVM)        ${String(t.generateWitness).padStart(5)}ms`)
    console.log(`  \u2502  generate UltraHonk proof (bb.js)    ${String(t.generateProof).padStart(5)}ms`)
    console.log(`  \u2500\u2500\u2500`.repeat(1))
    console.log(`  \u2502  TOTAL proof generation               ${String(t.total).padStart(5)}ms`)

    // Breakdown of network vs compute
    const network = t.fetchTree + t.fetchCircuit
    const compute = t.initBarretenberg + t.poseidon2Hash + t.generateWitness + t.generateProof
    console.log()
    console.log(`  NETWORK (fetch tree + circuit):           ${String(network).padStart(5)}ms  (${(network/t.total*100).toFixed(0)}%)`)
    console.log(`  COMPUTE (BB init + hash + witness + ZK): ${String(compute).padStart(5)}ms  (${(compute/t.total*100).toFixed(0)}%)`)
  }

  // ── Chat API Call ─────────────────────────────────────
  console.log()
  console.log("  CHAT API CALL (client-side)")
  console.log(`  \u2502  total round-trip (POST /v1/chat)      ${String(chatRoundTripMs).padStart(5)}ms`)
  if (chatBackendVerifyMs > 0) {
    console.log(`  \u2502    ZK verification (backend)            ${String(chatBackendVerifyMs).padStart(5)}ms`)
  }
  if (chatVeniceMs > 0) {
    console.log(`  \u2502    Venice AI inference                 ${String(chatVeniceMs).padStart(5)}ms`)
  }
  if (chatTokenMs > 0) {
    console.log(`  \u2502    token creation + Redis write         ${String(chatTokenMs).padStart(5)}ms`)
  }

  // ── Overall ──────────────────────────────────────────
  if (proofTimings) {
    const proofTotal = proofTimings.total
    const overhead = results.reduce((sum, r) => sum + r.ms, 0) - proofTotal - chatRoundTripMs
    console.log()
    console.log("  BREAKDOWN")
    console.log(`  \u2502  ZK proof generation                  ${String(proofTotal).padStart(5)}ms`)
    console.log(`  \u2502  Chat API round-trip                 ${String(chatRoundTripMs).padStart(5)}ms`)
    console.log(`  \u2502  Other overhead                      ${String(Math.max(0, overhead)).padStart(5)}ms`)
    const total = proofTotal + chatRoundTripMs + Math.max(0, overhead)
    console.log(`  \u2500\u2500\u2500`.repeat(1))
    console.log(`  \u2502  E2E LATENCY (proof + first message)  ${String(total).padStart(5)}ms  (${(total/1000).toFixed(2)}s)`)
  }

  console.log()
  console.log("=" .repeat(60))
  console.log()
}

async function main() {
  console.log("[e2e] zkllmapi end-to-end test")
  console.log(`[e2e] backend: ${API_URL}`)
  console.log(`[e2e] model: ${MODEL}`)
  console.log()

  const totalStart = Date.now()
  let credit: Credit | null = null
  let proof: ReadyProof | null = null
  let justBought = false

  // Step 1: Health check
  await runStep("1. Backend health", async () => {
    const res = await fetch(`${API_URL}/health`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const health = await res.json()
    if (!health.treeSize || health.treeSize <= 0) {
      throw new Error(`treeSize is ${health.treeSize}, expected > 0`)
    }
    return health
  })

  // Step 2: Credit acquisition
  credit = await runStep("2. Credit acquisition", async () => {
    const credits = loadCredits()
    const unspent = credits.find(c => !c.spent)

    if (unspent) {
      console.log(`[e2e] found existing unspent credit: ${unspent.commitment.slice(0, 20)}...`)
      return unspent
    }

    console.log("[e2e] no unspent credits found")
    const pk = process.env.PRIVATE_KEY
    if (!pk) {
      throw new Error(
        "No unspent credits in credits.json and PRIVATE_KEY env var is not set. " +
        "Either add credits or set PRIVATE_KEY to buy one automatically."
      )
    }

    console.log("[e2e] buying 1 credit...")
    const { buyCredits } = await import("./buy.js")
    const newCredits = await buyCredits(1)
    justBought = true

    const existing = loadCredits()
    saveCredits([...existing, ...newCredits])
    console.log(`[e2e] bought credit: ${newCredits[0].commitment.slice(0, 20)}...`)
    return newCredits[0]
  })

  // Step 3: Wait for indexing
  await runStep("3. Tree indexing", async () => {
    if (!justBought) {
      console.log("[e2e] credit was pre-existing, verifying it exists in tree...")
    } else {
      console.log("[e2e] just bought credit, waiting for tree indexing...")
    }

    const timeoutMs = 90_000
    const pollMs = 2_000
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${API_URL}/tree`)
        if (!res.ok) throw new Error(`/tree returned ${res.status}`)
        const tree = await res.json()
        const found = tree.leaves?.includes(credit!.commitment)
        if (found) {
          console.log(`[e2e] commitment found in tree (${tree.leaves.length} leaves) in ${Date.now() - start}ms`)
          return
        }
        if (!justBought) {
          throw new Error(
            `Pre-existing credit commitment ${credit!.commitment.slice(0, 20)}... not found in tree`
          )
        }
      } catch (err: any) {
        if (!justBought) throw err
        if (Date.now() - start > timeoutMs - pollMs) throw err
      }
      await new Promise(r => setTimeout(r, pollMs))
    }

    throw new Error(`Timeout after ${timeoutMs}ms waiting for commitment in tree`)
  })

  // Step 4: ZK proof generation (with sub-step timings)
  const proofResult = await runStep("4. ZK proof generation", async () => {
    const p = await generateProof(credit!)
    proofTimings = p.timings ?? null
    console.log(`[e2e] proof generated, nullifier hash: ${p.nullifierHashHex.slice(0, 20)}...`)
    return p
  })
  proof = proofResult

  // Step 5: Send test chat message (with round-trip timing)
  let responseContent: string | null = null
  const chatResult = await runStep("5. Chat API call", async () => {
    const messages = [{ role: "user" as const, content: "Say 'hello' and nothing else." }]
    const e2eeResult = await encryptChatRequest(messages, MODEL)
    const encryptedMessages = e2eeResult?.encryptedMessages ?? messages
    const e2eeHeaders = e2eeResult?.e2eeHeaders ?? {}

    const body = {
      messages: encryptedMessages,
      model: MODEL,
      stream: false,
      proof: proof!.proofHex,
      publicInputs: proof!.publicInputs,
      nullifier_hash: proof!.nullifierHashHex,
      root: proof!.rootHex,
      depth: proof!.depth,
    }

    const headers = { "Content-Type": "application/json", ...e2eeHeaders }

    const t0 = Date.now()
    const res = await fetch(`${API_URL}/v1/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    chatRoundTripMs = Date.now() - t0

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`API returned ${res.status}: ${errBody}`)
    }

    // Try to extract backend step timings from response headers
    const xTiming = res.headers.get("x-timing")
    if (xTiming) {
      try {
        const timing = JSON.parse(xTiming)
        chatBackendVerifyMs = timing.verify ?? 0
        chatVeniceMs = timing.venice ?? 0
        chatTokenMs = timing.token ?? 0
      } catch { /* ignore */ }
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ""
    return content
  })
  responseContent = chatResult

  // Step 6: Verify response
  await runStep("6. Response validation", async () => {
    if (!responseContent || responseContent.trim().length === 0) {
      throw new Error("Response content is empty")
    }
    console.log(`[e2e] response: "${responseContent}"`)
  })

  // Step 7: Mark credit spent
  await runStep("7. Credit marked spent", async () => {
    const credits = loadCredits()
    const c = credits.find(x => x.commitment === credit!.commitment)
    if (c) {
      c.spent = true
      saveCredits(credits)
      console.log(`[e2e] marked credit ${credit!.commitment.slice(0, 20)}... as spent`)
    }
  })

  // Summary
  const totalMs = Date.now() - totalStart
  printResults(totalMs)
  printTimingReport()

  const allPassed = results.every(r => r.status === "PASS")
  if (allPassed) {
    console.log("[e2e] all steps passed")
    process.exit(0)
  } else {
    const failedStep = results.find(r => r.status === "FAIL")
    console.error(`[e2e] test failed at: ${failedStep?.name} — ${failedStep?.error}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error("[e2e] unexpected error:", err)
  process.exit(1)
})
