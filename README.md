# ZK LLM API (v2)

Anonymous, privacy-preserving access to LLMs using zero-knowledge proofs on Base.

Pay with [CLAWD](https://basescan.org/address/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07) token. The server never learns who you are — it only verifies a ZK proof that you hold a valid, unspent credit in an onchain Merkle tree. Built on [Scaffold-ETH 2](https://scaffoldeth.io).

Based on ["ZK API Usage Credits: LLMs and Beyond"](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Vitalik Buterin and Davide Crapis.

## How It Works

1. Buy CLAWD and register commitments onchain via the `APICredits` contract on Base
2. Your browser generates a Noir ZK proof (UltraHonk) proving you own a valid credit
3. The backend verifies the proof, burns the nullifier, issues a bearer token with a $0.05 session balance
4. Chat messages deduct from the balance at actual Venice cost — no wallet, no identity

Two privacy layers: **ZK proofs** hide *who* you are; **Venice TEE/E2EE** hides *what* you're asking.

## Packages

| Package | Description |
|---------|-------------|
| `packages/nextjs` | Next.js frontend — buy credits, chat, about page (App Router, RainbowKit, Wagmi, DaisyUI) |
| `packages/foundry` | Solidity contracts — `APICredits` (ERC-20 payments + Poseidon2 Merkle tree), deployment scripts |
| `packages/backend` | Express API server — verifies UltraHonk proofs (Barretenberg), mirrors onchain Merkle tree, proxies Venice AI, Upstash Redis for nullifiers/tokens |
| `packages/proxy` | OpenAI-compatible proxy — local proof generation, credit management, CLI chat, E2EE support |
| `packages/circuits` | Noir ZK circuit — proves Merkle membership + nullifier correctness without revealing identity |

## Requirements

- [Node.js >= 20.18.3](https://nodejs.org/en/download/)
- [Yarn v3](https://yarnpkg.com/getting-started/install)
- [Git](https://git-scm.com/downloads)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for contract compilation)
- [Nargo](https://noir-lang.org/docs/getting_started/installation/) (for circuit compilation)

## Quickstart

```bash
git clone https://github.com/clawdbotatg/zkllmapi-v2
cd zkllmapi-v2
yarn install
```

### Frontend

```bash
yarn start              # Next.js dev server at http://localhost:3000
```

### Backend

```bash
cp packages/backend/.env.example packages/backend/.env
# Edit .env: set VENICE_API_KEY, CONTRACT_ADDRESS, RPC_URL, UPSTASH_REDIS_REST_URL/TOKEN

yarn backend:dev        # Express server at http://localhost:3001
```

### Contracts (Foundry)

```bash
yarn chain              # Local Anvil chain
yarn deploy             # Deploy contracts
yarn compile            # Compile Solidity + Noir circuits
```

### Circuits (Noir)

```bash
yarn circuits:compile   # Compile Noir circuit → packages/circuits/target/circuits.json
```

### Proxy (OpenAI-compatible)

```bash
cp packages/proxy/.env.example packages/proxy/.env
# Edit .env: set PRIVATE_KEY, CONTRACT_ADDRESS, API_URL

yarn proxy:dev          # OpenAI-compatible proxy server
yarn chat               # CLI chat interface
```

## Environment Variables

### Backend (`packages/backend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VENICE_API_KEY` | Yes | Venice AI API key |
| `CONTRACT_ADDRESS` | Yes | APICredits contract on Base |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis URL (nullifiers + tokens) |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis token |
| `RPC_URL` | No | Base RPC (default: `https://mainnet.base.org`) |
| `WS_URL` | No | Base WebSocket RPC for real-time events |
| `PORT` | No | Server port (default: 3001) |

### Frontend (`packages/nextjs/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | No | Backend URL (default: `https://backend.zkllmapi.com`) |
| `NEXT_PUBLIC_ALCHEMY_API_KEY` | No | Alchemy key for Base RPC |
| `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | No | WalletConnect project ID |

## All Commands

```bash
# Development
yarn start              # Next.js frontend
yarn backend:dev        # Backend API server
yarn proxy:dev          # OpenAI-compatible proxy
yarn chain              # Local Anvil chain
yarn deploy             # Deploy contracts
yarn chat               # CLI chat via proxy

# Building
yarn compile            # Compile Solidity + Noir
yarn circuits:compile   # Compile Noir circuit only
yarn next:build         # Build frontend
yarn backend:build      # Build backend
yarn proxy:build        # Build proxy

# Code quality
yarn lint               # Lint all packages
yarn format             # Format all packages
yarn foundry:test       # Run Foundry tests

# Deployment
yarn vercel:yolo --prod # Deploy frontend to Vercel
```

## Architecture

```
Browser (Next.js)                    Backend (Express)              Base (L1)
┌─────────────────┐    proof+msg    ┌──────────────┐    read      ┌──────────────┐
│ Buy credits     │───────────────→│ Verify proof  │←────────────│ APICredits   │
│ Generate proof  │    bearer token │ Track nulls   │  events     │ Poseidon2 IMT│
│ Chat UI         │←───────────────│ Proxy Venice  │             │ CLAWD ERC-20 │
│ E2EE encrypt    │                │ Redis tokens  │             └──────────────┘
└─────────────────┘                └──────────────┘
                                          │
                                          ▼
                                   Venice AI (TEE/E2EE)
```

## Links

- [Live app](https://zkllmapi.com)
- [Original paper](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104)
- [CLAWD token](https://basescan.org/address/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07)
- [About page](https://zkllmapi.com/about) — full technical breakdown
- [Scaffold-ETH 2 docs](https://docs.scaffoldeth.io)

## License

MIT
