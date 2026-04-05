import "dotenv/config"
import { encryptChatRequest, decryptResponseChunks } from "./src/e2ee.js"
import { loadCredits, saveCredits } from "./src/credits.js"
import { generateProof } from "./src/prove.js"
import { API_URL } from "./src/config.js"

async function waitForCommitment(commitment: string, timeoutMs = 90_000, pollMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const treeRes = await fetch(`${API_URL}/tree`)
    if (treeRes.ok) {
      const tree = await treeRes.json()
      if (tree.leaves?.includes(commitment)) return
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`Timeout waiting for commitment in tree`)
}

async function testContinuation() {
  const credits = loadCredits()
  const credit = credits.find(c => !c.spent)
  if (!credit) { console.error("no unspent credit"); return }

  console.log("=== E2EE Continuation Flow Test ===\n")

  // Wait for indexing
  console.log("0. Waiting for commitment to be indexed...")
  await waitForCommitment(credit.commitment)

  // 1. Start session with first message
  console.log("1. Generating ZK proof...")
  const proof = await generateProof(credit)
  console.log("   ✅ proof generated\n")

  console.log("2. Starting conversation with E2EE...")
  const messages = [{ role: "user", content: "count from 1 to 3" }]
  const e2eeResult = await encryptChatRequest(messages, "e2ee-glm-5")
  if (!e2eeResult) { console.error("❌ attestation failed"); return }
  console.log("   ✅ attestation verified, message encrypted\n")

  const startRes = await fetch(`${API_URL}/v1/chat/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...e2eeResult.e2eeHeaders },
    body: JSON.stringify({
      messages: e2eeResult.encryptedMessages,
      model: "zai-org-glm-5",
      proof: proof.proofHex,
      publicInputs: proof.publicInputs,
      nullifier_hash: proof.nullifierHashHex,
      root: proof.rootHex,
      depth: proof.depth,
    }),
  })

  if (!startRes.ok) { console.error(`❌ start failed: ${await startRes.text()}`); return }
  const startData = await startRes.json()
  const token = startData.token
  const initialBalance = startData.balanceRemaining
  console.log(`   ✅ session started, token=${token.slice(0,16)}... balance=$${initialBalance.toFixed(6)}\n`)

  // 2. Send CONTINUATION message with same E2EE session
  console.log("3. Sending CONTINUATION message with bearer token + E2EE headers...")
  const continuationMessages = [{ role: "user", content: "what number comes next" }]
  const e2eeResult2 = await encryptChatRequest(continuationMessages, "e2ee-glm-5")
  if (!e2eeResult2) { console.error("❌ continuation attestation failed"); return }

  // IMPORTANT: this is the continuation flow — bearer token + E2EE headers
  const contRes = await fetch(`${API_URL}/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...e2eeResult2.e2eeHeaders, // same E2EE headers as start
    },
    body: JSON.stringify({
      messages: e2eeResult2.encryptedMessages,
      model: "zai-org-glm-5",
    }),
  })

  if (!contRes.ok) {
    const err = await contRes.text()
    console.error(`   ❌ continuation FAILED: HTTP ${contRes.status}: ${err}`)
    return
  }

  const contData = await contRes.json()
  console.log(`   ✅ HTTP 200`)

  // Check response
  // /v1/chat continuation returns encrypted_chunks at top level (not nested in .response)
  const encChunks: string[] = (contData as any).encrypted_chunks ?? (contData as any).response?.encrypted_chunks ?? []
  const plaintextContent: string = (contData as any).choices?.[0]?.message?.content ?? (contData as any).response?.choices?.[0]?.message?.content ?? ""

  if (encChunks.length > 0) {
    console.log("   ✅ response is encrypted — decrypting...")
    const decrypted = decryptResponseChunks(encChunks, e2eeResult2.session)
    console.log(`   ✅ decrypted: "${decrypted.slice(0, 80)}${decrypted.length > 80 ? "..." : ""}"`)
  } else if (plaintextContent) {
    console.log(`   ℹ plaintext: "${plaintextContent.slice(0, 80)}"`)
  } else {
    console.error("   ❌ no content:", JSON.stringify(contData).slice(0, 200))
    return
  }

  // Check balance was deducted
  const newBalance = parseFloat(contRes.headers.get("x-conversation-balance") ?? "0")
  if (newBalance > 0) {
    console.log(`   ✅ balance deducted: $${initialBalance.toFixed(6)} → $${newBalance.toFixed(6)}`)
  }

  // Mark spent
  credit.spent = true
  saveCredits(credits)
  console.log("\n=== ALL TESTS PASSED ===")
}

testContinuation().catch(err => {
  console.error("\n❌ Test failed:", err.message)
  process.exit(1)
})
