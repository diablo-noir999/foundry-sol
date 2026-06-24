// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title IToken
/// @notice Interface for a basic token
interface IToken {
    /// @notice Get the balance of an account
    /// @param account The address to query
    /// @return The token balance
    function balanceOf(address account) external view returns (uint256);

    /// @notice Transfer tokens to a recipient
    /// @param to The recipient address
    /// @param amount The amount to transfer
    /// @return success Whether the transfer succeeded
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Transfer tokens from one address to another
    /// @param from The sender address
    /// @param to The recipient address
    /// @param amount The amount to transfer
    /// @return success Whether the transfer succeeded
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Approve a spender
    /// @param spender The spender address
    /// @param amount The amount to approve
    /// @return success Whether the approval succeeded
    function approve(address spender, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
}
