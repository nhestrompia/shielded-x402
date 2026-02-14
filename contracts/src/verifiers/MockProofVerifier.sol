// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

contract MockProofVerifier is IProofVerifier {
    bool public shouldVerify = true;

    function setShouldVerify(bool value) external {
        shouldVerify = value;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return shouldVerify;
    }
}
