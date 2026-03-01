// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract CommitmentRegistryV1 {
    struct CommitmentMeta {
        uint32 count;
        bytes32 prevRoot;
        uint64 postedAt;
        bytes32 sequencerKeyId;
    }

    error Unauthorized();
    error InvalidEpoch();
    error InvalidPrevRoot();

    address public immutable sequencerOperator;
    uint64 public latestEpochId;

    mapping(uint64 => bytes32) public roots;
    mapping(uint64 => CommitmentMeta) public metadata;

    event CommitmentPosted(
        uint64 indexed epochId, bytes32 indexed root, uint32 count, bytes32 prevRoot, uint64 postedAt, bytes32 sequencerKeyId
    );

    constructor(address sequencerOperator_) {
        if (sequencerOperator_ == address(0)) revert Unauthorized();
        sequencerOperator = sequencerOperator_;
    }

    function postCommitment(uint64 epochId, bytes32 root, uint32 count, bytes32 prevRoot, bytes32 sequencerKeyId) external {
        if (msg.sender != sequencerOperator) revert Unauthorized();
        if (epochId != latestEpochId + 1) revert InvalidEpoch();

        bytes32 expectedPrevRoot = latestEpochId == 0 ? bytes32(0) : roots[latestEpochId];
        if (prevRoot != expectedPrevRoot) revert InvalidPrevRoot();

        latestEpochId = epochId;
        roots[epochId] = root;
        metadata[epochId] = CommitmentMeta({
            count: count,
            prevRoot: prevRoot,
            postedAt: uint64(block.timestamp),
            sequencerKeyId: sequencerKeyId
        });

        emit CommitmentPosted(epochId, root, count, prevRoot, uint64(block.timestamp), sequencerKeyId);
    }
}
