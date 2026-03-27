import type { NextPage } from "next";

const ForkPage: NextPage = () => {
  return (
    <div
      className="relative min-h-[calc(100vh-56px)]"
      style={{
        backgroundImage: "url(/hero-fork.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-black/75" />
      <div className="relative z-10 flex items-center flex-col flex-grow pt-10 pb-20">
        <div className="px-5 max-w-3xl w-full">
          {/* Hero */}
          <div className="mb-12">
            <p className="font-mono text-xs tracking-widest uppercase opacity-50 mb-2">open infrastructure</p>
            <h1 className="text-4xl font-bold tracking-tight">Fork This</h1>
            <p className="text-lg opacity-70 mt-3 max-w-xl">
              The ZK credit system is designed to be forked. Token-agnostic. Deploy your own contract, point at any LLM
              provider, run your own privacy-preserving API in minutes.
            </p>
          </div>

          {/* Architecture */}
          <div className="mb-12">
            <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">what you get</h2>

            <div className="space-y-4">
              {/* Layer 1 */}
              <div className="border border-base-content/20 rounded-lg p-5">
                <div className="flex items-start gap-3">
                  <span className="font-mono text-xs bg-accent text-accent-content px-2 py-0.5 rounded shrink-0 mt-0.5">
                    L1
                  </span>
                  <div>
                    <h3 className="text-lg font-bold">
                      APICredits.sol
                      <span className="text-xs font-normal opacity-50 ml-2">— the forkable primitive</span>
                    </h3>
                    <p className="text-sm opacity-70 mt-1">
                      ZK Merkle tree + ERC-20 staking. No opinion on token, price, or payment method. Accepts any ERC-20
                      set at deploy time. This is what you deploy.
                    </p>
                    <div className="mt-3 font-mono text-xs opacity-60 space-y-0.5">
                      <p>├─ stake() / unstake()</p>
                      <p>├─ register() / stakeAndRegister()</p>
                      <p>├─ claimServer()</p>
                      <p>└─ Poseidon2 Merkle tree (Binary IMT, 16 levels, 65k leaves)</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Layer 2 */}
              <div className="border border-base-content/10 rounded-lg p-5 opacity-80">
                <div className="flex items-start gap-3">
                  <span className="font-mono text-xs bg-secondary text-secondary-content px-2 py-0.5 rounded shrink-0 mt-0.5">
                    L2
                  </span>
                  <div>
                    <h3 className="text-lg font-bold">
                      Noir Circuit
                      <span className="text-xs font-normal opacity-50 ml-2">— ZK proof in your browser</span>
                    </h3>
                    <p className="text-sm opacity-70 mt-1">
                      UltraHonk proof generated client-side via Barretenberg WASM. Proves Merkle membership and
                      nullifier derivation without revealing your secret. No trusted setup.
                    </p>
                    <div className="mt-3 font-mono text-xs opacity-60 space-y-0.5">
                      <p>├─ commitment = poseidon2(nullifier, secret)</p>
                      <p>├─ nullifier_hash = poseidon2(nullifier)</p>
                      <p>├─ verify Merkle proof against onchain root</p>
                      <p>└─ 10-30s proof time in-browser</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Layer 3 */}
              <div className="border border-base-content/10 rounded-lg p-5 opacity-80">
                <div className="flex items-start gap-3">
                  <span className="font-mono text-xs bg-secondary text-secondary-content px-2 py-0.5 rounded shrink-0 mt-0.5">
                    L3
                  </span>
                  <div>
                    <h3 className="text-lg font-bold">
                      API Server
                      <span className="text-xs font-normal opacity-50 ml-2">— your privacy gateway</span>
                    </h3>
                    <p className="text-sm opacity-70 mt-1">
                      Verifies proofs at chat session start, issues bearer tokens with $1.00 balance, proxies to any LLM
                      provider. Tracks nullifiers and session tokens in Redis. Never sees your wallet.
                    </p>
                    <div className="mt-3 font-mono text-xs opacity-60 space-y-0.5">
                      <p>├─ /v1/chat/start — burn proof, get session token + first response</p>
                      <p>├─ /v1/chat — continue chat session with bearer token</p>
                      <p>├─ /tree — current Merkle tree for client</p>
                      <p>└─ /circuit — circuit JSON for client-side proving</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-base-content/10 my-10" />

          {/* How to Fork */}
          <div className="mb-12">
            <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">deploy your own</h2>

            <div className="bg-base-300 rounded-lg p-6">
              <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap">
                {`# 1. Clone the monorepo
git clone https://github.com/clawdbotatg/zkllmapi-v2
cd zkllmapi-v2

# 2. Install
yarn install

# 3. Deploy APICredits with YOUR token
#    Edit packages/foundry/script/Deploy.s.sol
#    Set your ERC-20 address + price per credit
cd packages/foundry
forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC --broadcast --verify

# 4. Update the API server
#    Set CONTRACT_ADDRESS in your server env
CONTRACT_ADDRESS=0xYourNewContract

# 5. Point at your own LLM provider
#    Edit packages/backend/src/index.ts
#    Change VENICE_API_KEY to your key, or swap the proxy URL entirely

# 6. Run
cd packages/backend && yarn start`}
              </pre>
            </div>

            <p className="text-sm opacity-50 mt-3">
              APICredits works standalone with a fixed price in your token. For dynamic USD-pegged pricing, add a TWAP
              oracle and modify stakeAndRegister to read it.
            </p>
          </div>

          {/* Divider */}
          <div className="border-t border-base-content/10 my-10" />

          {/* What stays / what changes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
            {/* Stays the same */}
            <div>
              <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">unchanged when you fork</h2>
              <ul className="space-y-3">
                {[
                  ["ZK Circuit", "Noir + UltraHonk. Commitment, Merkle proof, nullifier derivation."],
                  ["Privacy Model", "Poseidon2 commitments, unlinkable nullifiers, anonymity set = tree size."],
                  ["API Server", "Proof verification, nullifier tracking, historical root cache."],
                  ["Merkle Tree", "Binary incremental tree, 16 levels, Poseidon2 hashing."],
                ].map(([title, desc]) => (
                  <li key={title} className="flex items-start gap-2">
                    <span className="text-success mt-0.5">■</span>
                    <div>
                      <p className="font-semibold text-sm">{title}</p>
                      <p className="text-xs opacity-60">{desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* Yours to customize */}
            <div>
              <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">yours to customize</h2>
              <ul className="space-y-3">
                {[
                  ["Payment Token", "Any ERC-20. Set at deploy time."],
                  ["Pricing", "Fixed, TWAP, auction, governance vote — anything."],
                  ["Inference Provider", "Venice, OpenAI, Anthropic, local model — swap the API URL."],
                  ["Credit Model", "Per-call (v1) or per-chat-session with bearer token (v2)."],
                  ["Settlement", "Direct claim, DAO treasury, automatic LP provision — your choice."],
                ].map(([title, desc]) => (
                  <li key={title} className="flex items-start gap-2">
                    <span className="text-warning mt-0.5">◆</span>
                    <div>
                      <p className="font-semibold text-sm">{title}</p>
                      <p className="text-xs opacity-60">{desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-base-content/10 my-10" />

          {/* Data flow */}
          <div className="mb-12">
            <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">data flow</h2>
            <div className="bg-base-300 rounded-lg p-6 overflow-x-auto">
              <pre className="font-mono text-xs leading-relaxed">
                {`┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser   │     │  APICredits  │     │  API Server  │
│             │     │   (onchain)  │     │  (offchain)  │
└──────┬──────┘     └──────┬───────┘     └──────┬───────┘
       │                   │                    │
       │  1. stakeAndRegister()                 │
       │──────────────────>│                    │
       │                   │  commitments       │
       │                   │  inserted into     │
       │                   │  Merkle tree      │
       │                   │                    │
       │  2. generate ZK proof (client-side)    │
       │  prove: I know secret behind a leaf    │
       │                                        │
       │  3. POST /v1/chat/start {proof}       │
       │───────────────────────────────────────>│
       │                                        │
       │                        4. verify proof │
       │                        5. check root    │
       │                        6. burn nullif   │
       │                        7. create token │
       │                        8. call LLM     │
       │                                        │
       │  9. bearer token + first response      │
       │<───────────────────────────────────────│
       │                                        │
       │  10. POST /v1/chat {token, messages}  │
       │───────────────────────────────────────>│
       │                                        │
       │  11. LLM response (no ZK needed)      │
       │<───────────────────────────────────────│`}
              </pre>
            </div>
            <p className="text-xs opacity-40 mt-2 font-mono">
              Step 1 requires a wallet. Steps 3-11 are anonymous — no wallet, no identity, just a bearer token.
            </p>
          </div>

          {/* CTA */}
          <div className="text-center mt-12">
            <div className="flex flex-wrap justify-center gap-4">
              <a
                href="https://github.com/clawdbotatg/zkllmapi-v2"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-accent btn-lg"
              >
                GitHub ↗
              </a>
            </div>
            <p className="text-xs opacity-40 mt-3 font-mono">
              MIT licensed. Fork it. Ship it. Don&apos;t ask permission.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForkPage;
