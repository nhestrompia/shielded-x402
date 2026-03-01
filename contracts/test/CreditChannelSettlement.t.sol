// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CreditChannelSettlement} from "../src/CreditChannelSettlement.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

address constant HEVM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract CreditChannelSettlementTest {
    Vm internal constant vm = Vm(HEVM_ADDRESS);

    MockUSDC internal usdc;
    CreditChannelSettlement internal settlement;

    uint256 internal constant RELAYER_KEY = 0xBEE5;
    uint256 internal constant AGENT_KEY = 0xA931;
    address internal relayer;
    address internal agent;

    bytes32 internal constant CHANNEL_ID =
        0x9c6f6f7d72f060f06f6813fe0959136f4e5f451f7fb9f95d0b1fb89bad2b2a3b;
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        usdc = new MockUSDC();
        settlement = new CreditChannelSettlement(address(usdc), 60);

        relayer = vm.addr(RELAYER_KEY);
        agent = vm.addr(AGENT_KEY);

        usdc.mint(relayer, 1_000_000_000);
        vm.prank(relayer);
        usdc.approve(address(settlement), type(uint256).max);
    }

    function testOpenStartChallengeFinalize() public {
        setUp();

        vm.prank(relayer);
        settlement.openOrTopup(CHANNEL_ID, agent, 200_000_000);
        require(usdc.balanceOf(address(settlement)) == 200_000_000, "escrow not funded");

        CreditChannelSettlement.CreditState memory s1 = CreditChannelSettlement.CreditState({
            channelId: CHANNEL_ID,
            seq: 3,
            available: 150_000_000,
            cumulativeSpent: 50_000_000,
            lastDebitDigest: keccak256("d3"),
            updatedAt: uint64(block.timestamp),
            agentAddress: agent,
            relayerAddress: relayer
        });

        CreditChannelSettlement.SignedCreditState memory signed1 = _signState(s1);
        vm.prank(relayer);
        settlement.startClose(signed1);

        CreditChannelSettlement.CreditState memory s2 = CreditChannelSettlement.CreditState({
            channelId: CHANNEL_ID,
            seq: 4,
            available: 120_000_000,
            cumulativeSpent: 80_000_000,
            lastDebitDigest: keccak256("d4"),
            updatedAt: uint64(block.timestamp + 1),
            agentAddress: agent,
            relayerAddress: relayer
        });
        CreditChannelSettlement.SignedCreditState memory signed2 = _signState(s2);
        vm.prank(relayer);
        settlement.challengeClose(signed2);

        uint256 relayerBefore = usdc.balanceOf(relayer);
        uint256 agentBefore = usdc.balanceOf(agent);
        vm.warp(block.timestamp + 61);
        settlement.finalizeClose(CHANNEL_ID);

        uint256 relayerAfter = usdc.balanceOf(relayer);
        uint256 agentAfter = usdc.balanceOf(agent);
        require(agentAfter == agentBefore + 120_000_000, "agent payout mismatch");
        require(relayerAfter == relayerBefore + 80_000_000, "relayer payout mismatch");
    }

    function testChallengeRequiresHigherSeq() public {
        setUp();

        vm.prank(relayer);
        settlement.openOrTopup(CHANNEL_ID, agent, 100_000_000);

        CreditChannelSettlement.CreditState memory s1 = CreditChannelSettlement.CreditState({
            channelId: CHANNEL_ID,
            seq: 5,
            available: 70_000_000,
            cumulativeSpent: 30_000_000,
            lastDebitDigest: keccak256("d5"),
            updatedAt: uint64(block.timestamp),
            agentAddress: agent,
            relayerAddress: relayer
        });
        CreditChannelSettlement.SignedCreditState memory signedS1 = _signState(s1);
        vm.prank(relayer);
        settlement.startClose(signedS1);

        CreditChannelSettlement.CreditState memory stale = CreditChannelSettlement.CreditState({
            channelId: CHANNEL_ID,
            seq: 5,
            available: 69_000_000,
            cumulativeSpent: 31_000_000,
            lastDebitDigest: keccak256("stale"),
            updatedAt: uint64(block.timestamp + 1),
            agentAddress: agent,
            relayerAddress: relayer
        });
        CreditChannelSettlement.SignedCreditState memory signedStale = _signState(stale);

        bool reverted;
        vm.prank(relayer);
        try settlement.challengeClose(signedStale) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected stale challenge revert");
    }

    function testCloseRequiresChannelPartyCaller() public {
        setUp();

        vm.prank(relayer);
        settlement.openOrTopup(CHANNEL_ID, agent, 100_000_000);

        CreditChannelSettlement.CreditState memory state = CreditChannelSettlement.CreditState({
            channelId: CHANNEL_ID,
            seq: 1,
            available: 90_000_000,
            cumulativeSpent: 10_000_000,
            lastDebitDigest: keccak256("d1"),
            updatedAt: uint64(block.timestamp),
            agentAddress: agent,
            relayerAddress: relayer
        });

        bool reverted;
        try settlement.startClose(_signState(state)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected unauthorized close start revert");
    }

    function testRejectsHighSMalleableSignature() public {
        setUp();

        vm.prank(relayer);
        settlement.openOrTopup(CHANNEL_ID, agent, 100_000_000);

        CreditChannelSettlement.CreditState memory state = CreditChannelSettlement.CreditState({
            channelId: CHANNEL_ID,
            seq: 1,
            available: 90_000_000,
            cumulativeSpent: 10_000_000,
            lastDebitDigest: keccak256("d1"),
            updatedAt: uint64(block.timestamp),
            agentAddress: agent,
            relayerAddress: relayer
        });

        CreditChannelSettlement.SignedCreditState memory signedState = _signState(state);
        signedState.agentSignature = _toHighS(signedState.agentSignature);

        bool reverted;
        vm.prank(relayer);
        try settlement.startClose(signedState) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected high-s signature rejection");
    }

    function _signState(CreditChannelSettlement.CreditState memory state)
        internal
        returns (CreditChannelSettlement.SignedCreditState memory signed)
    {
        bytes32 digest = settlement.hashCreditState(state);
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(AGENT_KEY, digest);
        (uint8 rv, bytes32 rr, bytes32 rs) = vm.sign(RELAYER_KEY, digest);
        signed = CreditChannelSettlement.SignedCreditState({
            state: state,
            agentSignature: _toSignature(av, ar, as_),
            relayerSignature: _toSignature(rv, rr, rs)
        });
    }

    function _toSignature(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory out) {
        out = new bytes(65);
        assembly {
            mstore(add(out, 32), r)
            mstore(add(out, 64), s)
            mstore8(add(out, 96), v)
        }
    }

    function _toHighS(bytes memory signature) internal pure returns (bytes memory out) {
        require(signature.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        uint256 highS = SECP256K1_N - uint256(s);
        uint8 toggledV = (v == 27) ? 28 : 27;
        out = _toSignature(toggledV, r, bytes32(highS));
    }
}
