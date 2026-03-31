# ZK API Credits Circuit

Noir circuit for anonymous API credit consumption via zero-knowledge proofs.

## What It Proves

The circuit proves that:
1. The prover knows a `nullifier` and `secret` pair
2. `commitment = Poseidon2(nullifier, secret)` exists as a leaf in the Merkle tree
3. `nullifier_hash = Poseidon2(nullifier)` is computed correctly
4. The Merkle root matches the on-chain tree root

**Public inputs** (visible to verifier/server):
- `root` — current Merkle tree root
- `nullifier_hash` — prevents double-spending (revealed without leaking the secret)
- `depth` — tree depth

**Private inputs** (never revealed):
- `secret` — user's secret key
- `nullifier` — unique per-credit random value
- `siblings` — Merkle proof path
- `indices` — Merkle proof indices (left/right at each level)

## How It Works

1. User buys credits → contract stores `Poseidon2(nullifier, secret)` in a Merkle tree
2. User generates a ZK proof in-browser proving they know a valid leaf
3. Server verifies the proof and checks `nullifier_hash` hasn't been seen before
4. If valid, the server starts a conversation — issuing a bearer token with a $0.05 balance. Subsequent messages use the token (no proof needed) until the balance is depleted. **The server never learns who the user is.**

The ZK proof breaks the link between the wallet that paid and the conversation.

## Prerequisites

Install [Nargo](https://noir-lang.org/docs/getting_started/installation/) (the Noir compiler):

```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup
```

Nargo is NOT a Node.js package — it's a standalone binary.

## Compile

```bash
cd packages/circuits
nargo compile
```

This generates:
- `target/circuits.json` — the compiled circuit (ACIR bytecode)
- Use `nargo codegen-verifier` to generate a Solidity verifier contract

## Test

```bash
nargo test
```

## Circuit Dependencies

- `binary_merkle_root` from [zk-kit.noir](https://github.com/privacy-scaling-explorations/zk-kit.noir) — Merkle proof verification
- `std::hash::poseidon2` — Noir's built-in Poseidon2 hash (matches `@aztec/bb.js` and on-chain `LibPoseidon2`)
