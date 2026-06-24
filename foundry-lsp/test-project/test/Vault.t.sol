// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {IToken} from "../src/IToken.sol";

/// @title VaultTest
/// @notice Test suite for the Vault contract
contract VaultTest is Test {
    Vault public vault;
    MockToken public token;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new MockToken("MockToken", "MTK");
        vault = new Vault(address(token));

        // Mint tokens to test accounts
        token.mint(alice, 1000 ether);
        token.mint(bob, 1000 ether);
    }

    function testDeposit() public {
        vm.prank(alice);
        token.approve(address(vault), 100 ether);

        vm.prank(alice);
        vault.deposit(100 ether);

        assertEq(vault.balances(alice), 100 ether);
        assertEq(token.balanceOf(address(vault)), 100 ether);
    }

    function testWithdraw() public {
        // Deposit first
        vm.prank(alice);
        token.approve(address(vault), 100 ether);
        vm.prank(alice);
        vault.deposit(100 ether);

        // Withdraw
        vm.prank(alice);
        vault.withdraw(50 ether);

        assertEq(vault.balances(alice), 50 ether);
        assertEq(token.balanceOf(alice), 950 ether);
    }

    function testWithdrawInsufficientBalance() public {
        vm.prank(alice);
        token.approve(address(vault), 100 ether);
        vm.prank(alice);
        vault.deposit(100 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Vault.InsufficientBalance.selector, 100 ether, 200 ether));
        vault.withdraw(200 ether);
    }

    function testTotalBalance() public {
        assertEq(vault.totalBalance(), 0);

        vm.prank(alice);
        token.approve(address(vault), 100 ether);
        vm.prank(alice);
        vault.deposit(100 ether);

        assertEq(vault.totalBalance(), 100 ether);
    }
}

/// @title MockToken
/// @notice Simple ERC20 mock for testing
contract MockToken {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
