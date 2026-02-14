// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockProofVerifier} from "../src/verifiers/MockProofVerifier.sol";

address constant HEVM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function warp(uint256 timestamp) external;
}

contract ShieldedPoolWithdrawTest {
    Vm internal constant vm = Vm(HEVM_ADDRESS);

    ShieldedPool internal pool;
    MockUSDC internal usdc;
    MockProofVerifier internal verifier;

    function setUp() public {
        usdc = new MockUSDC();
        verifier = new MockProofVerifier();
        pool = new ShieldedPool(address(usdc), address(verifier));

        usdc.mint(address(this), 2_000_000_000);
        usdc.approve(address(pool), type(uint256).max);

        // Seed pool liquidity used for merchant withdrawals in tests.
        pool.deposit(1_000_000_000, keccak256("seed-liquidity"));
    }

    function testWithdrawByAllowedMerchantSignature() public {
        setUp();

        uint256 merchantKey = 0xA11CE;
        address merchant = vm.addr(merchantKey);
        address recipient = address(0xBEEF);
        uint256 amount = 100_000_000;
        bytes memory encryptedNote = bytes("ciphertext");
        bytes32 claimId = keccak256("claim-1");
        uint64 deadline = uint64(block.timestamp + 300);

        pool.setMerchant(merchant, true);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "shielded-x402:v1:withdraw",
                address(pool),
                encryptedNote,
                recipient,
                amount,
                claimId,
                deadline
            )
        );
        bytes32 signedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantKey, signedDigest);

        uint256 beforeBalance = usdc.balanceOf(recipient);

        bytes memory auth = abi.encode(
            merchant,
            recipient,
            amount,
            claimId,
            deadline,
            v,
            r,
            s
        );

        pool.withdraw(encryptedNote, auth);

        uint256 afterBalance = usdc.balanceOf(recipient);
        require(afterBalance == beforeBalance + amount, "recipient not paid");
    }

    function testWithdrawRejectsReusedClaimId() public {
        setUp();

        uint256 merchantKey = 0xB0B;
        address merchant = vm.addr(merchantKey);
        address recipient = address(0xF00D);
        uint256 amount = 20_000_000;
        bytes memory encryptedNote = bytes("ciphertext");
        bytes32 claimId = keccak256("claim-2");
        uint64 deadline = uint64(block.timestamp + 300);

        pool.setMerchant(merchant, true);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "shielded-x402:v1:withdraw",
                address(pool),
                encryptedNote,
                recipient,
                amount,
                claimId,
                deadline
            )
        );
        bytes32 signedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantKey, signedDigest);
        bytes memory auth = abi.encode(merchant, recipient, amount, claimId, deadline, v, r, s);

        pool.withdraw(encryptedNote, auth);

        bool reverted;
        try pool.withdraw(encryptedNote, auth) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "expected claim reuse revert");
    }

    function testWithdrawRejectsExpiredAuth() public {
        setUp();

        uint256 merchantKey = 0xCAFE;
        address merchant = vm.addr(merchantKey);
        address recipient = address(0x1234);
        uint256 amount = 10_000_000;
        bytes memory encryptedNote = bytes("ciphertext");
        bytes32 claimId = keccak256("claim-3");
        uint64 deadline = uint64(block.timestamp + 1);

        pool.setMerchant(merchant, true);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "shielded-x402:v1:withdraw",
                address(pool),
                encryptedNote,
                recipient,
                amount,
                claimId,
                deadline
            )
        );
        bytes32 signedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantKey, signedDigest);
        bytes memory auth = abi.encode(merchant, recipient, amount, claimId, deadline, v, r, s);

        vm.warp(block.timestamp + 2);

        bool reverted;
        try pool.withdraw(encryptedNote, auth) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "expected expired auth revert");
    }
}
