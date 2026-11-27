# kryonark

Read the live [Kryonark](https://kryonark.xyz) vault on Robinhood Chain: collateral, debt, health and the guardian agent. CLI and library, no dependencies, Node 18+.

```sh
npx kryonark                      # protocol totals, prices and the agent
npx kryonark account 0xYourAddr   # collateral, debt, buffer, guardian and health
npx kryonark agent                # the agent's heartbeat
npx kryonark --json               # machine-readable
```

```js
import { protocol, account, health, borrowable } from "kryonark";

const p = await protocol();               // live from the chain
const a = await account("0x…");           // { collateral, debt, health, status, borrowable, guardian }
health([{ amount: 1, usd: 3000, weight: 0.8 }], 1500); // 1.6
```

## How Kryonark works

Deposit ETH and Robinhood Stock Tokens as collateral and borrow dollars against them. **Health = Σ(value × weight) ÷ debt**; ETH counts 80%, Stock Tokens 70%. Borrowing and withdrawing must leave health at 1.25 or more, and below 1.00 an account can be liquidated.

You can appoint a guardian agent. The vault lets it do one thing: move your own ETH buffer into your collateral while health is below 1.30. It can't withdraw, borrow or touch anything else.

Contract addresses and listed assets are read from `https://kryonark.xyz/assets/network.json`; set `KRYONARK_NETWORK` to use another config.

Not for US persons (Robinhood Stock Tokens may not be offered to them). The contracts are open source with tests but not externally audited yet; see [kryonark.xyz/security](https://kryonark.xyz/security).

MIT · [github.com/kryonark/kryonark](https://github.com/kryonark/kryonark)
