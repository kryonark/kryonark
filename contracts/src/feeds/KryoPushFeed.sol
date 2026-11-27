// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title KryoPushFeed
/// @notice A Chainlink-shaped feed for an asset that has no Chainlink feed yet (Anthropic, ANT), pushed by the agent.
/// @dev The reporter key lives on a server, so it is bounded twice:
///      - each push moves the price at most `maxJumpBps` from the last one;
///      - within any 24 h window the price stays within `dailyBandBps` of the price the window opened at.
///      A stolen reporter key can therefore move the price at most `dailyBandBps` a day, not compound 25% per block.
///      A real move beyond the band makes pushes revert, the price goes stale and the vault stops borrowing and
///      liquidating on it, until the owner checks and calls `force`.
contract KryoPushFeed {
    uint8 public constant decimals = 8;
    string public description;

    address public owner;
    address public pendingOwner;
    address public reporter;
    uint256 public maxJumpBps;
    uint256 public dailyBandBps;

    uint128 public price;
    uint64 public updatedAt;
    uint80 public round;
    uint128 public anchor;      // price at the start of the current window
    uint64 public anchorAt;     // when the current window started

    event Pushed(uint256 price, uint256 at);
    event Forced(uint256 price, uint256 at);
    event Reporter(address reporter);
    event Limits(uint256 maxJumpBps, uint256 dailyBandBps);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner(); error NotReporter(); error OutOfBand(uint256 price, uint256 low, uint256 high); error BadPrice();

    constructor(string memory description_, address reporter_, uint256 initialPrice, uint256 maxJumpBps_, uint256 dailyBandBps_) {
        description = description_; owner = msg.sender; reporter = reporter_;
        _limits(maxJumpBps_, dailyBandBps_);
        _set(initialPrice, true);
        emit OwnershipTransferred(address(0), msg.sender); emit Reporter(reporter_);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, int256(uint256(price)), updatedAt, updatedAt, round);
    }

    function push(uint256 p) external {
        if (msg.sender != reporter) revert NotReporter();
        if (p == 0 || p > type(uint128).max) revert BadPrice();
        if (block.timestamp >= anchorAt + 1 days) { anchor = price; anchorAt = uint64(block.timestamp); }
        uint256 prev = price;
        uint256 j = (prev * maxJumpBps) / 10_000;
        if (p > prev + j || p + j < prev) revert OutOfBand(p, prev - j, prev + j);
        uint256 b = (uint256(anchor) * dailyBandBps) / 10_000;
        if (p > anchor + b || p + b < anchor) revert OutOfBand(p, anchor - b, anchor + b);
        _set(p, false);
        emit Pushed(p, block.timestamp);
    }

    /// @notice Owner only: set the price outside the bands (after checking a real move) and restart the window.
    function force(uint256 p) external onlyOwner {
        if (p == 0 || p > type(uint128).max) revert BadPrice();
        _set(p, true);
        emit Forced(p, block.timestamp);
    }

    function setReporter(address r) external onlyOwner { reporter = r; emit Reporter(r); }
    function setLimits(uint256 maxJumpBps_, uint256 dailyBandBps_) external onlyOwner { _limits(maxJumpBps_, dailyBandBps_); }

    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(owner, to); }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender; pendingOwner = address(0);
    }

    function _limits(uint256 j, uint256 b) internal {
        require(j >= 10 && j <= 2_500 && b >= j && b <= 5_000, "limits");
        maxJumpBps = j; dailyBandBps = b;
        emit Limits(j, b);
    }

    function _set(uint256 p, bool resetWindow) internal {
        if (p == 0 || p > type(uint128).max) revert BadPrice();
        price = uint128(p); updatedAt = uint64(block.timestamp); round++;
        if (resetWindow) { anchor = uint128(p); anchorAt = uint64(block.timestamp); }
    }
}
