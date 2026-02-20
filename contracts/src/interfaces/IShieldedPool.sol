// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IShieldedPool {
    event Deposited(bytes32 indexed commitment, uint256 indexed leafIndex, bytes32 indexed root, uint256 amount);
    event Spent(
        bytes32 indexed nullifier,
        bytes32 indexed merchantCommitment,
        bytes32 indexed changeCommitment,
        uint256 amount,
        bytes32 challengeHash,
        uint256 merchantLeafIndex,
        uint256 changeLeafIndex,
        bytes32 newRoot
    );
    event Withdrawn(bytes32 indexed nullifier, address indexed recipient, uint256 amount, bytes32 challengeNonce);

    function deposit(uint256 amount, bytes32 commitment) external;

    function submitSpend(
        bytes calldata proof,
        bytes32 nullifier,
        bytes32 root,
        bytes32 merchantCommitment,
        bytes32 changeCommitment,
        bytes32 challengeHash,
        uint256 amount
    ) external;

    function withdraw(bytes32 nullifier, bytes32 challengeNonce, address recipient) external;

    function isNullifierUsed(bytes32 nullifier) external view returns (bool);
    function isKnownRoot(bytes32 root) external view returns (bool);
    function latestRoot() external view returns (bytes32);
}
