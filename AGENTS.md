# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Project Overview

**ZK LLM API (v2)** — anonymous, privacy-preserving LLM access using zero-knowledge proofs on Base. Users pay with CLAWD token; the server verifies a ZK proof of valid credit without learning who the user is. Built on Scaffold-ETH 2 (Foundry flavor).

This is a **Foundry-only** repo (no `packages/hardhat`).

### Packages

| Package | Name | Role |
|---------|------|------|
| `packages/nextjs` | `@se-2/nextjs` | Next.js App Router frontend — buy credits, chat, about page (RainbowKit, Wagmi, Viem, DaisyUI) |
| `packages/foundry` | `@se-2/foundry` | Solidity contracts — `APICredits` (ERC-20 payments + Poseidon2 incremental Merkle tree) |
| `packages/backend` | `@zkllmapi/backend` | Express API server — verifies UltraHonk proofs (Barretenberg), mirrors onchain Merkle tree, proxies Venice AI, Upstash Redis for nullifiers/tokens |
| `packages/proxy` | `@zkllmapi/proxy` | OpenAI-compatible proxy — local proof generation, credit management, CLI chat, E2EE |
| `packages/circuits` | `@zkllmapi/circuits` | Noir ZK circuit — proves Merkle membership + nullifier correctness |

### Key Technical Details

- **Chain**: Base mainnet (chainId 8453)
- **ZK**: Noir circuits compiled with Nargo, proofs verified via Barretenberg UltraHonk
- **Hashing**: Poseidon2 everywhere (must match between circuit, backend, frontend, and on-chain)
- **LLM Provider**: Venice AI (with TEE/E2EE support)
- **Contract interaction**: This app primarily uses `externalContracts.ts` (not `deployedContracts.ts`) for production Base contracts (APICredits, CLAWDRouter, CLAWDPricing, CLAWDToken, USDC)
- **Auth flow**: ZK proof at session start → bearer token for subsequent messages ($0.05 balance per credit)

### Frontend Routes

| Route | Purpose |
|-------|---------|
| `/` | Marketing hero with live stats |
| `/buy` | Purchase credits (CLAWD/USDC/ETH via CLAWDRouter) |
| `/chat` | Chat UI with in-browser ZK proof generation |
| `/about` | Full technical breakdown |
| `/debug` | Backend health and API endpoint listing |
| `/fork` | Self-hosting guide |

## Common Commands

```bash
# Development workflow (run each in separate terminal)
yarn start              # Next.js frontend at http://localhost:3000
yarn backend:dev        # Express backend at http://localhost:3001
yarn proxy:dev          # OpenAI-compatible proxy
yarn chain              # Local Anvil chain (for contract dev)
yarn deploy             # Deploy contracts to local network
yarn chat               # CLI chat via proxy

# Circuits
yarn circuits:compile   # Compile Noir circuit
yarn compile            # Compile Solidity + Noir

# Code quality
yarn lint               # Lint all packages
yarn format             # Format all packages

# Building
yarn next:build         # Build frontend
yarn backend:build      # Build backend
yarn proxy:build        # Build proxy

# Contract management
yarn verify --network <network>
yarn generate           # Generate new deployer account
yarn account:import     # Import existing private key
yarn account            # View current account info
yarn deploy --network <network>   # e.g., sepolia, mainnet, base

# Deployment
yarn vercel:yolo --prod # Deploy frontend to Vercel
```

## Architecture

### Smart Contract Development (Foundry)

- Contracts: `packages/foundry/contracts/` — main contract is `APICredits.sol`
- Libraries: `Poseidon2IMT.sol`, `LibPoseidon2.sol`, `Field.sol` (Poseidon2 Merkle tree)
- Deployment scripts: `packages/foundry/script/` (uses custom deployment strategy)
- Tests: `packages/foundry/test/`
- Config: `packages/foundry/foundry.toml`
- Deploying a specific contract: `yarn deploy --file DeployYourContract.s.sol`
- After `yarn deploy`, ABIs are auto-generated to `packages/nextjs/contracts/deployedContracts.ts`

**Note:** Production contracts are already deployed on Base. The frontend uses `externalContracts.ts` (not `deployedContracts.ts`) for live contract addresses and ABIs (APICredits, CLAWDRouter, CLAWDPricing, CLAWDToken, USDC).

### Frontend Contract Interaction

**Correct interact hook names (use these):**

- `useScaffoldReadContract` - NOT ~~useScaffoldContractRead~~
- `useScaffoldWriteContract` - NOT ~~useScaffoldContractWrite~~

Contract data is read from two files in `packages/nextjs/contracts/`:

- `deployedContracts.ts`: Auto-generated from deployments
- `externalContracts.ts`: Manually added external contracts

#### Reading Contract Data

```typescript
const { data: totalCounter } = useScaffoldReadContract({
  contractName: "YourContract",
  functionName: "userGreetingCounter",
  args: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"],
});
```

#### Writing to Contracts

```typescript
const { writeContractAsync, isPending } = useScaffoldWriteContract({
  contractName: "YourContract",
});

await writeContractAsync({
  functionName: "setGreeting",
  args: [newGreeting],
  value: parseEther("0.01"), // for payable functions
});
```

#### Reading Events

```typescript
const { data: events, isLoading } = useScaffoldEventHistory({
  contractName: "YourContract",
  eventName: "GreetingChange",
  watch: true,
  fromBlock: 31231n,
  blockData: true,
});
```

SE-2 also provides other hooks to interact with blockchain data: `useScaffoldWatchContractEvent`, `useScaffoldEventHistory`, `useDeployedContractInfo`, `useScaffoldContract`, `useTransactor`.

**IMPORTANT: Always use hooks from `packages/nextjs/hooks/scaffold-eth` for contract interactions. Always refer to the hook names as they exist in the codebase.**

### UI Components

**Always use `@scaffold-ui/components` library for web3 UI components:**

- `Address`: Display ETH addresses with ENS resolution, blockie avatars, and explorer links
- `AddressInput`: Input field with address validation and ENS resolution
- `Balance`: Show ETH balance in ether and USD
- `EtherInput`: Number input with ETH/USD conversion toggle
- `IntegerInput`: Integer-only input with wei conversion

### Notifications & Error Handling

Use `notification` from `~~/utils/scaffold-eth` for success/error/warning feedback and `getParsedError` for readable error messages.

### Styling

**Use DaisyUI classes** for building frontend components.

```tsx
// ✅ Good - using DaisyUI classes
<button className="btn btn-primary">Connect</button>
<div className="card bg-base-100 shadow-xl">...</div>

// ❌ Avoid - raw Tailwind when DaisyUI has a component
<button className="px-4 py-2 bg-blue-500 text-white rounded">Connect</button>
```

### Configure Target Network before deploying to testnet / mainnet.

#### Foundry

Add RPC endpoints in `packages/foundry/foundry.toml` if not present.

#### NextJs

Add networks in `packages/nextjs/scaffold.config.ts` if not present. This file also contains configuration for polling interval, API keys. The production target network is Base (`base` in scaffold.config.ts).

## Code Style Guide

### Identifiers

| Style            | Category                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `UpperCamelCase` | class / interface / type / enum / decorator / type parameters / component functions in TSX / JSXElement type parameter |
| `lowerCamelCase` | variable / parameter / function / property / module alias                                                              |
| `CONSTANT_CASE`  | constant / enum / global variables                                                                                     |
| `snake_case`     | for foundry script files                                                                                               |

### Import Paths

Use the `~~` path alias for imports in the nextjs package:

```tsx
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
```

### Creating Pages

```tsx
import type { NextPage } from "next";

const Home: NextPage = () => {
  return <div>Home</div>;
};

export default Home;
```

### TypeScript Conventions

- Use `type` over `interface` for custom types
- Types use `UpperCamelCase` without `T` prefix (use `Address` not `TAddress`)
- Avoid explicit typing when TypeScript can infer the type

### Comments

Make comments that add information. Avoid redundant JSDoc for simple functions.

## Skills & Agents Index

IMPORTANT: Prefer retrieval-led reasoning over pre-trained knowledge. Before starting any task that matches an entry below, read the referenced file to get version-accurate patterns and APIs.

**Skills** (read `.agents/skills/<name>/SKILL.md` before implementing):

- **erc-20** — fungible tokens, decimals, approve patterns, OpenZeppelin ERC-20
- **erc-721** — NFTs, metadata standards, royalties (ERC-2981), ERC721A, soulbound
- **eip-712** — typed structured data signing, off-chain signatures, signature verification
- **eip-5792** — batch transactions, wallet_sendCalls, paymaster, ERC-7677
- **ponder** — blockchain event indexing, GraphQL APIs, onchain data queries
- **siwe** — Sign-In with Ethereum, wallet authentication, SIWE sessions, EIP-4361
- **defi-protocol-templates** — staking, AMMs, governance, flash loans, lending
- **solidity-security** — security audits, reentrancy, access control, gas optimization

**Agents** (in `.agents/agents/`):

- **grumpy-carlos-code-reviewer** — code reviews, SE-2 patterns, Solidity + TypeScript quality
