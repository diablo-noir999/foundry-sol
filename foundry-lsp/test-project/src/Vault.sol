// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IToken} from "./IToken.sol";
import {MathUtils} from "./MathUtils.sol";

/// @title Vault
/// @notice A token vault with deposit/withdraw functionality
/// @dev Uses IToken interface for external token interactions
contract Vault {

    // ─── Types ───

    struct Deposit {
        address owner;
        uint256 amount;
        uint256 timestamp;
    }

    enum Status {
        Active,
        Paused,
        Closed
    }

    // ─── Errors ───

    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized();
    error VaultClosed();

    // ─── Events ───

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event StatusChanged(Status newStatus);

    // ─── State ───

    IToken public immutable token;
    Status public status;
    mapping(address => uint256) public balances;
    mapping(uint256 => Deposit) public deposits;
    uint256 public depositCount;

    // ─── Modifiers ───

    modifier onlyOwner() {
        if (msg.sender != _owner()) revert Unauthorized();
        _;
    }

    modifier whenActive() {
        if (status != Status.Active) revert VaultClosed();
        _;
    }

    // ─── Constructor ───

    /// @param _token The ERC20 token address
    constructor(address _token) {
        token = IToken(_token);
        status = Status.Active;
    }

    // ─── External Functions ───

    /// @notice Deposit tokens into the vault
    /// @param amount The amount to deposit
    function deposit(uint256 amount) external whenActive {
        require(amount > 0, "Amount must be > 0");

        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");

        balances[msg.sender] = MathUtils.min(balances[msg.sender] + amount, type(uint256).max);

        deposits[depositCount] = Deposit({
            owner: msg.sender,
            amount: amount,
            timestamp: block.timestamp
        });
        depositCount++;

        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw tokens from the vault
    /// @param amount The amount to withdraw
    function withdraw(uint256 amount) external whenActive {
        uint256 balance = balances[msg.sender];
        if (amount > balance) {
            revert InsufficientBalance(balance, amount);
        }

        balances[msg.sender] = balance - amount;

        bool success = token.transfer(msg.sender, amount);
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Get the total vault balance
    function totalBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Get deposit info
    /// @param depositId The deposit ID
    function getDeposit(uint256 depositId) external view returns (Deposit memory) {
        require(depositId < depositCount, "Invalid deposit ID");
        return deposits[depositId];
    }

    // ─── Internal Functions ───

    function _owner() internal view virtual returns (address) {
        return address(0); // placeholder
    }
}
