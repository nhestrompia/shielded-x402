use dep::keccak256::keccak256;

fn field_to_bytes32(x: Field) -> [u8; 32] {
    x.to_be_bytes()
}

fn concat2(a: [u8; 32], b: [u8; 32]) -> [u8; 64] {
    let mut preimage: [u8; 64] = [0; 64];
    for i in 0..32 {
        preimage[i] = a[i];
        preimage[32 + i] = b[i];
    }
    preimage
}

fn concat3(a: [u8; 32], b: [u8; 32], c: [u8; 32]) -> [u8; 96] {
    let mut preimage: [u8; 96] = [0; 96];
    for i in 0..32 {
        preimage[i] = a[i];
        preimage[32 + i] = b[i];
        preimage[64 + i] = c[i];
    }
    preimage
}

fn concat4(a: [u8; 32], b: [u8; 32], c: [u8; 32], d: [u8; 32]) -> [u8; 128] {
    let mut preimage: [u8; 128] = [0; 128];
    for i in 0..32 {
        preimage[i] = a[i];
        preimage[32 + i] = b[i];
        preimage[64 + i] = c[i];
        preimage[96 + i] = d[i];
    }
    preimage
}

fn keccak2(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let preimage = concat2(a, b);
    keccak256(preimage, 64)
}

fn keccak3(a: [u8; 32], b: [u8; 32], c: [u8; 32]) -> [u8; 32] {
    let preimage = concat3(a, b, c);
    keccak256(preimage, 96)
}

fn keccak4(a: [u8; 32], b: [u8; 32], c: [u8; 32], d: [u8; 32]) -> [u8; 32] {
    let preimage = concat4(a, b, c, d);
    keccak256(preimage, 128)
}

fn merkle_root_from_path(
    leaf: [u8; 32],
    path: [[u8; 32]; 32],
    index_bits: [u8; 32]
) -> [u8; 32] {
    let mut cur = leaf;
    for i in 0..32 {
        assert((index_bits[i] == 0) | (index_bits[i] == 1));
        if index_bits[i] == 0 {
            cur = keccak2(cur, path[i]);
        } else {
            cur = keccak2(path[i], cur);
        }
    }
    cur
}

fn main(
    note_amount: u128,
    note_rho: Field,
    note_pk_hash: Field,
    nullifier_secret: Field,
    merkle_path: [[u8; 32]; 32],
    index_bits: [u8; 32],
    merchant_pk_hash: Field,
    merchant_rho: Field,
    change_pk_hash: Field,
    change_rho: Field,
    pay_amount: u128,
    challenge_nonce: [u8; 32],
    merchant_address_word: [u8; 32]
) -> pub ([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 32], Field) {
    assert(pay_amount <= note_amount);

    let note_commitment = keccak3(
        field_to_bytes32(note_amount as Field),
        field_to_bytes32(note_rho),
        field_to_bytes32(note_pk_hash)
    );

    let computed_root = merkle_root_from_path(note_commitment, merkle_path, index_bits);

    let nullifier = keccak2(field_to_bytes32(nullifier_secret), note_commitment);

    let merchant_commitment = keccak3(
        field_to_bytes32(pay_amount as Field),
        field_to_bytes32(merchant_rho),
        field_to_bytes32(merchant_pk_hash)
    );

    let change_amount = note_amount - pay_amount;
    let change_commitment = keccak3(
        field_to_bytes32(change_amount as Field),
        field_to_bytes32(change_rho),
        field_to_bytes32(change_pk_hash)
    );

    let challenge_domain_hash: [u8; 32] = [
        227, 46, 36, 165, 28, 53, 16, 147, 211, 57, 192, 3, 81, 119, 220, 45,
        165, 193, 184, 185, 86, 62, 65, 67, 147, 237, 215, 85, 6, 220, 192, 85
    ];
    let challenge_hash = keccak4(
        challenge_domain_hash,
        challenge_nonce,
        field_to_bytes32(pay_amount as Field),
        merchant_address_word
    );

    (
        nullifier,
        computed_root,
        merchant_commitment,
        change_commitment,
        challenge_hash,
        pay_amount as Field
    )
}
