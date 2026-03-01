// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommitmentRegistryV1} from "../src/CommitmentRegistryV1.sol";

address constant HEVM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

interface Vm {
    function prank(address sender) external;
}

contract CommitmentRegistryV1Test {
    Vm internal constant vm = Vm(HEVM_ADDRESS);

    address internal constant SEQUENCER = address(0x1234);
    address internal constant OTHER = address(0x9999);

    function testSequentialPostingAndPrevRootLink() public {
        CommitmentRegistryV1 registry = new CommitmentRegistryV1(SEQUENCER);

        bytes32 root1 = keccak256("root1");
        bytes32 keyId1 = keccak256("seq-key-1");
        vm.prank(SEQUENCER);
        registry.postCommitment(1, root1, 2, bytes32(0), keyId1);

        require(registry.latestEpochId() == 1, "latest epoch mismatch");
        require(registry.roots(1) == root1, "root1 mismatch");

        bytes32 root2 = keccak256("root2");
        vm.prank(SEQUENCER);
        registry.postCommitment(2, root2, 3, root1, keyId1);

        require(registry.latestEpochId() == 2, "latest epoch mismatch after second post");
        require(registry.roots(2) == root2, "root2 mismatch");
    }

    function testRejectsUnauthorizedPoster() public {
        CommitmentRegistryV1 registry = new CommitmentRegistryV1(SEQUENCER);
        bool reverted;

        vm.prank(OTHER);
        try registry.postCommitment(1, keccak256("root"), 1, bytes32(0), keccak256("key")) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "expected unauthorized revert");
    }

    function testRejectsWrongEpochOrPrevRoot() public {
        CommitmentRegistryV1 registry = new CommitmentRegistryV1(SEQUENCER);
        bytes32 root1 = keccak256("root1");
        bytes32 keyId = keccak256("seq-key-1");

        vm.prank(SEQUENCER);
        registry.postCommitment(1, root1, 1, bytes32(0), keyId);

        bool badEpochReverted;
        vm.prank(SEQUENCER);
        try registry.postCommitment(3, keccak256("root3"), 1, root1, keyId) {
            badEpochReverted = false;
        } catch {
            badEpochReverted = true;
        }
        require(badEpochReverted, "expected bad epoch revert");

        bool badPrevRootReverted;
        vm.prank(SEQUENCER);
        try registry.postCommitment(2, keccak256("root2"), 1, bytes32(uint256(1)), keyId) {
            badPrevRootReverted = false;
        } catch {
            badPrevRootReverted = true;
        }
        require(badPrevRootReverted, "expected bad prev root revert");
    }
}
