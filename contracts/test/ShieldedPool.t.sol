// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockProofVerifier} from "../src/verifiers/MockProofVerifier.sol";

contract ShieldedPoolTest {
    ShieldedPool internal pool;
    MockUSDC internal usdc;
    MockProofVerifier internal verifier;

    function setUp() public {
        usdc = new MockUSDC();
        verifier = new MockProofVerifier();
        pool = new ShieldedPool(address(usdc), address(verifier));

        usdc.mint(address(this), 1_000_000_000);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testDepositUpdatesRootAndLeafCount() public {
        setUp();
        bytes32 c1 = keccak256("commitment-1");
        bytes32 initialRoot = pool.latestRoot();

        pool.deposit(100_000_000, c1);

        require(pool.leafCount() == 1, "leafCount not incremented");
        bytes32 newRoot = pool.latestRoot();
        require(newRoot != initialRoot, "root did not update");
        require(pool.isKnownRoot(newRoot), "root not recorded");
    }

    function testSubmitSpendMarksNullifierAndInsertsOutputs() public {
        setUp();

        bytes32 c1 = keccak256("deposit");
        pool.deposit(100_000_000, c1);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf1");
        bytes32 merchantCommitment = keccak256("merchant");
        bytes32 changeCommitment = keccak256("change");
        bytes32 challengeHash = keccak256("challenge");

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, 50_000_000);

        require(pool.isNullifierUsed(nullifier), "nullifier not used");
        require(pool.leafCount() == 3, "output commitments not inserted");
    }

    function testSubmitSpendRevertsOnReusedNullifier() public {
        setUp();

        bytes32 c1 = keccak256("deposit");
        pool.deposit(100_000_000, c1);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf1");
        bytes32 merchantCommitment = keccak256("merchant");
        bytes32 changeCommitment = keccak256("change");
        bytes32 challengeHash = keccak256("challenge");

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, 50_000_000);

        bool reverted;
        try
            pool.submitSpend(
                hex"1234",
                nullifier,
                root,
                keccak256("merchant-2"),
                keccak256("change-2"),
                challengeHash,
                50_000_000
            )
        {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected nullifier reuse revert");
    }

    function testSubmitSpendRevertsForUnknownRoot() public {
        setUp();

        bytes32 nullifier = keccak256("nf1");
        bool reverted;

        try
            pool.submitSpend(
                hex"1234",
                nullifier,
                keccak256("unknown-root"),
                keccak256("merchant"),
                keccak256("change"),
                keccak256("challenge"),
                50_000_000
            )
        {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "expected unknown root revert");
    }

    function testSubmitSpendRevertsWhenVerifierFails() public {
        setUp();

        bytes32 c1 = keccak256("deposit");
        pool.deposit(100_000_000, c1);

        verifier.setShouldVerify(false);

        bool reverted;
        try
            pool.submitSpend(
                hex"1234",
                keccak256("nf1"),
                pool.latestRoot(),
                keccak256("merchant"),
                keccak256("change"),
                keccak256("challenge"),
                50_000_000
            )
        {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "expected invalid proof revert");
    }

    function testDepositRevertsWithZeroCommitment() public {
        setUp();
        bool reverted;
        try pool.deposit(1_000_000, bytes32(0)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected invalid commitment revert");
    }

    function testSubmitSpendRevertsOnOversizedProof() public {
        setUp();
        bytes32 c1 = keccak256("deposit");
        pool.deposit(100_000_000, c1);

        bytes memory largeProof = new bytes(131073);
        bool reverted;
        try
            pool.submitSpend(
                largeProof,
                keccak256("nf1"),
                pool.latestRoot(),
                keccak256("merchant"),
                keccak256("change"),
                keccak256("challenge"),
                50_000_000
            )
        {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected invalid proof size revert");
    }
}
