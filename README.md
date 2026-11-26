# Kryonark

**Trade stocks from any chain.** Kryonark is an omnichain collateral engine for tokenized stocks on Robinhood Chain: lock SOL, BTC or USDC on the chain where it already lives, open stock positions on Robinhood Chain in one signature, and let an AI agent top up collateral before a position can be liquidated.

[kryonark.xyz](https://kryonark.xyz) · [npm](https://www.npmjs.com/package/kryonark) · `npx kryonark`

![Kryonark](web/assets/og.jpg)

## What is in this repo

| Folder | What it is |
|---|---|
| [`web/`](web) | The site at kryonark.xyz. Static HTML, CSS and JS, no build step. A real-time 3D ice vault (three.js, bundled), live collateral prices, health factors and the intent box. |
| [`studio/`](studio) | The owner panel at kryonark.xyz/studio: set the token CA (it then shows on the site), a buyback wallet (encrypted on the server), buyback and burn, supply burn, history. Node + ethers. |
| [`packages/kryonark/`](packages/kryonark) | The engine as an npm package and CLI: health factors, the liquidation guard, plain-language intents, live prices. No dependencies. |
| [`deploy/`](deploy) | nginx config and the deploy script for the VPS. |

## The engine

- **Health** = collateral value × 0.8 ÷ position value. Below 1.00 a position can be liquidated; below 1.30 the agent steps in.
- **Collateral stays home.** SOL on Solana, USDC on Base, BTC on Bitcoin, ETH on Arbitrum; positions (NVDA, AAPL, AMZN, TSLA) live on Robinhood Chain.
- **The agent** reads prices every block and moves USDC from the buffer you allowed, through a session key that can only add collateral.
- **Intents in plain words**, English or Indonesian:
  - `Protect NVDA if SOL drops 10%`
  - `Lindungi AAPL kalau USDC turun 5%`
  - `Close TSLA`
  - `Rotate yield to USDC`

```bash
npx kryonark                                   # live example book
npx kryonark plan "Protect NVDA if SOL drops 10%"
```

## Run locally

```bash
# site
cd web && python3 -m http.server 5820          # http://127.0.0.1:5820

# studio (needs Node 18+)
cd studio && npm install && PORT=5830 node server/server.mjs   # http://127.0.0.1:5830/studio
# the studio key is generated on first start in studio/data/burn/secrets.json (never commit data/)

# engine
cd packages/kryonark && npm test && node bin/kryonark.mjs
```

## Deploy

`deploy/deploy.sh` syncs `web/` to `/var/www/kryonark/web` and runs the studio under pm2 on `127.0.0.1:5830`.
nginx (`deploy/nginx-kryonark.conf`) serves the site and proxies `/studio` to the studio. TLS via Let's Encrypt.

## Status

The site's portfolio is an example with live collateral prices; the agent on the page is a simulation. Nothing here holds user funds. The studio's buyback and burn send real transactions from the owner's own wallet, capped per run and per day.

## Credits

- 3D: [three.js](https://threejs.org) r160 (MIT), bundled in `web/assets/vendor/three`.
- Network and token logos: [web3icons](https://github.com/0xa3k5/web3icons) (MIT). Stock logos: [Simple Icons](https://simpleicons.org) (CC0). Brand logos stay the property of their owners and are used only to name the networks and assets involved.

MIT
