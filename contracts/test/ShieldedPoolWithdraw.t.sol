// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockProofVerifier} from "../src/verifiers/MockProofVerifier.sol";

contract ShieldedPoolWithdrawTest {
    bytes32 internal constant CHALLENGE_DOMAIN_HASH =
        0xe32e24a51c351093d339c0035177dc2da5c1b8b9563e414393edd75506dcc055;

    ShieldedPool internal pool;
    MockUSDC internal usdc;
    MockProofVerifier internal verifier;

    function setUp() public {
        usdc = new MockUSDC();
        verifier = new MockProofVerifier();
        pool = new ShieldedPool(address(usdc), address(verifier));

        usdc.mint(address(this), 2_000_000_000);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(1_000_000_000, keccak256("seed-liquidity"));
    }

    function testWithdrawFromRecordedSpend() public {
        setUp();

        bytes32 depositCommitment = keccak256("deposit-1");
        pool.deposit(100_000_000, depositCommitment);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf-withdraw-1");
        bytes32 merchantCommitment = keccak256("merchant-commitment-1");
        bytes32 changeCommitment = keccak256("change-commitment-1");
        uint256 amount = 50_000_000;
        address recipient = address(0xBEEF);
        bytes32 challengeNonce = keccak256("withdraw-nonce-1");
        bytes32 challengeHash = _deriveChallengeHash(challengeNonce, amount, recipient);

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, amount);

        uint256 beforeBalance = usdc.balanceOf(recipient);
        pool.withdraw(nullifier, challengeNonce, recipient);
        uint256 afterBalance = usdc.balanceOf(recipient);

        require(afterBalance == beforeBalance + amount, "recipient not paid");
    }

    function testWithdrawDoesNotRequireMerchantAllowlist() public {
        setUp();

        bytes32 depositCommitment = keccak256("deposit-no-allowlist");
        pool.deposit(100_000_000, depositCommitment);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf-withdraw-no-allowlist");
        bytes32 merchantCommitment = keccak256("merchant-commitment-no-allowlist");
        bytes32 changeCommitment = keccak256("change-commitment-no-allowlist");
        uint256 amount = 25_000_000;
        address recipient = address(0xABCD);
        bytes32 challengeNonce = keccak256("withdraw-nonce-no-allowlist");
        bytes32 challengeHash = _deriveChallengeHash(challengeNonce, amount, recipient);

        // No setMerchant() call exists or is required.
        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, amount);

        uint256 beforeBalance = usdc.balanceOf(recipient);
        pool.withdraw(nullifier, challengeNonce, recipient);
        uint256 afterBalance = usdc.balanceOf(recipient);

        require(afterBalance == beforeBalance + amount, "recipient not paid without allowlist");
    }

    function testWithdrawRejectsReplay() public {
        setUp();

        bytes32 depositCommitment = keccak256("deposit-2");
        pool.deposit(100_000_000, depositCommitment);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf-withdraw-2");
        bytes32 merchantCommitment = keccak256("merchant-commitment-2");
        bytes32 changeCommitment = keccak256("change-commitment-2");
        uint256 amount = 40_000_000;
        address recipient = address(0xCAFE);
        bytes32 challengeNonce = keccak256("withdraw-nonce-2");
        bytes32 challengeHash = _deriveChallengeHash(challengeNonce, amount, recipient);

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, amount);
        pool.withdraw(nullifier, challengeNonce, recipient);

        bool reverted;
        try pool.withdraw(nullifier, challengeNonce, recipient) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected replay revert");
    }

    function testWithdrawRejectsWrongRecipientBinding() public {
        setUp();

        bytes32 depositCommitment = keccak256("deposit-3");
        pool.deposit(100_000_000, depositCommitment);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf-withdraw-3");
        bytes32 merchantCommitment = keccak256("merchant-commitment-3");
        bytes32 changeCommitment = keccak256("change-commitment-3");
        uint256 amount = 30_000_000;
        address intendedRecipient = address(0x1234);
        address wrongRecipient = address(0x9999);
        bytes32 challengeNonce = keccak256("withdraw-nonce-3");
        bytes32 challengeHash = _deriveChallengeHash(challengeNonce, amount, intendedRecipient);

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, amount);

        bool reverted;
        try pool.withdraw(nullifier, challengeNonce, wrongRecipient) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected invalid challenge revert");
    }

    function testWithdrawRejectsWrongChallengeNonce() public {
        setUp();

        bytes32 depositCommitment = keccak256("deposit-4");
        pool.deposit(100_000_000, depositCommitment);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf-withdraw-4");
        bytes32 merchantCommitment = keccak256("merchant-commitment-4");
        bytes32 changeCommitment = keccak256("change-commitment-4");
        uint256 amount = 15_000_000;
        address recipient = address(0x4567);
        bytes32 challengeNonce = keccak256("withdraw-nonce-4");
        bytes32 wrongChallengeNonce = keccak256("withdraw-nonce-4-wrong");
        bytes32 challengeHash = _deriveChallengeHash(challengeNonce, amount, recipient);

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, amount);

        bool reverted;
        try pool.withdraw(nullifier, wrongChallengeNonce, recipient) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected invalid challenge nonce revert");
    }

    function testWithdrawRejectsUnknownNullifier() public {
        setUp();

        bool reverted;
        try pool.withdraw(keccak256("unknown-nullifier"), keccak256("any-nonce"), address(0xFACE)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected unknown nullifier revert");
    }

    function testWithdrawRejectsZeroRecipient() public {
        setUp();

        bytes32 depositCommitment = keccak256("deposit-5");
        pool.deposit(100_000_000, depositCommitment);

        bytes32 root = pool.latestRoot();
        bytes32 nullifier = keccak256("nf-withdraw-5");
        bytes32 merchantCommitment = keccak256("merchant-commitment-5");
        bytes32 changeCommitment = keccak256("change-commitment-5");
        uint256 amount = 12_000_000;
        bytes32 challengeNonce = keccak256("withdraw-nonce-5");
        bytes32 challengeHash = _deriveChallengeHash(challengeNonce, amount, address(0));

        pool.submitSpend(hex"1234", nullifier, root, merchantCommitment, changeCommitment, challengeHash, amount);

        bool reverted;
        try pool.withdraw(nullifier, challengeNonce, address(0)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "expected zero recipient revert");
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
}
