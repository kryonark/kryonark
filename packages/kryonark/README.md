# kryonark

The engine behind [kryonark.xyz](https://kryonark.xyz): omnichain collateral for tokenized stocks on Robinhood Chain.
Health factors, the liquidation guard and plain-language intents, as a tiny library and a CLI. No dependencies, Node 18+.

```bash
npx kryonark
```

```
Kryonark · example book  (live prices, LT 0.8)
collateral                      position        health
412.5 SOL on Solana      $29,341   NVDA $12,900    1.82×
48,000 USDC on Base      $48,000   AAPL $18,290    2.10×
0.62 BTC on Bitcoin      $37,560   AMZN $18,320    1.64×
14.2 ETH on Arbitrum     $24,086   TSLA $10,090    1.91×
────────────────────────────────────────────────────────
book health 1.87×  liquidation at 1.00 · agent guards below 1.30
```

## CLI

| Command | What it does |
|---|---|
| `kryonark` | The example book at live prices, with each position's health |
| `kryonark plan "Protect NVDA if SOL drops 10%"` | What the AI agent would do (English or Indonesian) |
| `kryonark prices` | Live SOL, BTC and ETH spot (Coinbase) |
| `--json` | Machine-readable output for any command |

## Library

```js
import { spotPrices, exampleBook, health, bookHealth, plan } from "kryonark";

const prices = await spotPrices();              // { USDC: 1, SOL: …, BTC: …, ETH: … }
const book = exampleBook(prices);               // collateral on its home chain, stock positions on Robinhood Chain

health(book[0], prices);                        // 1.82  (collateral × 0.8 ÷ position)
bookHealth(book, prices);                       // the whole book

plan("Protect NVDA if SOL drops 10%", book, prices);
// { ok: true, kind: "protect", trigger: 64.02, usdc: 3000, text: "If SOL < $64.02, move 3,000 USDC from Base to your NVDA position …" }
```

| Export | |
|---|---|
| `health(position, prices, lt?)` | Collateral value × LT ÷ position value |
| `bookHealth(book, prices, lt?)` | Same, across every position |
| `status(h)` | `"safe"`, `"guard"` (below 1.30, the agent acts) or `"liquidatable"` (below 1.00) |
| `topUpNeeded(position, prices, target, price?)` | USDC needed to bring a position back to `target` if its collateral trades at `price` |
| `plan(intent, book, prices)` | Plain-language intent to an agent plan: protect, close, rotate yield |
| `spotPrices(assets?)` | Live USD spot from Coinbase (public, no key); USDC pinned at 1 |
| `exampleBook(prices)` / `EXAMPLE` | The example book shown on kryonark.xyz |
| `LT`, `LIQUIDATION`, `GUARD` | 0.8, 1.0, 1.3 |

Intents it understands: `Protect <STOCK> if <ASSET> drops <N>%` (also `Lindungi … kalau … turun …%`), `Close <STOCK>`, `Rotate yield to USDC`.

## Note

This is the engine's maths and intent layer. It does not hold keys, sign or send transactions. The book is an example; prices are live.

MIT · [kryonark.xyz](https://kryonark.xyz) · [GitHub](https://github.com/burningheadstd-coder/kryonark)
