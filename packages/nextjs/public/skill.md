# ZK LLM API — Agent Skill

Use this skill to give your AI agent private, anonymous LLM access via zero-knowledge proofs.

## What This Does

ZK LLM API lets agents access an LLM endpoint without revealing their identity. The server verifies a ZK proof of valid credit — it never learns who is calling. Pay with CLAWD token on Base.

## Two Integration Paths

### Option A: OpenAI-Compatible Proxy (Recommended)

Run the proxy locally. It handles proof generation, credit management, and auto-purchasing. Your agent talks to a standard OpenAI-compatible API.

```bash
# Setup
git clone https://github.com/clawdbotatg/zkllmapi-v2
cd zkllmapi-v2 && yarn install

# Configure proxy
cp packages/proxy/.env.example packages/proxy/.env
# Set PRIVATE_KEY (funded Base wallet with CLAWD + ETH for gas)

# Run
yarn proxy:dev
```

Then point your agent at `http://localhost:3100/v1`:

```bash
curl http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai-org-glm-5",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Endpoints:**
- `POST /v1/chat/completions` — OpenAI-compatible chat (streaming supported)
- `GET /v1/models` — list available models
- `POST /v1/conversation/end` — end current conversation early
- `GET /health` — proxy status, credit count, proof queue depth

The proxy auto-buys credits when inventory drops below threshold (default: 3 unspent). Configure with `BUY_THRESHOLD` and `BUY_CHUNK` env vars.

### Option B: Direct Backend API (Browser-Style)

Generate the ZK proof yourself and call the backend directly. Maximum privacy — the server never sees your secret.

**Step 1: Start a conversation (proof required)**

```bash
POST https://backend.zkllmapi.com/v1/chat/start
Content-Type: application/json

{
  "proof": "0x...",
  "nullifier_hash": "0x...",
  "root": "0x...",
  "depth": 5,
  "messages": [{"role": "user", "content": "Hello"}]
}
```

Response includes a `token` and `balanceRemaining` ($0.05 per credit).

**Step 2: Continue the conversation (bearer token)**

```bash
POST https://backend.zkllmapi.com/v1/chat
Authorization: Bearer <token>
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "..."},
    {"role": "user", "content": "Follow-up question"}
  ]
}
```

The balance deducts at actual Venice cost per message. When it hits $0, the session ends.

**Useful read endpoints:**
- `GET /health` — tree size, nullifier count, root
- `GET /contract` — contract address and chain ID
- `GET /tree` — full Merkle tree (for computing proof paths)
- `GET /circuit` — compiled Noir circuit JSON
- `GET /nullifier/:hash` — check if a nullifier has been spent

## Model

The server runs `zai-org-glm-5` for all requests. The `model` field is accepted but ignored.

For end-to-end encrypted inference (Venice TEE), use model `e2ee-glm-5`.

## Key Details

- **Chain:** Base mainnet (8453)
- **Token:** CLAWD (`0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`)
- **Contract:** APICredits (`0x595463222a592416BCbdADb297Bf7D050c09a44E`)
- **Session balance:** $0.05 per credit, deducted at actual usage cost
- **Session TTL:** 24 hours
- **ZK circuit:** Noir + Barretenberg UltraHonk
- **Hashing:** Poseidon2 (must use `@aztec/bb.js` implementation)

## Source

- [GitHub](https://github.com/clawdbotatg/zkllmapi-v2)
- [About page](https://zkllmapi.com/about)
- [Original paper](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104)
