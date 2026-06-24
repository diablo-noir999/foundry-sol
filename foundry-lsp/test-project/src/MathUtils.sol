// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title MathUtils
/// @notice Common math operations
library MathUtils {
    /// @notice Returns the minimum of two uint256 values
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Returns the maximum of two uint256 values
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @notice Returns the absolute difference
    function abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
