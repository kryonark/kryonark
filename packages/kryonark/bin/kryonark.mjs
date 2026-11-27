#!/usr/bin/env node
// npx kryonark                    protocol totals, prices and the agent, live from Robinhood Chain
// npx kryonark account 0x…        one account's collateral, debt and health
// npx kryonark agent              the agent's heartbeat
// add --json for machine-readable output
import { protocol, account, agent } from "../src/index.mjs";
const args = process.argv.slice(2), json = args.includes("--json"), [cmd, arg] = args.filter((a) => !a.startsWith("--"));
const usd = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const h = (x) => (isFinite(x) ? x.toFixed(2) : "∞");
const out = (o, text) => console.log(json ? JSON.stringify(o, null, 2) : text);
try {
  if (cmd === "account") {
    if (!arg) throw new Error("usage: npx kryonark account 0xAddress");
    const a = await account(arg);
    out(a, [`${a.address}`, ...a.collateral.map((c) => `  ${c.amount} ${c.symbol}  ${usd(c.amount * c.usd)}  (counts ${Math.round(c.weight * 100)}%)`),
      `  debt     ${a.debt.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${a.debtSymbol}`, `  buffer   ${a.buffer} ETH`,
      `  guardian ${a.guardian ? a.guardian.agent + " until " + a.guardian.expiry.slice(0, 10) : "none"}`,
      `  health   ${h(a.health)} (${a.status})   can borrow ${usd(a.borrowable)} more`].join("\n"));
  } else if (cmd === "agent") {
    const s = await agent();
    out(s, `agent ${s.agent} · ${s.online ? "online" : "offline"} · ${s.checks24h ?? 0} checks in 24 h · ${s.guarded ?? 0} accounts guarded · ${(s.actions || []).length} recent top-ups`);
  } else {
    const p = await protocol();
    let s = null; try { s = await agent(); } catch {}
    out({ ...p, agent: s && { online: s.online, checks24h: s.checks24h, guarded: s.guarded } }, [
      `Kryonark on ${p.network}${p.paused ? " (paused)" : ""} · vault ${p.vault}`,
      ...p.assets.map((a) => `  ${a.symbol.padEnd(5)} ${usd(a.usd).padStart(11)}   ${a.deposited} deposited   counts ${Math.round(a.weight * 100)}%${a.priceOk ? "" : "   price stale"}`),
      `  ${p.lendPool.symbol} pool: ${p.lendPool.cash.toLocaleString("en-US")} available, ${p.lendPool.borrowed.toLocaleString("en-US")} borrowed at ${p.apr}% a year`,
      `  deposited ${usd(p.depositedUsd)} · borrowed ${usd(p.borrowedUsd)}`,
      `  agent: ${s ? (s.online ? `online, ${s.checks24h} checks in 24 h, ${s.guarded} accounts guarded` : "offline") : "unreachable"}`].join("\n"));
  }
} catch (e) { console.error("kryonark: " + e.message); process.exit(1); }
