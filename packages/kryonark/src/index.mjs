// kryonark · the engine behind kryonark.xyz
// Omnichain collateral for tokenized stocks on Robinhood Chain: health factors, the liquidation guard and plain-language intents.
// No dependencies. Prices come from Coinbase spot (public, no key); everything else is pure functions you can test.

/** Liquidation threshold: collateral counts at 80% of its value. */
export const LT = 0.8;

/** Health below this is liquidatable. */
export const LIQUIDATION = 1;

/** The agent tops a position up before it falls below this. */
export const GUARD = 1.3;

/**
 * Health of one position: collateral value × LT ÷ position value.
 * @param {{ qty: number, asset: string, pos: number }} p
 * @param {Record<string, number>} prices  USD per unit, e.g. { SOL: 147.1, USDC: 1 }
 */
export function health(p, prices, lt = LT) {
  const px = prices[p.asset];
  if (!(px > 0)) throw new Error(`No price for ${p.asset}`);
  if (!(p.pos > 0)) throw new Error("Position value must be above 0");
  return (p.qty * px * lt) / p.pos;
}

/** Health of a whole book (all collateral against all positions). */
export function bookHealth(book, prices, lt = LT) {
  const coll = book.reduce((a, p) => a + p.qty * prices[p.asset] * lt, 0);
  const pos = book.reduce((a, p) => a + p.pos, 0);
  return coll / pos;
}

/** Status of a health value: "safe", "guard" (the agent would act) or "liquidatable". */
export const status = (h) => (h < LIQUIDATION ? "liquidatable" : h < GUARD ? "guard" : "safe");

/**
 * USDC the agent must add so a position is back at `target` health,
 * if its collateral asset trades at `price` (defaults to today's price).
 */
export function topUpNeeded(p, prices, target, price = prices[p.asset], lt = LT) {
  const coll = p.qty * price;
  return Math.max(0, (target * p.pos) / lt - coll);
}

/** The example book shown on kryonark.xyz: collateral on its home chain, a stock position on Robinhood Chain. */
export const EXAMPLE = [
  { asset: "SOL", chain: "Solana", qty: 412.5, stock: "NVDA", target: 1.82 },
  { asset: "USDC", chain: "Base", qty: 48000, stock: "AAPL", target: 2.1 },
  { asset: "BTC", chain: "Bitcoin", qty: 0.62, stock: "AMZN", target: 1.64 },
  { asset: "ETH", chain: "Arbitrum", qty: 14.2, stock: "TSLA", target: 1.91 },
];

/** Sizes the example positions from today's prices, so health starts at each row's target and then moves with the market. */
export function exampleBook(prices, lt = LT) {
  return EXAMPLE.map((r) => ({ ...r, pos: Math.round((r.qty * prices[r.asset] * lt) / r.target / 10) * 10 }));
}

/**
 * Live USD spot prices from Coinbase. USDC is pinned at 1.
 * @param {string[]} assets e.g. ["SOL", "BTC", "ETH"]
 */
export async function spotPrices(assets = ["SOL", "BTC", "ETH"], { timeout = 8000 } = {}) {
  const out = { USDC: 1 };
  await Promise.all(assets.filter((a) => a !== "USDC").map(async (a) => {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${a}-USD/spot`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`Coinbase ${a}: HTTP ${r.status}`);
    const v = +(await r.json()).data.amount;
    if (!(v > 0)) throw new Error(`Coinbase ${a}: bad price`);
    out[a] = v;
  }));
  return out;
}

const money = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });

/**
 * Turns a plain-language intent into the agent's plan. English and Indonesian.
 *   "Protect NVDA if SOL drops 10%"     → trigger price and the USDC top-up
 *   "Lindungi AAPL kalau USDC turun 5%" → same, in Indonesian
 *   "Close TSLA"                        → repay and unlock
 *   "Rotate yield to USDC"              → weekly yield sweep
 * @returns {{ ok: boolean, kind: string, text: string, [k: string]: any }}
 */
export function plan(intent, book, prices) {
  const t = String(intent).toUpperCase();
  const stocks = Object.fromEntries(book.map((p) => [p.stock, p]));
  const stock = Object.keys(stocks).find((s) => new RegExp(`\\b${s}\\b`).test(t));
  const asset = [...new Set(book.map((p) => p.asset))].find((a) => new RegExp(`\\b${a}\\b`).test(t)) || (stock && stocks[stock].asset);
  const pct = +(t.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1];

  if (/PROTECT|GUARD|SAFE|AMANKAN|LINDUNGI|JAGA/.test(t) && stock && asset && pct > 0 && pct < 90) {
    const p = stocks[stock], trigger = prices[asset] * (1 - pct / 100);
    const price = asset === p.asset ? trigger : prices[p.asset];
    const usdc = Math.ceil(topUpNeeded(p, prices, health(p, prices), price) / 100) * 100;
    return { ok: true, kind: "protect", stock, asset, trigger, usdc,
      text: `If ${asset} < ${money(trigger)}, move ${usdc > 0 ? usdc.toLocaleString("en-US") : "no"} USDC from Base to your ${stock} position via LayerZero, signed by the agent's session key.` };
  }
  if (/CLOSE|TUTUP/.test(t) && stock) {
    const p = stocks[stock];
    return { ok: true, kind: "close", stock, repay: p.pos, unlock: p.qty, asset: p.asset,
      text: `Close ${stock} on Robinhood Chain, repay ${money(p.pos)}, then unlock ${p.qty.toLocaleString("en-US")} ${p.asset} on ${p.chain} via LayerZero.` };
  }
  if (/YIELD|DIVIDEN|ROTATE|PUTAR/.test(t)) {
    return { ok: true, kind: "rotate", text: "Every Friday 21:00 UTC, sweep stock-vault yield into USDC on Base and add it to the buffer. Session key scope: top-up and sweep only." };
  }
  return { ok: false, kind: "unknown", text: `Can't act on that yet. Try "Protect NVDA if SOL drops 10%", "Close TSLA" or "Rotate yield to USDC".` };
}
