// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title TestUSD (testnet only)
/// @notice A 6-decimal test dollar for Robinhood Chain testnet, where no official stablecoin exists.
///         Anyone can mint up to 10,000 per call from the faucet. Never deployed on mainnet (USDG is used there).
contract TestUSD {
    string public constant name = "Kryonark Test USD";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function faucet(uint256 amount) external {
        require(amount <= 10_000e6, "max 10k per call");
        totalSupply += amount; balanceOf[msg.sender] += amount;
        emit Transfer(address(0), msg.sender, amount);
    }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) { require(al >= a, "allowance"); allowance[f][msg.sender] = al - a; }
        _move(f, to, a); return true;
    }
    function _move(address f, address to, uint256 a) internal {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a);
    }
}
