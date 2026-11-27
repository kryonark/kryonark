// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/KryoOracle.sol";
import "../src/KryonarkVault.sol";

contract MockToken {
    string public symbol; uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory s, uint8 d) { symbol = s; decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MockFeed {
    int256 public answer; uint256 public at; uint8 public decimals = 8;
    function set(int256 a, uint256 t) external { answer = a; at = t; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, at, at, 1); }
}

contract VaultTest is Test {
    KryoOracle oracle;
    KryonarkVault vault;
    MockToken usdg;
    MockToken nvda;
    address reporter = address(0xAA);
    address agent = address(0xA6);
    address lp = address(0x11);
    address alice = address(0xA1);
    address liq = address(0x77);
    address constant ETH = address(0);

    function setUp() public {
        oracle = new KryoOracle(reporter);
        usdg = new MockToken("USDG", 6);
        nvda = new MockToken("NVDA", 18);
        vault = new KryonarkVault(address(oracle), address(usdg), 1_000_000e6);
        _px(3000e8, 150e8);
        vault.listAsset(ETH, 8_000, 1_000 ether);
        vault.listAsset(address(nvda), 7_000, 100_000e18);
        usdg.mint(lp, 1_000_000e6);
        vm.startPrank(lp); usdg.approve(address(vault), type(uint256).max); vault.supply(100_000e6); vm.stopPrank();
        vm.deal(alice, 100 ether);
        nvda.mint(alice, 100e18);
        vm.startPrank(alice); nvda.approve(address(vault), type(uint256).max); usdg.approve(address(vault), type(uint256).max); vm.stopPrank();
        usdg.mint(liq, 1_000_000e6);
        vm.prank(liq); usdg.approve(address(vault), type(uint256).max);
    }

    function _px(uint256 eth, uint256 stock) internal {
        address[] memory a = new address[](3); a[0] = ETH; a[1] = address(nvda); a[2] = address(usdg);
        uint256[] memory p = new uint256[](3); p[0] = eth; p[1] = stock; p[2] = 1e8;
        vm.prank(reporter); oracle.push(a, p);
    }

    function test_borrowAgainstEth() public {
        vm.startPrank(alice);
        vault.depositEth{value: 1 ether}();
        vault.borrow(1_500e6); // $3000 × 0.8 / $1500 = 1.60
        vm.stopPrank();
        assertEq(vault.healthOf(alice), 1.6e18);
        assertEq(usdg.balanceOf(alice), 1_500e6);
    }

    function test_stocksCountAsCollateral() public {
        vm.startPrank(alice);
        vault.depositEth{value: 1 ether}();
        vault.deposit(address(nvda), 10e18); // $1500 × 0.7 = $1050
        vault.borrow(2_760e6);               // ($2400 + $1050) / $2760 = 1.25
        vm.stopPrank();
        assertEq(vault.healthOf(alice), 1.25e18);
    }

    function test_cannotOverBorrow() public {
        vm.startPrank(alice);
        vault.depositEth{value: 1 ether}();
        vm.expectRevert();
        vault.borrow(2_000e6); // 1.20
        vm.stopPrank();
    }

    function test_interestAccruesToLenders() public {
        vm.startPrank(alice); vault.depositEth{value: 1 ether}(); vault.borrow(1_000e6); vm.stopPrank();
        vm.warp(block.timestamp + 365 days);
        _px(3000e8, 150e8);
        assertApproxEqRel(vault.debtOf(alice), 1_080e6, 1e15); // 8% a year
        vm.prank(alice); usdg.mint(alice, 100e6);
        vm.prank(alice); vault.repay(alice, type(uint256).max);
        assertEq(vault.debtOf(alice), 0);
        vm.prank(lp); uint256 out = vault.unsupply(type(uint256).max);
        assertApproxEqRel(out, 100_080e6, 1e15);
    }

    function test_guardianOnlyTopsUp() public {
        vm.startPrank(alice);
        vault.depositEth{value: 1 ether}();
        vault.borrow(1_500e6);
        vault.depositBuffer{value: 1 ether}();
        vault.setGuardian(agent, 30);
        vm.stopPrank();

        vm.prank(agent); vm.expectRevert(); vault.guardTopUp(alice, 0.5 ether); // healthy

        _px(2250e8, 150e8); // health 1.20
        vm.prank(agent); vault.guardTopUp(alice, 0.5 ether);
        assertEq(vault.healthOf(alice), 1.8e18);
        assertEq(vault.buffer(alice), 0.5 ether);
        assertEq(vault.collateral(alice, ETH), 1.5 ether);

        vm.prank(liq); vm.expectRevert(KryonarkVault.NotGuardian.selector); vault.guardTopUp(alice, 0.1 ether);
        // the agent has no path to alice's funds: withdraw is msg.sender-only
        vm.prank(agent); vm.expectRevert(); vault.withdraw(ETH, 0.1 ether);

        vm.prank(alice); vault.setGuardian(address(0), 0);
        _px(1700e8, 150e8);
        vm.prank(agent); vm.expectRevert(KryonarkVault.NotGuardian.selector); vault.guardTopUp(alice, 0.1 ether);
    }

    function test_guardianExpires() public {
        vm.startPrank(alice);
        vault.depositEth{value: 1 ether}(); vault.borrow(1_500e6); vault.depositBuffer{value: 1 ether}(); vault.setGuardian(agent, 1);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        _px(2250e8, 150e8);
        vm.prank(agent); vm.expectRevert(KryonarkVault.Expired.selector); vault.guardTopUp(alice, 0.5 ether);
    }

    function test_liquidationSeizesChosenCollateral() public {
        vm.startPrank(alice);
        vault.depositEth{value: 1 ether}(); vault.deposit(address(nvda), 10e18); vault.borrow(2_700e6);
        vm.stopPrank();
        vm.prank(liq); vm.expectRevert(); vault.liquidate(alice, address(nvda), 100e6);
        _px(2250e8, 120e8); // (1800 + 840) / 2700 = 0.977
        vm.prank(liq); uint256 seized = vault.liquidate(alice, address(nvda), 840e6);
        // $840 × 1.05 / $120 = 7.35 NVDA
        assertEq(seized, 7.35e18);
        assertEq(nvda.balanceOf(liq), 7.35e18);
    }

    function test_pauseNeverTrapsUsers() public {
        vm.startPrank(alice); vault.depositEth{value: 1 ether}(); vault.borrow(1_000e6); vm.stopPrank();
        vault.setPaused(true);
        vm.prank(alice); vm.expectRevert(KryonarkVault.IsPaused.selector); vault.borrow(1e6);
        vm.startPrank(alice);
        vault.repay(alice, type(uint256).max);
        vault.withdraw(ETH, type(uint256).max);
        vm.stopPrank();
        assertEq(vault.collateral(alice, ETH), 0);
    }

    function test_exitWithStaleOracleOnceRepaid() public {
        vm.startPrank(alice); vault.depositEth{value: 1 ether}(); vault.borrow(1_000e6); vm.stopPrank();
        vm.warp(block.timestamp + 3 hours); // all prices stale
        vm.startPrank(alice);
        usdg.mint(alice, 10e6);
        vault.repay(alice, type(uint256).max);
        vault.withdraw(ETH, type(uint256).max);
        vm.stopPrank();
        assertEq(alice.balance, 100 ether);
    }

    function test_chainlinkFeedAndStaleness() public {
        MockFeed f = new MockFeed();
        f.set(2000e8, block.timestamp);
        oracle.setFeed(ETH, address(f), 1 hours);
        assertEq(oracle.price(ETH), 2000e8);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(KryoOracle.Stale.selector, ETH));
        oracle.price(ETH);
    }

    function test_caps() public {
        vault.listAsset(ETH, 8_000, 1 ether);
        vm.prank(alice); vm.expectRevert(KryonarkVault.Cap.selector); vault.depositEth{value: 2 ether}();
        vault.setParams(800, 100e6);
        vm.startPrank(alice); vault.depositEth{value: 1 ether}(); vm.expectRevert(KryonarkVault.Cap.selector); vault.borrow(200e6); vm.stopPrank();
    }

    function test_lenderLimitedByCash() public {
        vm.startPrank(alice); vault.depositEth{value: 50 ether}(); vault.borrow(90_000e6); vm.stopPrank();
        vm.prank(lp); vm.expectRevert(KryonarkVault.Liquidity.selector); vault.unsupply(type(uint256).max);
    }

    function test_oracleJumpBound() public {
        address[] memory a = new address[](1); a[0] = ETH;
        uint256[] memory p = new uint256[](1); p[0] = 6000e8;
        vm.prank(reporter); vm.expectRevert(); oracle.push(a, p);
    }
}
