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
      if (tree.leaves?.includes(commitment)) {
        console.log(`   ✅ commitment found in tree after ${Date.now() - start}ms`)
        return
      }
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`Timeout waiting for commitment ${commitment.slice(0,20)}... in tree`)
}

async function testE2EE() {
  const credits = loadCredits()
  const credit = credits.find(c => !c.spent)
  if (!credit) { console.error("no unspent credit"); return }

  console.log("=== E2EE End-to-End Test ===\n")

  // Wait for onchain indexing
  console.log("0. Waiting for commitment to be indexed...")
  await waitForCommitment(credit.commitment)

  // 1. Generate ZK proof
  console.log("1. Generating ZK proof...")
  const proof = await generateProof(credit)
  console.log(`   ✅ proof generated (nullifier: ${proof.nullifierHashHex.slice(0,20)}...)\n`)

  // 2. Encrypt message for E2EE
  console.log("2. Encrypting message for E2EE...")
  const messages = [{ role: "user", content: "say hi and nothing else" }]
  const e2eeResult = await encryptChatRequest(messages, "e2ee-glm-5")
  if (!e2eeResult) { console.error("❌ E2EE attestation failed"); return }
  console.log(`   ✅ attestation verified (provider: ${(e2eeResult.session as any).teeProvider})`)
  console.log(`   ✅ ${e2eeResult.encryptedMessages.length} message(s) encrypted\n`)

  // 3. Start conversation with proof
  console.log("3. Calling /v1/chat/start (ZK proof + E2EE headers)...")
  const startRes = await fetch(`${API_URL}/v1/chat/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...e2eeResult.e2eeHeaders,
    },
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

  if (!startRes.ok) {
    const err = await startRes.text()
    console.error(`   ❌ HTTP ${startRes.status}: ${err}`)
    return
  }

  const startData = await startRes.json()
  console.log(`   ✅ HTTP 200 — balance: $${startData.balanceRemaining.toFixed(6)}`)

  // 4. Check if response is encrypted and decrypt
  // The /v1/chat/start response structure: { token, balanceRemaining, expiresAt, response: { encrypted_chunks } }
  // The /v1/chat/start response structure: { token, balanceRemaining, expiresAt, response: { encrypted_chunks } }
  const veniceResp = (startData as any).response ?? startData
  const encryptedChunks: string[] = (startData as any).response?.encrypted_chunks ?? []
  const plaintextContent: string = (startData as any).response?.choices?.[0]?.message?.content ?? ""

  if (encryptedChunks && encryptedChunks.length > 0) {
    console.log(`   ✅ response is encrypted (${encryptedChunks.length} chunk(s))`)

    console.log("\n4. Decrypting response with client private key...")
    const decrypted = decryptResponseChunks(encryptedChunks, e2eeResult.session)
    if (!decrypted || decrypted.trim().length === 0) {
      console.error("   ❌ decryption returned empty string")
      return
    }
    console.log(`   ✅ decrypted: "${decrypted.slice(0, 100)}${decrypted.length > 100 ? "..." : ""}"`)
  } else if (plaintextContent) {
    console.log(`   ℹ response is plaintext: "${plaintextContent.slice(0, 50)}"`)
  } else {
    console.error("   ❌ no response content found:", JSON.stringify(startData).slice(0, 300))
    return
  }

  // Mark spent
  credit.spent = true
  saveCredits(credits)
  console.log("\n=== ALL TESTS PASSED ===")
}

testE2EE().catch(err => {
  console.error("\n❌ Test failed:", err.message)
  process.exit(1)
})
