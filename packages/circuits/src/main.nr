use std::hash::poseidon2::Poseidon2;
use binary_merkle_root::binary_merkle_root;

fn main(
    // public inputs (visible to verifier)
    nullifier_hash: pub Field,
    root: pub Field,
    depth: pub u32,
    current_counter: pub Field,

    // private inputs (never leave client)
    nullifier: Field,
    secret: Field,
    indices: [u1; 16],
    siblings: [Field; 16],
) {
    // 1. Verify commitment = poseidon2(nullifier, secret)
    let commitment = Poseidon2::hash([nullifier, secret], 2);

    // 2. Verify commitment is in the Merkle tree
    let computed_root = binary_merkle_root(
        |pair: [Field; 2]| -> Field { Poseidon2::hash(pair, 2) },
        commitment,
        depth,
        indices,
        siblings,
    );
    assert(computed_root == root);

    // 3. Verify nullifier_hash = poseidon2(nullifier, current_counter)
    let computed_nullifier_hash = Poseidon2::hash([nullifier, current_counter], 2);
    assert(computed_nullifier_hash == nullifier_hash);
}
