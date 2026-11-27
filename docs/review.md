# Kryonark internal security review

**Not an external audit.** This review was done by the team that wrote the code. It covers what we checked, the tests that check it, what we found and what we changed. An independent audit is still to come; its report will be linked here and on [kryonark.xyz/security](https://kryonark.xyz/security).

- **Date:** 27 November 2026
- **Scope:** `contracts/src/KryonarkVault.sol` and `contracts/src/KryoOracle.sol`, as deployed on Robinhood Chain mainnet (4663) at `0x857C224f9896c9A0F17f564D9C8Ba9Cf73802764` and `0xBbeAd3C159b4f722a059bB508F51a01944Db41c8` (Sourcify exact match). Also the new `src/feeds/FixedFeed.sol` and `src/feeds/KryoPushFeed.sol`, and the agent's on-chain behaviour (`agent/agent.mjs`).
- **Method:**
  - a line-by-line manual review;
  - `forge lint` static analysis;
  - 23 Foundry unit and fuzz tests, plus 4 invariants running 256 × 500 random calls across every user action, price moves and time;
  - historical reads of the Chainlink feeds on Robinhood Chain;
  - a dry run of every fix on a local fork of mainnet.

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Stock prices go stale over weekends, freezing the guardian when it's needed most | High | Fix ready: stock feeds accept prices up to 4 days old |
| 2 | Pushed prices (ANT, USDG) are capped per update, not per day: a stolen agent key can compound them | High | Fix ready: USDG fixed at $1.00, ANT on a feed limited to 10%/update and 20%/day, old push path switched off |
| 3 | Bad debt isn't socialised: the last lenders to leave carry it | Medium | Documented; caps stay small |
| 4 | Liquidations continue while paused; deposits don't | Low | Documented; guardian top-ups and repaying keep working |
| 5 | The rate compounds whenever the vault is touched (8% APR ≈ 8.3% effective) | Info | Docs corrected |
| 6 | Owner powers: feeds, `force`, caps, rate, pause | Info | Documented; multisig + timelock before caps rise |
| 7 | Stock Token issuer powers: pause, blocklist, burn | Info | Documented |

"Fix ready" means the change is tested and in the repo. The owner applies it on chain from the studio (panel 00b) in about 12 transactions, and this page will then say "Fixed" with the transaction links. None of the fixes redeploy the vault: the vault reads prices through `KryoOracle`, and the oracle lets the owner point each asset at a different feed.

## Findings

### 1. Weekend staleness blocks the guardian (High)

`KryoOracle.price()` refuses a Chainlink answer older than the feed's `maxAge`. All feeds were set to 90 000 s (25 h).

Chainlink's stock feeds on Robinhood Chain stop updating while markets are closed. Walking back 400 rounds of `Robinhood AAPL / USD` shows a 57.4 h gap from Friday 23 October to Monday 26 October. Long weekends are longer still.

So every weekend, for any account holding a Stock Token:

- `healthOf` reverts;
- `guardTopUp` reverts, which means the agent can't act over exactly the gap where crypto keeps moving and stocks don't;
- `borrow` and `withdraw` revert (repay-then-withdraw still works, see test `test_exitWorksPausedAndStale`);
- liquidations revert.

**Test:** `test_finding_weekendBlocksGuardianAt25h`.

**Fix:** `setFeed(stock, sameAggregator, 4 days)` for each stock, the maximum the oracle allows. ETH stays at 25 h because ETH trades all weekend.

**Trade-off:** over a weekend the vault values stocks at Friday's close. That is the market's own last price, and the 1.25 borrow limit and 1.30 guardian line exist for this gap.

### 2. Pushed prices compound (High)

`KryoOracle.push` limits each update to `maxJumpBps` (25%) from the previous price, but not how often updates happen. The reporter is the agent's hot key on a server. If that key were stolen, ten pushes a few seconds apart could move ANT about 9× up or down, and the same goes for USDG, the debt asset itself. That is enough to borrow against inflated collateral, or to make healthy accounts liquidatable.

**Test:** `test_finding_oldPushCompounds`.

**Fix:**

- **USDG** reads `FixedFeed`: a constant $1.00 that no key can move. If USDG ever depegs, the owner can point it at a real feed.
- **ANT** reads `KryoPushFeed`. The agent pushes Robinhood's token quote, limited to 10% from the last update **and** 20% from the price the current 24 h window opened at. A stolen key can move ANT at most 20% a day.

  A real move beyond the band makes pushes revert. The price then goes stale and the vault stops borrowing and liquidating on it, until the owner checks the move and calls `force`.
- The oracle's reporter is set to none, so the old path is closed.

**Tests:** `testFuzz_pushFeedDailyBand` (20 random pushes a minute apart never leave the ±20% band), `test_pushFeed_windowRollsAndOwnerForces` and `test_fixedFeed_usdgCannotBeMoved`. A fork dry run confirmed that a +30% push is refused, a +5% push is accepted, and the old path reverts.

### 3. Bad debt isn't socialised (Medium)

If collateral falls below debt faster than liquidators act, liquidation stops once the collateral is gone, and the remaining debt stays on the account. Lender shares are priced on `cash + totalDebt`, which still counts that debt. Lenders who withdraw first get full value from cash. The last ones are left with a claim on debt that won't be repaid.

**Mitigation:**

- small caps ($10 000 borrow cap, 10 ETH, 50 tokens per stock);
- liquidation from health 1.00 with a 5% bonus;
- the 1.25 opening line.

A write-off mechanism should come with the audit, before caps rise.

### 4. Liquidations continue while paused (Low)

`setPaused` blocks deposits, borrowing and supplying. It does not block repaying, withdrawing or liquidating. A borrower can't add new collateral during a pause, but they can still repay, and their guardian can still move their buffer in. That is why the buffer exists. Documented on the security page.

### 5. Effective rate (Info)

`accrue()` compounds `borrowIndex` each time the vault is touched. At one touch a day, 8% APR comes to 8.33% effective (`test_rateCompoundsWhenTouched`). The docs now say so.

### 6. Owner powers (Info)

The owner can:

- list assets, set weights (at most 90%) and caps;
- set the rate (at most 50%) and the borrow cap;
- pause;
- set or replace any price feed, and `force` a pushed price.

No function sends users' collateral, buffers or lender cash to the owner. The owner's power is indirect but real: a malicious or stolen owner key could:

- set prices (a new feed, or `force`) to liquidate accounts;
- list a worthless token and borrow the pool's cash against it.

This is why the caps are small, and why the owner must move to a multisig with a timelock: the timelock lets users see a change coming and leave first. The owner is a single wallet today. It moves to a Safe multisig behind a timelock before the caps rise (Safe 1.4.1 is deployed on Robinhood Chain).

### 7. Stock Token issuer powers (Info)

Robinhood's Stock Tokens are upgradeable `BeaconProxy` contracts with pause, blocklist and `adminBurn`. If the vault or a user were blocklisted, that token couldn't move. Stated on the security page.

## Properties checked

The invariant suite (`test/Invariants.t.sol`) runs 256 runs of 500 random calls: deposit, withdraw, borrow, repay, supply, unsupply, buffer, guardian, liquidate, price moves and time. After every call:

- the vault's ETH equals all ETH collateral plus all buffers;
- the vault's Stock Tokens equal all stock collateral;
- the vault's USDG equals `cash` (borrowed USDG is accounted as debt);
- the sum of shares, scaled debt, collateral and buffers per account equals the totals;
- the sum of per-account debts is at least the total debt (rounding favours lenders);
- every successful `guardTopUp` keeps the account's collateral + buffer unchanged, adds to collateral, sends no ETH out of the vault, and touches nothing else.

Fuzz tests add:

- the guardian is refused only when health ≥ 1.30;
- a guardian can't withdraw, unsupply, take a buffer or liquidate a healthy account, and can do nothing after it is revoked or has expired;
- a liquidator repays at most half the debt and receives at most 5% over the repaid value.

## Static analysis

`forge lint` flags reentrancy and event-ordering patterns on `_pull` and `_send`. Every external entry point that moves funds is `nonReentrant`, and state is written before ETH is sent. These flags are false positives here.

It also flags:

- a division before multiplication in `liquidate`: precision loss of at most 1e-8 USD, in the protocol's favour;
- the strict balance check in `_pull`: intentional, it rejects fee-on-transfer tokens.

## Reproduce

```bash
cd contracts
forge test                      # unit, fuzz and invariant tests
forge test --match-contract Review -vv
forge lint src
```
