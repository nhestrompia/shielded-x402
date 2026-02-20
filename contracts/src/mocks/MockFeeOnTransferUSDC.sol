// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";

contract MockFeeOnTransferUSDC is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) {
        require(feeBps_ <= 10_000, "invalid fee");
        feeBps = feeBps_;
    }

    function name() public pure override returns (string memory) {
        return "Mock Fee USD Coin";
    }

    function symbol() public pure override returns (string memory) {
        return "mfUSDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 received = amount - fee;
        _transfer(msg.sender, to, received);
        if (fee > 0) {
            _burn(msg.sender, fee);
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 received = amount - fee;
        _transfer(from, to, received);
        if (fee > 0) {
            _burn(from, fee);
        }
        return true;
    }
}
