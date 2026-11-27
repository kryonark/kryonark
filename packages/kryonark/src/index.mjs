// kryonark · read the live Kryonark vault on Robinhood Chain. No dependencies, Node 18+.
// Network, contract addresses and listed assets come from https://kryonark.xyz/assets/network.json
// (override with KRYONARK_NETWORK=<url> or pass { network } to each call).

export const NETWORK_URL = "https://kryonark.xyz/assets/network.json";
export const OPEN_HEALTH = 1.25;   // minimum health after borrowing or withdrawing
export const GUARD_HEALTH = 1.3;   // the guardian agent tops up below this
export const LIQUIDATION = 1.0;    // below this an account can be liquidated

/** Health = Σ(value × weight) ÷ debt. Infinity without debt. */
export function health(collateral, debtUsd) {
  const c = collateral.reduce((a, x) => a + x.amount * x.usd * x.weight, 0);
  return debtUsd > 0 ? c / debtUsd : Infinity;
}
/** Dollars that can still be borrowed while staying at OPEN_HEALTH. */
export function borrowable(collateral, debtUsd) {
  return Math.max(0, collateral.reduce((a, x) => a + x.amount * x.usd * x.weight, 0) / OPEN_HEALTH - debtUsd);
}
export function status(h) { return h < LIQUIDATION ? "liquidatable" : h < GUARD_HEALTH ? "guard" : "safe"; }

// ---- minimal ABI encoding for the handful of view calls we need
const SEL = {
  assets: "0xf11b8188", collateral: "0xcc218ece", debtOf: "0xd283e75f", healthOf: "0xb1fbbac9", buffer: "0x72e3ddaa", guardians: "0x0633b14a",
  cash: "0x961be391", totalDebt: "0xfc7b9c18", totalBuffer: "0xec25cf34", aprBps: "0x25ac1df2", paused: "0x5c975abb", peek: "0xacefafae",
};
export const encodeAddress = (a) => { if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("bad address " + a); return a.slice(2).toLowerCase().padStart(64, "0"); };
export const words = (hex) => (hex.slice(2).match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
const fmt = (x, d) => Number(x) / 10 ** d;

let id = 0;
async function call(rpc, to, data) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return words(j.result);
}

export async function network(url = process.env.KRYONARK_NETWORK || NETWORK_URL) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`network config ${r.status}`);
  const n = await r.json(); if (!n.vault) throw new Error("the vault isn't deployed yet"); return n;
}

/** Protocol totals, prices and listed assets, live from the chain. */
export async function protocol({ network: n } = {}) {
  n ||= await network();
  const v = n.vault, o = n.oracle, c = (to, d) => call(n.rpc, to, d);
  const [[cash], [debt], [buf], [apr], [paused], usdPx] = await Promise.all([c(v, SEL.cash), c(v, SEL.totalDebt), c(v, SEL.totalBuffer), c(v, SEL.aprBps), c(v, SEL.paused), c(o, SEL.peek + encodeAddress(n.usd.address))]);
  const assets = await Promise.all(n.collateral.map(async (a) => {
    const [m, p] = await Promise.all([c(v, SEL.assets + encodeAddress(a.address)), c(o, SEL.peek + encodeAddress(a.address))]);
    return { symbol: a.symbol, name: a.name, address: a.address, weight: Number(m[2]) / 1e4, deposited: fmt(m[4], a.decimals), cap: fmt(m[3], a.decimals), usd: fmt(p[0], 8), priceAt: Number(p[1]) * 1000, priceOk: p[2] === 1n };
  }));
  const usd = fmt(usdPx[0], 8) || 1, d = n.usd.decimals;
  return {
    network: n.chainName, chainId: n.chainId, vault: v, oracle: o, paused: paused === 1n, apr: Number(apr) / 100,
    lendPool: { symbol: n.usd.symbol, cash: fmt(cash, d), borrowed: fmt(debt, d) },
    buffer: fmt(buf, 18), assets, depositedUsd: assets.reduce((a, x) => a + x.deposited * x.usd, 0), borrowedUsd: fmt(debt, d) * usd,
  };
}

/** One account: collateral, debt, buffer, guardian and health, live from the chain. */
export async function account(address, { network: n } = {}) {
  n ||= await network();
  const v = n.vault, A = encodeAddress(address), c = (d) => call(n.rpc, v, d);
  const p = await protocol({ network: n });
  const [[debt], [buf], g] = await Promise.all([c(SEL.debtOf + A), c(SEL.buffer + A), c(SEL.guardians + A)]);
  const collateral = await Promise.all(n.collateral.map(async (a, i) => {
    const [amt] = await c(SEL.collateral + A + encodeAddress(a.address));
    return { symbol: a.symbol, amount: fmt(amt, a.decimals), usd: p.assets[i].usd, weight: p.assets[i].weight };
  }));
  const usdPx = p.borrowedUsd && p.lendPool.borrowed ? p.borrowedUsd / p.lendPool.borrowed : 1;
  const debtUsd = fmt(debt, n.usd.decimals) * usdPx, h = health(collateral, debtUsd);
  const agent = "0x" + g[0].toString(16).padStart(40, "0"), expiry = Number(g[1]) * 1000;
  return {
    address, collateral: collateral.filter((x) => x.amount > 0), debt: fmt(debt, n.usd.decimals), debtSymbol: n.usd.symbol, debtUsd,
    buffer: fmt(buf, 18), guardian: /^0x0+$/.test(agent) || expiry < Date.now() ? null : { agent, expiry: new Date(expiry).toISOString() },
    health: h, status: status(h), borrowable: borrowable(collateral, debtUsd),
  };
}

/** The Kryonark agent's live heartbeat. */
export async function agent(url = "https://kryonark.xyz/agent/api/status") {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`agent ${r.status}`); return r.json();
}
