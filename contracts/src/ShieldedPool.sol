// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IShieldedPool} from "./interfaces/IShieldedPool.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

contract ShieldedPool is IShieldedPool {
    using SafeTransferLib for address;
    uint8 internal constant TREE_DEPTH = 24;

    struct MerchantAuth {
        address merchant;
        address recipient;
        uint256 amount;
        bytes32 claimId;
        uint64 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
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
    mapping(address => bool) public isMerchantAllowed;
    mapping(bytes32 => bool) public usedWithdrawClaim;

    error NotOwner();
    error InvalidAmount();
    error InvalidCommitment();
    error InvalidProof();
    error InvalidProofSize();
    error NullifierAlreadyUsed();
    error UnknownRoot();
    error MerchantNotAllowed();
    error ClaimAlreadyUsed();
    error AuthExpired();
    error InvalidSignature();
    error MerkleTreeFull();

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

    function setMerchant(address merchant, bool allowed) external onlyOwner {
        isMerchantAllowed[merchant] = allowed;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    function deposit(uint256 amount, bytes32 commitment) external {
        if (amount == 0) revert InvalidAmount();
        if (commitment == bytes32(0)) revert InvalidCommitment();
        asset.safeTransferFrom(msg.sender, address(this), amount);

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

    function withdraw(bytes calldata encryptedNote, bytes calldata merchantAuth) external {
        MerchantAuth memory auth = abi.decode(merchantAuth, (MerchantAuth));

        if (!isMerchantAllowed[auth.merchant]) revert MerchantNotAllowed();
        if (usedWithdrawClaim[auth.claimId]) revert ClaimAlreadyUsed();
        if (block.timestamp > auth.deadline) revert AuthExpired();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "shielded-x402:v1:withdraw",
                address(this),
                encryptedNote,
                auth.recipient,
                auth.amount,
                auth.claimId,
                auth.deadline
            )
        );
        bytes32 signedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address signer = ecrecover(signedDigest, auth.v, auth.r, auth.s);
        if (signer != auth.merchant) revert InvalidSignature();

        usedWithdrawClaim[auth.claimId] = true;
        asset.safeTransfer(auth.recipient, auth.amount);

        emit Withdrawn(auth.merchant, auth.recipient, auth.amount, auth.claimId);
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
