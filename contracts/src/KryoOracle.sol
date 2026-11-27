// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256 updatedAt, uint80);
}

/// @title KryoOracle
/// @notice USD prices with 8 decimals for ETH (asset = address(0)), stock tokens and the debt stablecoin.
///         Each asset reads a Chainlink feed when one is set (Robinhood Chain mainnet), otherwise a price pushed
///         by the reporter (testnet, where Chainlink has no feeds).
/// @dev Pushed prices are bounded: each push moves a price by at most `maxJumpBps`. Any price older than its
///      max age is refused, which stops borrowing and liquidations on bad data instead of acting on it.
contract KryoOracle {
    struct Pushed { uint128 price; uint64 updatedAt; }
    struct Feed { address aggregator; uint32 maxAge; }

    address public owner;
    address public pendingOwner;
    address public reporter;
    uint256 public pushedMaxAge = 1 hours;
    uint256 public maxJumpBps = 2_500;

    mapping(address => Pushed) public pushed;
    mapping(address => Feed) public feeds;

    event Price(address indexed asset, uint256 price, uint256 at);
    event FeedSet(address indexed asset, address aggregator, uint32 maxAge);
    event Reporter(address reporter);
    event Limits(uint256 pushedMaxAge, uint256 maxJumpBps);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner(); error NotReporter(); error BadPrice(address asset); error Stale(address asset); error Length();

    constructor(address reporter_) {
        owner = msg.sender; reporter = reporter_;
        emit OwnershipTransferred(address(0), msg.sender); emit Reporter(reporter_);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    /// @notice Price in USD with 8 decimals. Reverts when missing, non-positive or stale.
    function price(address asset) public view returns (uint256) {
        Feed memory f = feeds[asset];
        if (f.aggregator != address(0)) {
            (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(f.aggregator).latestRoundData();
            if (answer <= 0) revert BadPrice(asset);
            if (block.timestamp - updatedAt > f.maxAge) revert Stale(asset);
            uint8 d = IAggregatorV3(f.aggregator).decimals();
            uint256 a = uint256(answer);
            return d == 8 ? a : d > 8 ? a / 10 ** (d - 8) : a * 10 ** (8 - d);
        }
        Pushed memory p = pushed[asset];
        if (p.price == 0) revert BadPrice(asset);
        if (block.timestamp - p.updatedAt > pushedMaxAge) revert Stale(asset);
        return p.price;
    }

    /// @notice Same as price() but never reverts: (price, updatedAt, ok). For the site and the agent.
    function peek(address asset) external view returns (uint256 p, uint256 at, bool ok) {
        Feed memory f = feeds[asset];
        if (f.aggregator != address(0)) {
            try IAggregatorV3(f.aggregator).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
                if (answer <= 0) return (0, updatedAt, false);
                uint8 d = IAggregatorV3(f.aggregator).decimals();
                p = d == 8 ? uint256(answer) : d > 8 ? uint256(answer) / 10 ** (d - 8) : uint256(answer) * 10 ** (8 - d);
                return (p, updatedAt, block.timestamp - updatedAt <= f.maxAge);
            } catch { return (0, 0, false); }
        }
        Pushed memory q = pushed[asset];
        return (q.price, q.updatedAt, q.price != 0 && block.timestamp - q.updatedAt <= pushedMaxAge);
    }

    function push(address[] calldata assets, uint256[] calldata prices) external {
        if (msg.sender != reporter) revert NotReporter();
        if (assets.length != prices.length) revert Length();
        for (uint256 i; i < assets.length; ++i) {
            uint256 p = prices[i];
            if (p == 0 || p > type(uint128).max) revert BadPrice(assets[i]);
            Pushed storage s = pushed[assets[i]];
            if (s.price != 0) {
                uint256 prev = s.price;
                uint256 diff = p > prev ? p - prev : prev - p;
                if (diff * 10_000 > prev * maxJumpBps) revert BadPrice(assets[i]);
            }
            s.price = uint128(p); s.updatedAt = uint64(block.timestamp);
            emit Price(assets[i], p, block.timestamp);
        }
    }

    function setFeed(address asset, address aggregator, uint32 maxAge) external onlyOwner {
        require(aggregator == address(0) || (maxAge >= 1 minutes && maxAge <= 4 days), "maxAge");
        feeds[asset] = Feed(aggregator, maxAge);
        emit FeedSet(asset, aggregator, maxAge);
    }

    function force(address asset, uint256 p) external onlyOwner {
        if (p == 0 || p > type(uint128).max) revert BadPrice(asset);
        pushed[asset] = Pushed(uint128(p), uint64(block.timestamp));
        emit Price(asset, p, block.timestamp);
    }

    function setReporter(address r) external onlyOwner { reporter = r; emit Reporter(r); }

    function setLimits(uint256 maxAge_, uint256 maxJumpBps_) external onlyOwner {
        require(maxAge_ >= 1 minutes && maxAge_ <= 7 days && maxJumpBps_ >= 100 && maxJumpBps_ <= 10_000, "limits");
        pushedMaxAge = maxAge_; maxJumpBps = maxJumpBps_;
        emit Limits(maxAge_, maxJumpBps_);
    }

    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(owner, to); }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender; pendingOwner = address(0);
    }
}
