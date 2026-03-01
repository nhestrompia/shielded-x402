use dep::poseidon::poseidon::bn254::hash_2 as poseidon_hash;

global TREE_DEPTH: u32 = 254;
global EMPTY_LEAF: Field = 0;

fn poseidon_hash_2(left: Field, right: Field) -> Field {
    poseidon_hash([left, right])
}

fn bytes16_to_field(bytes: [u8; 32], start: u32) -> Field {
    let mut result: Field = 0;
    let mut multiplier: Field = 1;
    for i in 0..16 {
        result = result + (bytes[start + i] as Field) * multiplier;
        multiplier = multiplier * 256;
    }
    result
}

pub fn pubkey_to_index(pubkey: [u8; 32]) -> Field {
    let low = bytes16_to_field(pubkey, 0);
    let high = bytes16_to_field(pubkey, 16);
    poseidon_hash_2(low, high)
}

fn compute_merkle_root<let N: u32>(leaf: Field, path_bits: [u1; N], siblings: [Field; N]) -> Field {
    let mut current = leaf;
    for i in 0..N {
        let sibling = siblings[i];
        let bit = path_bits[i];
        let (left, right) = if bit == 0 {
            (current, sibling)
        } else {
            (sibling, current)
        };
        current = poseidon_hash_2(left, right);
    }
    current
}

fn main(
    smt_root: pub Field,
    pubkey_hash: pub Field,
    pubkey: [u8; 32],
    siblings: [Field; TREE_DEPTH],
    leaf_value: Field,
) {
    let computed_hash = pubkey_to_index(pubkey);
    assert(computed_hash == pubkey_hash, "Pubkey hash mismatch");

    let path_bits: [u1; TREE_DEPTH] = computed_hash.to_le_bits();
    assert(leaf_value == EMPTY_LEAF, "Exclusion failed: leaf is not empty");

    let computed_root = compute_merkle_root(leaf_value, path_bits, siblings);
    assert(computed_root == smt_root, "Root mismatch: invalid merkle proof");
}
