// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

contract CreditChannelSettlement {
    using SafeTransferLib for address;

    struct CreditState {
        bytes32 channelId;
        uint64 seq;
        uint256 available;
        uint256 cumulativeSpent;
        bytes32 lastDebitDigest;
        uint64 updatedAt;
        address agentAddress;
        address relayerAddress;
    }

    struct SignedCreditState {
        CreditState state;
        bytes agentSignature;
        bytes relayerSignature;
    }

    struct Channel {
        bool exists;
        bool closing;
        address agent;
        address relayer;
        uint256 escrowed;
        uint64 closeSeq;
        uint64 challengeDeadline;
        uint256 closeAvailable;
        uint256 closeCumulativeSpent;
        bytes32 closeLastDebitDigest;
        uint64 closeUpdatedAt;
    }

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CREDIT_STATE_TYPEHASH = keccak256(
        "CreditState(bytes32 channelId,uint64 seq,uint256 available,uint256 cumulativeSpent,bytes32 lastDebitDigest,uint64 updatedAt,address agentAddress,address relayerAddress)"
    );
    bytes32 internal constant NAME_HASH = keccak256("shielded-x402-credit");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    address public immutable asset;
    uint64 public immutable challengePeriod;
    bytes32 public immutable domainSeparator;

    mapping(bytes32 => Channel) public channels;

    error InvalidAddress();
    error InvalidAmount();
    error ChannelMissing();
    error ChannelAlreadyClosing();
    error ChannelNotClosing();
    error ChannelPartyMismatch();
    error InvalidSignature();
    error InvalidStateTotals();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error ChallengeSeqTooLow();
    error UnauthorizedChannelParty();

    event ChannelOpened(bytes32 indexed channelId, address indexed agent, address indexed relayer, uint256 amount);
    event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 escrowedTotal);
    event CloseStarted(bytes32 indexed channelId, uint64 seq, uint64 challengeDeadline, uint256 available);
    event CloseChallenged(bytes32 indexed channelId, uint64 seq, uint64 challengeDeadline, uint256 available);
    event CloseFinalized(bytes32 indexed channelId, uint64 seq, uint256 paidToAgent, uint256 paidToRelayer);

    constructor(address asset_, uint64 challengePeriodSeconds_) {
        if (asset_ == address(0)) revert InvalidAddress();
        if (challengePeriodSeconds_ == 0) revert InvalidAmount();
        asset = asset_;
        challengePeriod = challengePeriodSeconds_;
        domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    function openOrTopup(bytes32 channelId, address agent, uint256 amount) external {
        if (channelId == bytes32(0) || agent == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        Channel storage channel = channels[channelId];
        if (!channel.exists) {
            channel.exists = true;
            channel.agent = agent;
            channel.relayer = msg.sender;
            emit ChannelOpened(channelId, agent, msg.sender, amount);
        } else {
            if (channel.agent != agent || channel.relayer != msg.sender) revert ChannelPartyMismatch();
            if (channel.closing) revert ChannelAlreadyClosing();
        }

        asset.safeTransferFrom(msg.sender, address(this), amount);
        channel.escrowed += amount;
        emit ChannelToppedUp(channelId, amount, channel.escrowed);
    }

    function startClose(SignedCreditState calldata signedState) external {
        Channel storage channel = channels[signedState.state.channelId];
        if (!channel.exists) revert ChannelMissing();
        if (msg.sender != channel.agent && msg.sender != channel.relayer) revert UnauthorizedChannelParty();
        if (channel.closing) revert ChannelAlreadyClosing();
        _assertChannelMatches(channel, signedState.state);
        _assertStateTotalWithinEscrow(channel, signedState.state);
        _verifySignedState(signedState);

        channel.closing = true;
        channel.closeSeq = signedState.state.seq;
        channel.closeAvailable = signedState.state.available;
        channel.closeCumulativeSpent = signedState.state.cumulativeSpent;
        channel.closeLastDebitDigest = signedState.state.lastDebitDigest;
        channel.closeUpdatedAt = signedState.state.updatedAt;
        channel.challengeDeadline = uint64(block.timestamp) + challengePeriod;

        emit CloseStarted(signedState.state.channelId, channel.closeSeq, channel.challengeDeadline, channel.closeAvailable);
    }

    function challengeClose(SignedCreditState calldata signedState) external {
        Channel storage channel = channels[signedState.state.channelId];
        if (!channel.exists) revert ChannelMissing();
        if (msg.sender != channel.agent && msg.sender != channel.relayer) revert UnauthorizedChannelParty();
        if (!channel.closing) revert ChannelNotClosing();
        if (block.timestamp >= channel.challengeDeadline) revert ChallengeWindowClosed();
        _assertChannelMatches(channel, signedState.state);
        _assertStateTotalWithinEscrow(channel, signedState.state);
        _verifySignedState(signedState);

        if (signedState.state.seq <= channel.closeSeq) revert ChallengeSeqTooLow();

        channel.closeSeq = signedState.state.seq;
        channel.closeAvailable = signedState.state.available;
        channel.closeCumulativeSpent = signedState.state.cumulativeSpent;
        channel.closeLastDebitDigest = signedState.state.lastDebitDigest;
        channel.closeUpdatedAt = signedState.state.updatedAt;
        channel.challengeDeadline = uint64(block.timestamp) + challengePeriod;

        emit CloseChallenged(
            signedState.state.channelId, channel.closeSeq, channel.challengeDeadline, channel.closeAvailable
        );
    }

    function finalizeClose(bytes32 channelId) external {
        Channel storage channel = channels[channelId];
        if (!channel.exists) revert ChannelMissing();
        if (!channel.closing) revert ChannelNotClosing();
        if (block.timestamp < channel.challengeDeadline) revert ChallengeWindowOpen();

        uint256 paidToAgent = channel.closeAvailable;
        if (paidToAgent > channel.escrowed) revert InvalidStateTotals();
        uint256 paidToRelayer = channel.escrowed - paidToAgent;
        uint64 finalizedSeq = channel.closeSeq;
        address agent = channel.agent;
        address relayer = channel.relayer;

        delete channels[channelId];

        if (paidToAgent > 0) {
            asset.safeTransfer(agent, paidToAgent);
        }
        if (paidToRelayer > 0) {
            asset.safeTransfer(relayer, paidToRelayer);
        }

        emit CloseFinalized(channelId, finalizedSeq, paidToAgent, paidToRelayer);
    }

    function hashCreditState(CreditState calldata state) external view returns (bytes32) {
        return _hashCreditState(state);
    }

    function _hashCreditState(CreditState calldata state) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CREDIT_STATE_TYPEHASH,
                state.channelId,
                state.seq,
                state.available,
                state.cumulativeSpent,
                state.lastDebitDigest,
                state.updatedAt,
                state.agentAddress,
                state.relayerAddress
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _verifySignedState(SignedCreditState calldata signedState) internal view {
        bytes32 digest = _hashCreditState(signedState.state);
        address agentSigner = _recoverSigner(digest, signedState.agentSignature);
        address relayerSigner = _recoverSigner(digest, signedState.relayerSignature);

        if (agentSigner != signedState.state.agentAddress) revert InvalidSignature();
        if (relayerSigner != signedState.state.relayerAddress) revert InvalidSignature();
    }

    function _assertChannelMatches(Channel storage channel, CreditState calldata state) internal view {
        if (state.agentAddress != channel.agent || state.relayerAddress != channel.relayer) {
            revert ChannelPartyMismatch();
        }
    }

    function _assertStateTotalWithinEscrow(Channel storage channel, CreditState calldata state) internal view {
        if (state.available + state.cumulativeSpent > channel.escrowed) {
            revert InvalidStateTotals();
        }
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
