// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

interface INoirUltraVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @notice Adapter around Noir-generated verifier contracts so pool logic stays stable across circuit upgrades.
contract NoirVerifierAdapter is IProofVerifier {
    uint256 private constant HASH_PUBLIC_INPUT_BYTES = 32;
    uint256 private constant HASH_PUBLIC_INPUT_COUNT = 5;
    uint256 private constant COMPACT_PUBLIC_INPUT_COUNT = 6;
    uint256 private constant EXPANDED_PUBLIC_INPUT_COUNT = (HASH_PUBLIC_INPUT_BYTES * HASH_PUBLIC_INPUT_COUNT) + 1;

    INoirUltraVerifier public immutable verifier;

    constructor(address verifier_) {
        require(verifier_ != address(0), "zero verifier");
        verifier = INoirUltraVerifier(verifier_);
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        if (publicInputs.length != COMPACT_PUBLIC_INPUT_COUNT) return false;
        bytes32[] memory expanded = new bytes32[](EXPANDED_PUBLIC_INPUT_COUNT);

        uint256 out;
        for (uint256 i = 0; i < HASH_PUBLIC_INPUT_COUNT; i++) {
            bytes32 word = publicInputs[i];
            for (uint256 j = 0; j < HASH_PUBLIC_INPUT_BYTES; j++) {
                expanded[out++] = bytes32(uint256(uint8(word[j])));
            }
        }
        expanded[out] = publicInputs[5];

        return verifier.verify(proof, expanded);
    }
}
