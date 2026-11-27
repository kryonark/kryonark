// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/KryoOracle.sol";
import "../src/KryonarkVault.sol";
import "../src/feeds/FixedFeed.sol";
import "../src/feeds/KryoPushFeed.sol";
import {MockToken, MockFeed} from "./Vault.t.sol";

/// Tests written for the internal review (docs/review.md): each one pins a finding or a property.
contract ReviewTest is Test {
    KryoOracle oracle; KryonarkVault vault; MockToken usdg; MockToken nvda;
    MockFeed ethFeed; MockFeed stockFeed;
    address reporter = address(0xAA); address agent = address(0xA6); address lp = address(0x11);
    address alice = address(0xA1); address liq = address(0x77);
    address constant ETH = address(0);

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new KryoOracle(reporter);
        usdg = new MockToken("USDG", 6); nvda = new MockToken("NVDA", 18);
        vault = new KryonarkVault(address(oracle), address(usdg), 10_000_000e6);
        ethFeed = new MockFeed(); stockFeed = new MockFeed();
        ethFeed.set(3000e8, block.timestamp); stockFeed.set(150e8, block.timestamp);
        oracle.setFeed(ETH, address(ethFeed), 90_000);
        oracle.setFeed(address(nvda), address(stockFeed), 90_000);
        oracle.setFeed(address(usdg), address(new FixedFeed(1e8, "USDG / USD fixed")), 90_000);
        vault.listAsset(ETH, 8_000, 10_000 ether);
        vault.listAsset(address(nvda), 7_000, 1_000_000e18);
        usdg.mint(lp, 10_000_000e6); usdg.mint(liq, 10_000_000e6);
        vm.startPrank(lp); usdg.approve(address(vault), type(uint256).max); vault.supply(1_000_000e6); vm.stopPrank();
        vm.prank(liq); usdg.approve(address(vault), type(uint256).max);
        vm.deal(alice, 1_000 ether); nvda.mint(alice, 1_000e18);
        vm.startPrank(alice); nvda.approve(address(vault), type(uint256).max); usdg.approve(address(vault), type(uint256).max); vm.stopPrank();
    }

    function _open(uint256 eth, uint256 stocks, uint256 healthBps) internal {
        vm.startPrank(alice);
        if (eth > 0) vault.depositEth{value: eth}();
        if (stocks > 0) vault.deposit(address(nvda), stocks);
        (uint256 collLT,) = vault.accountValues(alice);
        vault.borrow((collLT * 10_000) / healthBps / 100);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- guardian
    /// For any price drop and any amount, a top-up only moves alice's buffer into alice's collateral.
    function testFuzz_guardianOnlyMovesBufferToCollateral(uint256 dropBps, uint256 buf, uint256 amt) public {
        dropBps = bound(dropBps, 0, 5_000); buf = bound(buf, 1, 100 ether);
        _open(10 ether, 0, 12_600);
        vm.startPrank(alice); vault.depositBuffer{value: buf}(); vault.setGuardian(agent, 30); vm.stopPrank();
        ethFeed.set(int256(3000e8 * (10_000 - dropBps) / 10_000), block.timestamp);
        uint256 total = vault.collateral(alice, ETH) + vault.buffer(alice);
        uint256 bal = address(vault).balance;
        amt = bound(amt, 1, buf);
        vm.prank(agent);
        try vault.guardTopUp(alice, amt) {
            assertEq(vault.collateral(alice, ETH) + vault.buffer(alice), total);
            assertEq(address(vault).balance, bal);
        } catch (bytes memory err) {
            // only refused when healthy (>= 1.30) or when a price is unreadable
            assertEq(bytes4(err), KryonarkVault.Healthy.selector);
            assertGe(vault.healthOf(alice), vault.GUARD_HEALTH());
        }
    }

    /// The guardian holds no power over funds: every exit function acts on the caller's own (empty) account.
    function test_guardianCannotTakeAnything() public {
        _open(10 ether, 100e18, 13_000);
        vm.startPrank(alice); vault.depositBuffer{value: 1 ether}(); vault.setGuardian(agent, 90); vm.stopPrank();
        vm.startPrank(agent);
        vm.expectRevert(KryonarkVault.Amount.selector); vault.withdraw(ETH, 1);
        vm.expectRevert(KryonarkVault.Amount.selector); vault.withdraw(address(nvda), 1);
        vm.expectRevert(KryonarkVault.Amount.selector); vault.withdrawBuffer(1);
        vm.expectRevert(KryonarkVault.Amount.selector); vault.unsupply(1);
        vm.expectRevert(abi.encodeWithSelector(KryonarkVault.Healthy.selector, vault.healthOf(alice))); vault.liquidate(alice, ETH, 1);
        vm.stopPrank();
        // revoked or expired: nothing at all
        ethFeed.set(2800e8, block.timestamp);
        vm.prank(alice); vault.setGuardian(address(0), 0);
        vm.prank(agent); vm.expectRevert(KryonarkVault.NotGuardian.selector); vault.guardTopUp(alice, 1);
        vm.prank(alice); vault.setGuardian(agent, 1);
        vm.warp(block.timestamp + 1 days + 1); ethFeed.set(2800e8, block.timestamp); stockFeed.set(150e8, block.timestamp);
        vm.prank(agent); vm.expectRevert(KryonarkVault.Expired.selector); vault.guardTopUp(alice, 1);
    }

    // ---------------------------------------------------------------- liquidation
    /// A liquidator never receives more than the repaid value + 5%, and never more than half the debt is repaid.
    function testFuzz_liquidationBounded(uint256 dropBps, uint256 repay) public {
        dropBps = bound(dropBps, 2_100, 6_000);
        _open(10 ether, 0, 12_600);
        uint256 px = 3000e8 * (10_000 - dropBps) / 10_000;
        ethFeed.set(int256(px), block.timestamp);
        vm.assume(vault.healthOf(alice) < 1e18);
        uint256 d = vault.debtOf(alice);
        repay = bound(repay, 1, d);
        uint256 before = liq.balance;
        vm.prank(liq);
        try vault.liquidate(alice, ETH, repay) returns (uint256 seized) {
            uint256 repaid = d - vault.debtOf(alice);
            assertLe(repaid, d / 2 + 1, "close factor");
            uint256 seizedUsd6 = (seized * px) / 1e18 / 100;
            assertLe(seizedUsd6, (repaid * 10_500) / 10_000 + 1, "bonus above 5%");
            assertEq(liq.balance - before, seized);
        } catch (bytes memory err) { assertEq(bytes4(err), KryonarkVault.Amount.selector); }
    }

    // ---------------------------------------------------------------- finding: weekend staleness
    /// Chainlink stock feeds on Robinhood Chain pause over weekends (57 h gap seen on AAPL / USD). With a 25 h max age
    /// the guardian is blocked exactly when it's needed: Monday's open after a crypto move over the weekend.
    function test_finding_weekendBlocksGuardianAt25h() public {
        _open(10 ether, 100e18, 13_500);
        vm.startPrank(alice); vault.depositBuffer{value: 2 ether}(); vault.setGuardian(agent, 30); vm.stopPrank();
        uint256 friday = block.timestamp;
        vm.warp(friday + 57 hours);
        ethFeed.set(2400e8, block.timestamp); // ETH moved over the weekend, the stock feed didn't update
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(KryoOracle.Stale.selector, address(nvda))); vault.guardTopUp(alice, 1 ether);
        // the fix: stock feeds get a 4-day max age (covers long weekends), ETH stays at 25 h
        oracle.setFeed(address(nvda), address(stockFeed), 4 days);
        vm.prank(agent); vault.guardTopUp(alice, 1 ether);
        assertEq(vault.buffer(alice), 1 ether);
    }

    // ---------------------------------------------------------------- finding: pushed prices compound
    /// The old oracle path caps each push at 25%, not each day: a stolen reporter key can multiply a price ~9x
    /// in ten pushes, seconds apart.
    function test_finding_oldPushCompounds() public {
        address ant = address(0xA17);
        address[] memory a = new address[](1); a[0] = ant; uint256[] memory p = new uint256[](1);
        p[0] = 85e8; vm.prank(reporter); oracle.push(a, p);
        for (uint256 i; i < 10; ++i) { p[0] = p[0] * 125 / 100; vm.prank(reporter); oracle.push(a, p); }
        assertGt(oracle.price(ant), 85e8 * 9);
    }

    /// KryoPushFeed: whatever the reporter pushes, within a day the price stays inside the daily band.
    function testFuzz_pushFeedDailyBand(uint256[20] memory moves) public {
        KryoPushFeed f = new KryoPushFeed("ANT / USD", reporter, 85e8, 1_000, 2_000);
        for (uint256 i; i < moves.length; ++i) {
            vm.warp(block.timestamp + 1 minutes);
            (, int256 cur,,,) = f.latestRoundData();
            uint256 c = uint256(cur);
            uint256 p = bound(moves[i], c * 85 / 100, c * 115 / 100);
            vm.prank(reporter); try f.push(p) {} catch {}
            (, int256 now_,,,) = f.latestRoundData();
            assertLe(uint256(now_), 85e8 * 12_000 / 10_000);
            assertGe(uint256(now_), 85e8 * 8_000 / 10_000);
        }
    }

    function test_pushFeed_windowRollsAndOwnerForces() public {
        KryoPushFeed f = new KryoPushFeed("ANT / USD", reporter, 100e8, 1_000, 2_000);
        vm.startPrank(reporter);
        f.push(110e8); f.push(120e8);
        vm.expectRevert(); f.push(121e8);            // outside today's band
        vm.warp(block.timestamp + 1 days);
        f.push(130e8);                               // new window anchored at 120
        vm.stopPrank();
        vm.prank(address(0xBAD)); vm.expectRevert(KryoPushFeed.NotReporter.selector); f.push(130e8);
        vm.prank(reporter); vm.expectRevert(KryoPushFeed.NotOwner.selector); f.force(1e8);
        f.force(200e8);
        (, int256 p,, uint256 at,) = f.latestRoundData();
        assertEq(p, 200e8); assertEq(at, block.timestamp);
        // the oracle reads it like any Chainlink feed
        address ant = address(0xA17);
        oracle.setFeed(ant, address(f), 1 hours);
        assertEq(oracle.price(ant), 200e8);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(KryoOracle.Stale.selector, ant)); oracle.price(ant);
    }

    function test_fixedFeed_usdgCannotBeMoved() public {
        assertEq(oracle.price(address(usdg)), 1e8);
        address[] memory a = new address[](1); a[0] = address(usdg); uint256[] memory p = new uint256[](1); p[0] = 2e8;
        vm.prank(reporter); oracle.push(a, p);          // writes the unused pushed slot...
        assertEq(oracle.price(address(usdg)), 1e8);     // ...the feed wins
    }

    // ---------------------------------------------------------------- exits
    /// Paused or with every price stale, a borrower can still repay and leave with all collateral.
    function test_exitWorksPausedAndStale() public {
        _open(10 ether, 100e18, 15_000);
        vault.setPaused(true);
        vm.warp(block.timestamp + 10 days); // every feed stale
        usdg.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        vault.repay(alice, type(uint256).max);
        vault.withdraw(ETH, type(uint256).max);
        vault.withdraw(address(nvda), type(uint256).max);
        vm.stopPrank();
        assertEq(vault.debtOf(alice), 0); assertEq(vault.collateral(alice, ETH), 0);
        vm.prank(lp); vault.unsupply(type(uint256).max);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    /// The rate compounds each time the vault is touched: 8% APR is ~8.33% effective when touched every block.
    function test_rateCompoundsWhenTouched() public {
        _open(10 ether, 0, 20_000);
        uint256 d0 = vault.debtOf(alice);
        for (uint256 i; i < 365; ++i) { vm.warp(block.timestamp + 1 days); ethFeed.set(3000e8, block.timestamp); vault.accrue(); }
        uint256 eff = ((vault.debtOf(alice) - d0) * 10_000) / d0;
        assertGe(eff, 800); assertLe(eff, 834);
    }
}
