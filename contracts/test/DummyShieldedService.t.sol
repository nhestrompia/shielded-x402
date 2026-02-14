// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockProofVerifier} from "../src/verifiers/MockProofVerifier.sol";
import {DummyShieldedService} from "../src/mocks/DummyShieldedService.sol";

contract RelayerCaller {
    function settle(
        DummyShieldedService service,
        bytes32 nullifier,
        address beneficiary,
        uint256 amount,
        bytes32 challengeHash
    ) external {
        service.settlePayment(nullifier, beneficiary, amount, challengeHash);
    }
}

contract DummyShieldedServiceTest {
    ShieldedPool internal pool;
    MockUSDC internal usdc;
    MockProofVerifier internal verifier;
    DummyShieldedService internal service;

    function setUp() public {
        usdc = new MockUSDC();
        verifier = new MockProofVerifier();
        pool = new ShieldedPool(address(usdc), address(verifier));
        service = new DummyShieldedService(address(pool));

        usdc.mint(address(this), 1_000_000_000);
        usdc.approve(address(pool), type(uint256).max);
    }

    function testSettlePaymentAfterPoolSpend() public {
        setUp();

        pool.deposit(100_000_000, keccak256("deposit"));

        bytes32 nullifier = keccak256("nf1");
        pool.submitSpend(
            hex"1234",
            nullifier,
            pool.latestRoot(),
            keccak256("merchant"),
            keccak256("change"),
            keccak256("challenge"),
            50_000_000
        );

        address beneficiary = address(this);
        service.settlePayment(nullifier, beneficiary, 50_000_000, keccak256("challenge"));
        require(service.credits(beneficiary) == 50_000_000, "credit not recorded");
    }

    function testSettlePaymentRevertsIfNullifierNotUsedOnPool() public {
        setUp();
        bool reverted;
        try service.settlePayment(keccak256("missing"), address(this), 1_000_000, keccak256("c")) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected nullifier-not-settled revert");
    }

    function testSettlePaymentRejectsDuplicateNullifier() public {
        setUp();

        pool.deposit(100_000_000, keccak256("deposit"));
        bytes32 nullifier = keccak256("nf1");
        pool.submitSpend(
            hex"1234",
            nullifier,
            pool.latestRoot(),
            keccak256("merchant"),
            keccak256("change"),
            keccak256("challenge"),
            50_000_000
        );

        service.settlePayment(nullifier, address(this), 50_000_000, keccak256("challenge"));

        bool reverted;
        try service.settlePayment(nullifier, address(this), 50_000_000, keccak256("challenge")) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected duplicate nullifier revert");
    }

    function testRelayerRestriction() public {
        setUp();

        pool.deposit(100_000_000, keccak256("deposit"));
        bytes32 nullifier = keccak256("nf1");
        pool.submitSpend(
            hex"1234",
            nullifier,
            pool.latestRoot(),
            keccak256("merchant"),
            keccak256("change"),
            keccak256("challenge"),
            50_000_000
        );

        RelayerCaller caller = new RelayerCaller();
        service.setRelayer(address(caller));

        bool reverted;
        try service.settlePayment(nullifier, address(this), 50_000_000, keccak256("challenge")) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected relayer-only revert");

        caller.settle(service, nullifier, address(this), 50_000_000, keccak256("challenge"));
        require(service.credits(address(this)) == 50_000_000, "relayer settle failed");
    }

    function testConsumeCredit() public {
        setUp();

        pool.deposit(100_000_000, keccak256("deposit"));
        bytes32 nullifier = keccak256("nf1");
        pool.submitSpend(
            hex"1234",
            nullifier,
            pool.latestRoot(),
            keccak256("merchant"),
            keccak256("change"),
            keccak256("challenge"),
            50_000_000
        );

        service.settlePayment(nullifier, address(this), 50_000_000, keccak256("challenge"));
        service.consumeCredit(20_000_000);
        require(service.credits(address(this)) == 30_000_000, "credit not consumed");
    }
}
