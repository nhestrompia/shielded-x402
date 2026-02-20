// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IShieldedPool} from "./interfaces/IShieldedPool.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

contract ShieldedPool is IShieldedPool {
    using SafeTransferLib for address;
    uint8 internal constant TREE_DEPTH = 24;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant CHALLENGE_DOMAIN_HASH =
        0xe32e24a51c351093d339c0035177dc2da5c1b8b9563e414393edd75506dcc055;

    struct SpendRecord {
        uint256 amount;
        bytes32 challengeHash;
        bool withdrawn;
    }

    address public immutable asset;
    IProofVerifier public immutable verifier;
    address public owner;

    uint256 public leafCount;
    bytes32 public override latestRoot;
    bytes32[TREE_DEPTH] public filledSubtrees;
    bytes32[TREE_DEPTH] public zeros;

    mapping(bytes32 => bool) public override isNullifierUsed;
    mapping(bytes32 => bool) public override isKnownRoot;
    mapping(bytes32 => SpendRecord) public spendRecords;

    error NotOwner();
    error InvalidAmount();
    error InvalidCommitment();
    error InvalidProof();
    error InvalidProofSize();
    error AmountOutOfFieldRange();
    error FeeOnTransferUnsupported();
    error NullifierAlreadyUsed();
    error UnknownRoot();
    error MerkleTreeFull();
    error UnknownNullifier();
    error WithdrawAlreadyProcessed();
    error InvalidWithdrawChallenge();
    error InvalidRecipient();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address asset_, address verifier_) {
        require(asset_ != address(0) && verifier_ != address(0), "zero address");
        asset = asset_;
        verifier = IProofVerifier(verifier_);
        owner = msg.sender;

        bytes32 currentZero = bytes32(0);
        for (uint8 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = keccak256(abi.encodePacked(currentZero, currentZero));
        }
        latestRoot = currentZero;
        isKnownRoot[currentZero] = true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    function deposit(uint256 amount, bytes32 commitment) external {
        if (amount == 0) revert InvalidAmount();
        if (commitment == bytes32(0)) revert InvalidCommitment();
        uint256 balanceBefore = _balanceOf(asset, address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = _balanceOf(asset, address(this));
        if (balanceAfter - balanceBefore != amount) revert FeeOnTransferUnsupported();

        (uint256 index, bytes32 root) = _insertCommitment(commitment);
        emit Deposited(commitment, index, root, amount);
    }

    function submitSpend(
        bytes calldata proof,
        bytes32 nullifier,
        bytes32 root,
        bytes32 merchantCommitment,
        bytes32 changeCommitment,
        bytes32 challengeHash,
        uint256 amount
    ) external {
        if (amount == 0) revert InvalidAmount();
        if (amount >= SNARK_SCALAR_FIELD) revert AmountOutOfFieldRange();
        if (merchantCommitment == bytes32(0) || changeCommitment == bytes32(0)) revert InvalidCommitment();
        if (proof.length == 0 || proof.length > 131072) revert InvalidProofSize();
        if (isNullifierUsed[nullifier]) revert NullifierAlreadyUsed();
        if (!isKnownRoot[root]) revert UnknownRoot();

        bytes32[] memory publicInputs = new bytes32[](6);
        publicInputs[0] = nullifier;
        publicInputs[1] = root;
        publicInputs[2] = merchantCommitment;
        publicInputs[3] = changeCommitment;
        publicInputs[4] = challengeHash;
        publicInputs[5] = bytes32(amount);

        if (!verifier.verify(proof, publicInputs)) revert InvalidProof();

        isNullifierUsed[nullifier] = true;
        spendRecords[nullifier] = SpendRecord({amount: amount, challengeHash: challengeHash, withdrawn: false});
        (uint256 merchantLeafIndex,) = _insertCommitment(merchantCommitment);
        (uint256 changeLeafIndex, bytes32 newRoot) = _insertCommitment(changeCommitment);

        emit Spent(
            nullifier,
            merchantCommitment,
            changeCommitment,
            amount,
            challengeHash,
            merchantLeafIndex,
            changeLeafIndex,
            newRoot
        );
    }

    function withdraw(bytes32 nullifier, bytes32 challengeNonce, address recipient) external {
        if (recipient == address(0)) revert InvalidRecipient();
        SpendRecord storage record = spendRecords[nullifier];
        if (record.amount == 0) revert UnknownNullifier();
        if (record.withdrawn) revert WithdrawAlreadyProcessed();

        bytes32 expectedChallengeHash = _deriveChallengeHash(challengeNonce, record.amount, recipient);
        if (expectedChallengeHash != record.challengeHash) revert InvalidWithdrawChallenge();

        record.withdrawn = true;
        asset.safeTransfer(recipient, record.amount);

        emit Withdrawn(nullifier, recipient, record.amount, challengeNonce);
    }

    function _deriveChallengeHash(bytes32 challengeNonce, uint256 amount, address recipient)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(CHALLENGE_DOMAIN_HASH, challengeNonce, bytes32(amount), bytes32(uint256(uint160(recipient))))
        );
    }

    function _balanceOf(address token, address account) internal view returns (uint256 result) {
        assembly {
            mstore(0x00, 0x70a08231)
            mstore(0x20, account)
            if iszero(staticcall(gas(), token, 0x1c, 0x24, 0x00, 0x20)) { revert(0, 0) }
            result := mload(0x00)
        }
    }

    function _insertCommitment(bytes32 commitment) internal returns (uint256 index, bytes32 root) {
        index = leafCount;
        if (index >= (uint256(1) << TREE_DEPTH)) revert MerkleTreeFull();

        bytes32 currentHash = commitment;
        uint256 currentIndex = index;

        for (uint8 i = 0; i < TREE_DEPTH; i++) {
            if ((currentIndex & 1) == 0) {
                filledSubtrees[i] = currentHash;
                currentHash = keccak256(abi.encodePacked(currentHash, zeros[i]));
            } else {
                currentHash = keccak256(abi.encodePacked(filledSubtrees[i], currentHash));
            }
            currentIndex = currentIndex >> 1;
        }

        root = currentHash;
        leafCount = index + 1;
        latestRoot = root;
        isKnownRoot[root] = true;
    }
}
