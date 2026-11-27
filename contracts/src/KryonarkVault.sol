// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IOracle {
    function price(address asset) external view returns (uint256);
}

/// @title KryonarkVault
/// @notice Hold tokenized stocks without selling your crypto. Deposit ETH and Stock Tokens as collateral, borrow a
///         USD stablecoin against them (to buy more stocks, or for anything else), and let an agent you appoint
///         guard the account: below 1.30 health it may move your own ETH buffer into your collateral. It can do
///         nothing else: no withdrawing, borrowing, repaying or moving funds anywhere.
/// @dev Health = Σ collateral value × asset LT ÷ debt value (1e18 = 1.00); below 1.00 the account can be liquidated.
///      Debt accrues a simple per-second rate into a global index; lenders own shares of cash + outstanding debt.
contract KryonarkVault {
    // ------------------------------------------------------------------ constants
    address public constant ETH = address(0);
    uint256 public constant OPEN_HEALTH = 1.25e18;    // required after borrowing or withdrawing
    uint256 public constant GUARD_HEALTH = 1.30e18;   // the guardian may act below this
    uint256 public constant LIQ_BONUS_BPS = 500;      // liquidators receive 5% extra collateral
    uint256 public constant CLOSE_FACTOR_BPS = 5_000; // at most half the debt per liquidation, unless under $100
    uint256 public constant MAX_APR_BPS = 5_000;
    uint256 public constant MAX_GUARD_DAYS = 90;

    // ------------------------------------------------------------------ state
    IOracle public immutable oracle;
    IERC20 public immutable usd;          // the debt asset (USDG on Robinhood Chain mainnet)
    uint8 public immutable usdDecimals;

    address public owner;
    address public pendingOwner;
    bool public paused;                   // blocks deposits, borrowing and supplying; never repaying, withdrawing or exiting

    struct Asset { bool listed; uint8 decimals; uint16 ltBps; uint256 cap; uint256 total; }
    address[] public assetList;
    mapping(address => Asset) public assets;
    mapping(address => mapping(address => uint256)) public collateral; // account => asset => amount

    uint256 public aprBps = 800;          // 8% a year
    uint256 public borrowIndex = 1e18;
    uint256 public lastAccrual;
    uint256 public totalScaledDebt;
    uint256 public borrowCap;             // max total debt, in usd units
    mapping(address => uint256) public scaledDebt;

    uint256 public cash;                  // usd held for lenders (tracked, not balanceOf, so donations can't skew shares)
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    mapping(address => uint256) public buffer; // account => ETH the guardian may move into collateral
    uint256 public totalBuffer;
    struct Guardian { address agent; uint64 expiry; }
    mapping(address => Guardian) public guardians;

    uint256 private locked = 1;

    // ------------------------------------------------------------------ events
    event AssetListed(address indexed asset, uint8 decimals, uint16 ltBps, uint256 cap);
    event Deposited(address indexed account, address indexed asset, uint256 amount);
    event Withdrawn(address indexed account, address indexed asset, uint256 amount);
    event Borrowed(address indexed account, uint256 amount);
    event Repaid(address indexed account, address indexed payer, uint256 amount);
    event Supplied(address indexed lender, uint256 amount, uint256 shares);
    event Unsupplied(address indexed lender, uint256 amount, uint256 shares);
    event Liquidated(address indexed account, address indexed liquidator, address indexed asset, uint256 repaid, uint256 seized);
    event BufferDeposited(address indexed account, uint256 amount);
    event BufferWithdrawn(address indexed account, uint256 amount);
    event GuardianSet(address indexed account, address indexed agent, uint64 expiry);
    event GuardTopUp(address indexed account, address indexed agent, uint256 amount, uint256 healthBefore, uint256 healthAfter);
    event Paused(bool paused);
    event Params(uint256 aprBps, uint256 borrowCap);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ------------------------------------------------------------------ errors
    error NotOwner(); error IsPaused(); error NotListed(); error Unhealthy(uint256 health); error Healthy(uint256 health);
    error Amount(); error Cap(); error Liquidity(); error NotGuardian(); error Expired(); error TransferFailed(); error Reentrancy();

    constructor(address oracle_, address usd_, uint256 borrowCap_) {
        oracle = IOracle(oracle_);
        usd = IERC20(usd_);
        usdDecimals = IERC20(usd_).decimals();
        owner = msg.sender;
        borrowCap = borrowCap_;
        lastAccrual = block.timestamp;
        emit OwnershipTransferred(address(0), msg.sender);
        emit Params(aprBps, borrowCap_);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier live() { if (paused) revert IsPaused(); _; }
    modifier nonReentrant() { if (locked != 1) revert Reentrancy(); locked = 2; _; locked = 1; }

    // ------------------------------------------------------------------ interest
    function accrue() public {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return;
        if (totalScaledDebt > 0) borrowIndex += (borrowIndex * aprBps * dt) / (10_000 * 365 days);
        lastAccrual = block.timestamp;
    }

    function _index() internal view returns (uint256) {
        uint256 dt = block.timestamp - lastAccrual;
        return totalScaledDebt == 0 || dt == 0 ? borrowIndex : borrowIndex + (borrowIndex * aprBps * dt) / (10_000 * 365 days);
    }

    function debtOf(address account) public view returns (uint256) { return _ceilDiv(scaledDebt[account] * _index(), 1e18); }
    function totalDebt() public view returns (uint256) { return (totalScaledDebt * _index()) / 1e18; }
    function totalAssetsForLenders() public view returns (uint256) { return cash + totalDebt(); }

    // ------------------------------------------------------------------ valuation
    function assetCount() external view returns (uint256) { return assetList.length; }

    function valueOf(address asset, uint256 amount) public view returns (uint256 usd8) {
        return (amount * oracle.price(asset)) / (10 ** assets[asset].decimals);
    }

    /// @return collLT collateral value × LT (USD, 8 decimals), debt8 debt value (USD, 8 decimals)
    function accountValues(address account) public view returns (uint256 collLT, uint256 debt8) {
        uint256 d = debtOf(account);
        if (d > 0) debt8 = (d * oracle.price(address(usd))) / (10 ** usdDecimals);
        for (uint256 i; i < assetList.length; ++i) {
            address a = assetList[i];
            uint256 c = collateral[account][a];
            if (c > 0) collLT += (valueOf(a, c) * assets[a].ltBps) / 10_000;
        }
    }

    /// @return 1e18-scaled health; type(uint256).max without debt.
    function healthOf(address account) public view returns (uint256) {
        if (scaledDebt[account] == 0) return type(uint256).max;
        (uint256 c, uint256 d) = accountValues(account);
        return d == 0 ? type(uint256).max : (c * 1e18) / d;
    }

    function _requireHealthy(address account) internal view {
        if (scaledDebt[account] == 0) return;
        uint256 h = healthOf(account);
        if (h < OPEN_HEALTH) revert Unhealthy(h);
    }

    // ------------------------------------------------------------------ collateral
    function depositEth() external payable nonReentrant live { _deposit(msg.sender, ETH, msg.value); }

    function deposit(address asset, uint256 amount) external nonReentrant live {
        if (asset == ETH) revert Amount();
        _pull(asset, msg.sender, amount);
        _deposit(msg.sender, asset, amount);
    }

    function _deposit(address account, address asset, uint256 amount) internal {
        Asset storage a = assets[asset];
        if (!a.listed) revert NotListed();
        if (amount == 0) revert Amount();
        if (a.total + amount > a.cap) revert Cap();
        a.total += amount;
        collateral[account][asset] += amount;
        emit Deposited(account, asset, amount);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant {
        accrue();
        uint256 c = collateral[msg.sender][asset];
        if (amount == type(uint256).max) amount = c;
        if (amount == 0 || amount > c) revert Amount();
        collateral[msg.sender][asset] = c - amount;
        assets[asset].total -= amount;
        _requireHealthy(msg.sender);
        emit Withdrawn(msg.sender, asset, amount);
        _send(asset, msg.sender, amount);
    }

    // ------------------------------------------------------------------ debt
    function borrow(uint256 amount) external nonReentrant live {
        accrue();
        if (amount == 0) revert Amount();
        if (amount > cash) revert Liquidity();
        uint256 s = _ceilDiv(amount * 1e18, borrowIndex);
        scaledDebt[msg.sender] += s;
        totalScaledDebt += s;
        if (totalDebt() > borrowCap) revert Cap();
        cash -= amount;
        _requireHealthy(msg.sender);
        emit Borrowed(msg.sender, amount);
        _send(address(usd), msg.sender, amount);
    }

    /// @notice Repay `account`'s debt (anyone can repay for anyone). type(uint256).max repays all of it.
    function repay(address account, uint256 amount) external nonReentrant returns (uint256) {
        accrue();
        uint256 d = debtOf(account);
        if (amount >= d) amount = d;
        if (amount == 0) revert Amount();
        uint256 s = amount == d ? scaledDebt[account] : (amount * 1e18) / borrowIndex;
        _pull(address(usd), msg.sender, amount);
        scaledDebt[account] -= s;
        totalScaledDebt -= s;
        cash += amount;
        emit Repaid(account, msg.sender, amount);
        return amount;
    }

    // ------------------------------------------------------------------ lenders
    function supply(uint256 amount) external nonReentrant live returns (uint256 s) {
        accrue();
        if (amount == 0) revert Amount();
        uint256 total = cash + totalDebt();
        s = totalShares == 0 || total == 0 ? amount : (amount * totalShares) / total;
        if (s == 0) revert Amount();
        _pull(address(usd), msg.sender, amount);
        cash += amount;
        totalShares += s;
        shares[msg.sender] += s;
        emit Supplied(msg.sender, amount, s);
    }

    /// @notice Burn `s` shares for their share of cash + debt; limited by the cash on hand.
    function unsupply(uint256 s) external nonReentrant returns (uint256 amount) {
        accrue();
        if (s == type(uint256).max) s = shares[msg.sender];
        if (s == 0 || s > shares[msg.sender]) revert Amount();
        amount = (s * (cash + totalDebt())) / totalShares;
        if (amount > cash) revert Liquidity();
        shares[msg.sender] -= s;
        totalShares -= s;
        cash -= amount;
        emit Unsupplied(msg.sender, amount, s);
        _send(address(usd), msg.sender, amount);
    }

    // ------------------------------------------------------------------ liquidation
    /// @notice Repay part of an unhealthy account's debt and receive `seizeAsset` collateral worth 5% more.
    function liquidate(address account, address seizeAsset, uint256 repayAmount) external nonReentrant returns (uint256 seized) {
        accrue();
        uint256 h = healthOf(account);
        if (h >= 1e18) revert Healthy(h);
        uint256 d = debtOf(account);
        uint256 usdPx = oracle.price(address(usd));
        uint256 maxRepay = (d * usdPx) / (10 ** usdDecimals) < 100e8 ? d : (d * CLOSE_FACTOR_BPS) / 10_000;
        if (repayAmount > maxRepay) repayAmount = maxRepay;
        if (repayAmount == 0) revert Amount();
        uint256 repaid8 = (repayAmount * usdPx) / (10 ** usdDecimals);
        seized = (repaid8 * (10_000 + LIQ_BONUS_BPS) * (10 ** assets[seizeAsset].decimals)) / (10_000 * oracle.price(seizeAsset));
        uint256 c = collateral[account][seizeAsset];
        if (seized > c) seized = c;
        if (seized == 0) revert Amount();
        _pull(address(usd), msg.sender, repayAmount);
        uint256 s = repayAmount == d ? scaledDebt[account] : (repayAmount * 1e18) / borrowIndex;
        scaledDebt[account] -= s;
        totalScaledDebt -= s;
        cash += repayAmount;
        collateral[account][seizeAsset] = c - seized;
        assets[seizeAsset].total -= seized;
        emit Liquidated(account, msg.sender, seizeAsset, repayAmount, seized);
        _send(seizeAsset, msg.sender, seized);
    }

    // ------------------------------------------------------------------ buffer + guardian (the agent)
    function depositBuffer() external payable nonReentrant {
        if (msg.value == 0) revert Amount();
        if (assets[ETH].total + totalBuffer + msg.value > assets[ETH].cap) revert Cap();
        buffer[msg.sender] += msg.value;
        totalBuffer += msg.value;
        emit BufferDeposited(msg.sender, msg.value);
    }

    function withdrawBuffer(uint256 amount) external nonReentrant {
        if (amount == type(uint256).max) amount = buffer[msg.sender];
        if (amount == 0 || amount > buffer[msg.sender]) revert Amount();
        buffer[msg.sender] -= amount;
        totalBuffer -= amount;
        emit BufferWithdrawn(msg.sender, amount);
        _send(ETH, msg.sender, amount);
    }

    /// @notice Appoint the agent allowed to top up your account from your buffer; agent = address(0) revokes.
    function setGuardian(address agent, uint256 daysValid) external {
        if (agent != address(0) && (daysValid == 0 || daysValid > MAX_GUARD_DAYS)) revert Amount();
        uint64 expiry = agent == address(0) ? 0 : uint64(block.timestamp + daysValid * 1 days);
        guardians[msg.sender] = Guardian(agent, expiry);
        emit GuardianSet(msg.sender, agent, expiry);
    }

    /// @notice Guardian only: move `amount` of the account's ETH buffer into its ETH collateral while health < 1.30.
    function guardTopUp(address account, uint256 amount) external nonReentrant {
        Guardian memory g = guardians[account];
        if (g.agent == address(0) || msg.sender != g.agent) revert NotGuardian();
        if (block.timestamp > g.expiry) revert Expired();
        accrue();
        uint256 before = healthOf(account);
        if (before >= GUARD_HEALTH) revert Healthy(before);
        if (amount == 0 || amount > buffer[account]) revert Amount();
        buffer[account] -= amount;
        totalBuffer -= amount;
        collateral[account][ETH] += amount;
        assets[ETH].total += amount;
        emit Deposited(account, ETH, amount);
        emit GuardTopUp(account, msg.sender, amount, before, healthOf(account));
    }

    // ------------------------------------------------------------------ owner
    function listAsset(address asset, uint16 ltBps, uint256 cap) external onlyOwner {
        require(ltBps <= 9_000 && asset != address(usd), "lt");
        Asset storage a = assets[asset];
        if (!a.listed) { a.listed = true; a.decimals = asset == ETH ? 18 : IERC20(asset).decimals(); assetList.push(asset); }
        a.ltBps = ltBps; a.cap = cap;
        emit AssetListed(asset, a.decimals, ltBps, cap);
    }

    function setParams(uint256 aprBps_, uint256 borrowCap_) external onlyOwner {
        if (aprBps_ > MAX_APR_BPS) revert Amount();
        accrue();
        aprBps = aprBps_; borrowCap = borrowCap_;
        emit Params(aprBps_, borrowCap_);
    }

    function setPaused(bool v) external onlyOwner { paused = v; emit Paused(v); }
    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(owner, to); }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender; pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ transfers
    function _pull(address token, address from, uint256 amount) internal {
        if (amount == 0) revert Amount();
        uint256 before = IERC20(token).balanceOf(address(this));
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed();
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert TransferFailed(); // no fee-on-transfer tokens
    }

    function _send(address asset, address to, uint256 amount) internal {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
            return;
        }
        (bool ok2, bytes memory r) = asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok2 || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) { return a == 0 ? 0 : (a - 1) / b + 1; }
}
