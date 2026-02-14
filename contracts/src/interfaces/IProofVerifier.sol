// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IProofVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
