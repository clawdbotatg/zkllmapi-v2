# E2E Timing Report — 2026-04-02

## Run Info
- **Backend:** https://backend.v2.zkllmapi.com
- **Model:** `zai-org-glm-5`
- **Credit:** bought onchain immediately before test
- **Tree:** 59 leaves, depth 6, commitment at leaf index 58

---

## E2E Step Summary

| Step | Result | Time |
|------|--------|------|
| 1. Backend health | ✅ PASS | 196ms |
| 2. Credit acquisition | ✅ PASS | 0ms (pre-existing) |
| 3. Tree indexing | ✅ PASS | 302ms |
| 4. ZK proof generation | ✅ PASS | 753ms |
| 5. Chat API call | ✅ PASS | 26,694ms |
| 6. Response validation | ✅ PASS | 0ms |
| 7. Credit marked spent | ✅ PASS | 1ms |
| **Total** | | **27,946ms (27.9s)** |

---

## ZK Proof Generation (client-side, 752ms)

| Sub-step | Time | % | Where |
|----------|------|---|--------|
| Fetch Merkle tree (from backend) | 119ms | 16% | Network |
| Compute Merkle path (local) | <1ms | <1% | Compute |
| Init Barretenberg (WASM load) | 124ms | 16% | Compute |
| Poseidon2 hash (nullifier) | 7ms | 1% | Compute |
| Fetch circuit artifact (backend) | 53ms | 7% | Network |
| Generate witness (Noir/ACVM) | 18ms | 2% | Compute |
| Generate UltraHonk proof (bb.js) | 430ms | 57% | Compute |
| **TOTAL** | **752ms** | 100% | |

- **Network:** 172ms (23%) — fetching tree + circuit
- **Compute:** 579ms (77%) — BB init + Poseidon2 + witness + ZK proof

---

## Chat API Call (26,694ms / 26.7s)

The bulk of the latency is the Venice AI inference call. Breakdown:
- ZK verification on backend: fast (~10ms, included in backend logs)
- Venice AI inference (backend → Venice): **~26,500ms** (dominates)
- Token creation + Redis write: negligible

---

## Key Observations

1. **ZK proof is fast.** 752ms total — most of it the UltraHonk proof generation (430ms) and Barretenberg WASM init (124ms).
2. **Barretenberg init is ~16% of proof time.** Cold start cost. Could be pre-warmed.
3. **Circuit artifact is small.** Only 53ms to fetch from backend.
4. **Venice AI is the bottleneck.** ~26.5s for a "Say hello" prompt — expected for a full model inference round-trip.
5. **First-message E2E latency is ~28s.** Most of it Venice inference, not ZK.
6. **Subsequent messages** in the same session use the bearer token — no ZK proof needed, just Venice inference (~26s for first message, similar for subsequent).
