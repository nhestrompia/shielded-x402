// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IShieldedPool} from "../interfaces/IShieldedPool.sol";

/// @notice Example merchant-side onchain service that grants credits only after
///         a nullifier is observed as spent in ShieldedPool.
contract DummyShieldedService {
    IShieldedPool public immutable pool;
    address public owner;
    address public relayer;

    mapping(bytes32 => bool) public settledNullifier;
    mapping(address => uint256) public credits;

    error NotOwner();
    error InvalidBeneficiary();
    error InvalidAmount();
    error NullifierNotSettledOnPool();
    error NullifierAlreadySettled();
    error RelayerOnly();
    error InsufficientCredit();

    event RelayerUpdated(address indexed relayer);
    event PaymentSettled(
        bytes32 indexed nullifier,
        address indexed beneficiary,
        uint256 amount,
        bytes32 indexed challengeHash
    );
    event CreditConsumed(address indexed beneficiary, uint256 amount, uint256 remainingCredit);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address pool_) {
        require(pool_ != address(0), "zero pool");
        pool = IShieldedPool(pool_);
        owner = msg.sender;
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    /// @notice Called after a successful pool spend tx has been included.
    /// @dev If relayer is set, only relayer can call this function.
    function settlePayment(
        bytes32 nullifier,
        address beneficiary,
        uint256 amount,
        bytes32 challengeHash
    ) external {
        if (relayer != address(0) && msg.sender != relayer) revert RelayerOnly();
        if (beneficiary == address(0)) revert InvalidBeneficiary();
        if (amount == 0) revert InvalidAmount();
        if (settledNullifier[nullifier]) revert NullifierAlreadySettled();
        if (!pool.isNullifierUsed(nullifier)) revert NullifierNotSettledOnPool();

        settledNullifier[nullifier] = true;
        credits[beneficiary] += amount;

        emit PaymentSettled(nullifier, beneficiary, amount, challengeHash);
    }

    /// @notice Simulates protected API usage metering with prepaid credits.
    function consumeCredit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        uint256 available = credits[msg.sender];
        if (available < amount) revert InsufficientCredit();

        uint256 remaining = available - amount;
        credits[msg.sender] = remaining;
        emit CreditConsumed(msg.sender, amount, remaining);
    }
}
