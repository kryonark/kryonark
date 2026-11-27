// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FixedFeed
/// @notice A Chainlink-shaped feed that always answers one constant price, stamped with the current block time.
///         Used for the debt stablecoin (USDG = $1.00) so that no key, the agent's included, can move the price
///         of the debt. If USDG ever depegs, the owner can point the oracle at a real feed instead.
contract FixedFeed {
    int256 public immutable answer;
    uint8 public constant decimals = 8;
    string public description;

    constructor(int256 answer_, string memory description_) {
        require(answer_ > 0, "answer");
        answer = answer_; description = description_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
