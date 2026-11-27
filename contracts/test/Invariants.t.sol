// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/KryoOracle.sol";
import "../src/KryonarkVault.sol";
import {MockToken} from "./Vault.t.sol";

/// Random sequences of every user action, price moves and time; the invariants below must hold after each step.
contract Handler is Test {
    KryonarkVault public vault; KryoOracle public oracle; MockToken public usdg; MockToken public nvda;
    address public reporter; address public agent = address(0xA6);
    address[] public actors;
    address constant ETH = address(0);
    uint256 public ethPx = 3000e8; uint256 public stockPx = 150e8;
    uint256 public guardTopUps; uint256 public liquidations; uint256 public borrows;

    constructor(KryonarkVault v, KryoOracle o, MockToken u, MockToken n, address r) {
        vault = v; oracle = o; usdg = u; nvda = n; reporter = r;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0x1000 + i)); actors.push(a);
            vm.deal(a, 1_000 ether); nvda.mint(a, 1_000e18); usdg.mint(a, 10_000_000e6);
            vm.startPrank(a); nvda.approve(address(vault), type(uint256).max); usdg.approve(address(vault), type(uint256).max); vm.stopPrank();
        }
    }

    function actorCount() external view returns (uint256) { return actors.length; }
    function _a(uint256 s) internal view returns (address) { return actors[s % actors.length]; }

    function depositEth(uint256 s, uint256 amt) external { address a = _a(s); amt = bound(amt, 1, 50 ether); vm.prank(a); try vault.depositEth{value: amt}() {} catch {} }
    function depositStock(uint256 s, uint256 amt) external { address a = _a(s); amt = bound(amt, 1, 100e18); vm.prank(a); try vault.deposit(address(nvda), amt) {} catch {} }
    function withdraw(uint256 s, uint256 amt, bool eth) external { address a = _a(s); vm.prank(a); try vault.withdraw(eth ? ETH : address(nvda), bound(amt, 1, 200 ether)) {} catch {} }
    /// Borrows close to the limit, so prices moves push accounts into the guardian and liquidation ranges.
    function borrow(uint256 s, uint256 amt) external {
        address a = _a(s);
        try vault.accountValues(a) returns (uint256 collLT, uint256 debt8) {
            uint256 room8 = (collLT * 100) / 126; if (room8 <= debt8) return;
            uint256 max = (room8 - debt8) / 100; if (max == 0) return; // 8 → 6 decimals
            vm.prank(a); try vault.borrow(bound(amt, max / 2, max)) { borrows++; } catch {}
        } catch {}
    }
    function repay(uint256 s, uint256 amt) external { address a = _a(s); vm.prank(_a(s % 1000 + 1)); try vault.repay(a, bound(amt, 1, type(uint256).max)) {} catch {} }
    function supply(uint256 s, uint256 amt) external { vm.prank(_a(s)); try vault.supply(bound(amt, 1, 500_000e6)) {} catch {} }
    function unsupply(uint256 s, uint256 sh) external { vm.prank(_a(s)); try vault.unsupply(bound(sh, 1, type(uint256).max)) {} catch {} }
    function addBuffer(uint256 s, uint256 amt) external { vm.prank(_a(s)); try vault.depositBuffer{value: bound(amt, 1, 20 ether)}() {} catch {} }
    function takeBuffer(uint256 s, uint256 amt) external { vm.prank(_a(s)); try vault.withdrawBuffer(bound(amt, 1, type(uint256).max)) {} catch {} }
    function appoint(uint256 s, uint256 d) external { vm.prank(_a(s)); try vault.setGuardian(agent, bound(d, 1, 90)) {} catch {} }
    function revoke(uint256 s) external { vm.prank(_a(s)); vault.setGuardian(address(0), 0); }

    /// The guardian may only move an account's own ETH from buffer to collateral: nothing leaves, nothing else changes.
    function guard(uint256 s, uint256 amt) external {
        address a = _a(s);
        uint256 col = vault.collateral(a, ETH); uint256 buf = vault.buffer(a); uint256 st = vault.collateral(a, address(nvda));
        uint256 debt = vault.scaledDebt(a); uint256 bal = address(vault).balance; uint256 agentBal = agent.balance;
        vm.prank(agent);
        try vault.guardTopUp(a, bound(amt, 1, 50 ether)) {
            guardTopUps++;
            assertEq(vault.collateral(a, ETH) + vault.buffer(a), col + buf, "guardian changed the account's ETH");
            assertGt(vault.collateral(a, ETH), col, "guardian did not add");
            assertEq(vault.collateral(a, address(nvda)), st); assertEq(vault.scaledDebt(a), debt);
            assertEq(address(vault).balance, bal, "ETH left the vault"); assertEq(agent.balance, agentBal);
        } catch {}
    }

    function liquidate(uint256 s, uint256 amt, bool eth) external {
        vm.prank(_a(s % 1000 + 2)); try vault.liquidate(_a(s), eth ? ETH : address(nvda), bound(amt, 1, 10_000_000e6)) returns (uint256) { liquidations++; } catch {}
    }

    function movePrices(uint256 e, uint256 k) external {
        // within the oracle's 25% per push
        ethPx = bound(e, (ethPx * 76) / 100, (ethPx * 124) / 100); stockPx = bound(k, (stockPx * 76) / 100, (stockPx * 124) / 100);
        if (ethPx == 0) ethPx = 1; if (stockPx == 0) stockPx = 1;
        address[] memory a = new address[](3); a[0] = ETH; a[1] = address(nvda); a[2] = address(usdg);
        uint256[] memory p = new uint256[](3); p[0] = ethPx; p[1] = stockPx; p[2] = 1e8;
        vm.prank(reporter); oracle.push(a, p);
    }

    function warp(uint256 t) external {
        vm.warp(block.timestamp + bound(t, 1, 30 minutes));
        // keep prices fresh
        address[] memory a = new address[](3); a[0] = ETH; a[1] = address(nvda); a[2] = address(usdg);
        uint256[] memory p = new uint256[](3); p[0] = ethPx; p[1] = stockPx; p[2] = 1e8;
        vm.prank(reporter); oracle.push(a, p);
    }
}

contract InvariantTest is Test {
    KryonarkVault vault; KryoOracle oracle; MockToken usdg; MockToken nvda; Handler h;
    address constant ETH = address(0);

    function setUp() public {
        address reporter = address(0xAA);
        oracle = new KryoOracle(reporter);
        usdg = new MockToken("USDG", 6); nvda = new MockToken("NVDA", 18);
        vault = new KryonarkVault(address(oracle), address(usdg), 1_000_000e6);
        address[] memory a = new address[](3); a[0] = ETH; a[1] = address(nvda); a[2] = address(usdg);
        uint256[] memory p = new uint256[](3); p[0] = 3000e8; p[1] = 150e8; p[2] = 1e8;
        vm.prank(reporter); oracle.push(a, p);
        vault.listAsset(ETH, 8_000, 10_000 ether);
        vault.listAsset(address(nvda), 7_000, 1_000_000e18);
        h = new Handler(vault, oracle, usdg, nvda, reporter);
        targetContract(address(h));
    }

    /// Every wei of ETH in the vault is someone's collateral or buffer.
    function invariant_ethAccounted() public view { assertEq(address(vault).balance, _total(ETH) + vault.totalBuffer()); }
    /// Every stock token in the vault is someone's collateral.
    function invariant_stockAccounted() public view { assertEq(nvda.balanceOf(address(vault)), _total(address(nvda))); }
    /// The vault always holds the lenders' cash.
    function invariant_cashBacked() public view { assertEq(usdg.balanceOf(address(vault)), vault.cash()); }

    function invariant_sums() public view {
        uint256 sh; uint256 sd; uint256 col; uint256 buf; uint256 debts;
        for (uint256 i; i < h.actorCount(); ++i) {
            address a = h.actors(i);
            sh += vault.shares(a); sd += vault.scaledDebt(a); col += vault.collateral(a, ETH); buf += vault.buffer(a); debts += vault.debtOf(a);
        }
        assertEq(sh, vault.totalShares(), "shares"); assertEq(sd, vault.totalScaledDebt(), "scaled debt");
        assertEq(col, _total(ETH), "eth collateral"); assertEq(buf, vault.totalBuffer(), "buffer");
        assertGe(debts, vault.totalDebt(), "per-account debts cover the total");
    }

    function afterInvariant() public view {
        console.log("borrows", h.borrows(), "guard top-ups", h.guardTopUps());
        console.log("liquidations", h.liquidations());
    }

    function _total(address a) internal view returns (uint256 t) { (,,,, t) = vault.assets(a); }
}
