#!/usr/bin/env node
// kryonark CLI · the kryonark.xyz engine in your terminal
//   kryonark                       live example book: collateral, positions, health
//   kryonark plan "<intent>"       what the agent would do
//   kryonark prices                live SOL, BTC, ETH spot
//   add --json for machine-readable output
import { spotPrices, exampleBook, health, bookHealth, status, plan, LT } from "../src/index.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const rest = args.filter((a) => a !== "--json");
const cmd = rest[0] || "book";
const tty = process.stdout.isTTY && !json;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const usd = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 0 });

async function main() {
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(`kryonark · omnichain collateral for tokenized stocks on Robinhood Chain

  kryonark                      live example book with health factors
  kryonark plan "<intent>"      e.g. kryonark plan "Protect NVDA if SOL drops 10%"
  kryonark prices               live SOL, BTC, ETH spot (Coinbase)
  --json                        machine-readable output

https://kryonark.xyz`);
    return;
  }
  const prices = await spotPrices();
  if (cmd === "prices") {
    if (json) return console.log(JSON.stringify(prices));
    for (const [a, v] of Object.entries(prices)) console.log(`${a.padEnd(5)} ${usd(v)}`);
    return;
  }
  const book = exampleBook(prices);
  if (cmd === "plan") {
    const r = plan(rest.slice(1).join(" "), book, prices);
    if (json) return console.log(JSON.stringify(r));
    console.log((r.ok ? c(32, "✓ ") : c(31, "✗ ")) + r.text);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const rows = book.map((p) => ({ ...p, collateral: p.qty * prices[p.asset], health: health(p, prices) }));
  if (json) return console.log(JSON.stringify({ lt: LT, prices, book: rows, health: bookHealth(book, prices) }));
  console.log(c(1, "Kryonark · example book") + c(90, `  (live prices, LT ${LT})`));
  console.log(c(90, "collateral                      position        health"));
  for (const r of rows) {
    const h = r.health.toFixed(2) + "×", col = status(r.health) === "safe" ? 32 : status(r.health) === "guard" ? 33 : 31;
    console.log(`${(r.qty.toLocaleString("en-US") + " " + r.asset + " on " + r.chain).padEnd(24)}${usd(r.collateral).padStart(8)}   ${(r.stock + " " + usd(r.pos)).padEnd(14)}  ${c(col, h)}`);
  }
  const b = bookHealth(book, prices);
  console.log(c(90, "─".repeat(56)));
  console.log(`book health ${c(1, b.toFixed(2) + "×")}  ${c(90, "liquidation at 1.00 · agent guards below 1.30")}`);
}
main().catch((e) => { console.error(c(31, "kryonark: ") + (e.message || e)); process.exit(1); });
