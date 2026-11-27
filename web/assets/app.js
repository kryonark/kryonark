// Kryonark · omnichain collateral engine (preview).
// Collateral prices are live (Coinbase spot, refreshed every 30 s); the portfolio itself is an example and nothing here touches a wallet or a chain.
const $ = (s) => document.querySelector(s);
const usd = (n) => "$" + (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K" : n.toFixed(2));
const L = (name) => `assets/logos/${name}.svg`;

// ---------- the book: collateral locked on its home chain, a stock position on Robinhood Chain ----------
// health = collateral value × liquidation threshold ÷ position value; below 1.00 the position can be liquidated
const LT = 0.8;
const PRICES = { SOL: 147.1, USDC: 1, BTC: 98420, ETH: 3315 };   // replaced by live spot prices as soon as they load
const BOOK = [
  { asset: "SOL", name: "Solana", logo: "sol", net: null, where: "on Solana", qty: 412.5, stock: "NVDA", stockLogo: "nvda", target: 1.82 },
  { asset: "USDC", name: "USD Coin", logo: "usdc", net: "base", where: "on Base", qty: 48000, stock: "AAPL", stockLogo: "aapl", target: 2.1 },
  { asset: "BTC", name: "Bitcoin", logo: "btc", net: null, where: "native BTC", qty: 0.62, stock: "AMZN", stockLogo: "amzn", target: 1.64 },
  { asset: "ETH", name: "Ether", logo: "eth", net: "arbitrum", where: "on Arbitrum", qty: 14.2, stock: "TSLA", stockLogo: "tsla", target: 1.91 },
];
// positions are sized once, from the first prices, so the example stays sensible at any price level; after that only the market moves health
const sizePositions = () => BOOK.forEach((r) => { r.pos = Math.round((r.qty * PRICES[r.asset] * LT) / r.target / 10) * 10; });
sizePositions();
const health = (r) => (r.qty * PRICES[r.asset] * LT) / r.pos;
const total = () => BOOK.reduce((a, r) => a + r.qty * PRICES[r.asset] * LT, 0) / BOOK.reduce((a, r) => a + r.pos, 0);

function render() {
  $("#assets").innerHTML = BOOK.map((r) => {
    const coll = r.qty * PRICES[r.asset], h = health(r);
    return `<li>
      <div class="asset"><span class="coin logo"><img src="${L(r.logo)}" alt="">${r.net ? `<img class="net" src="${L(r.net)}" alt="" title="${r.where}">` : ""}</span><span><b>${r.name}</b><small>${r.asset} ${r.where}</small></span></div>
      <div class="track"><div class="h"></div><div class="o" style="width:${Math.min(100, (r.pos / (coll * LT)) * 100).toFixed(1)}%"></div>
        <div class="lbl"><span>${usd(coll)} locked</span><span class="stk">${usd(r.pos)} <img src="${L(r.stockLogo)}" alt="">${r.stock}</span></div></div>
      <div class="pct" style="color:${h < 1.3 ? "#ffb14a" : "var(--ok)"}">${h.toFixed(2)}×</div>
    </li>`;
  }).join("");
  const hf = total().toFixed(2);
  $("#hf").textContent = hf; $("#hf-pill").textContent = hf;
}
render();

// ---------- live collateral prices ----------
let sized = false;
async function prices() {
  try {
    const got = await Promise.all(["SOL", "BTC", "ETH"].map(async (a) => {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${a}-USD/spot`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
      const v = +(await r.json()).data.amount; if (!(v > 0)) throw 0; return [a, v];
    }));
    for (const [a, v] of got) PRICES[a] = v;
    if (!sized) { sizePositions(); sized = true; }
    render();
    $("#px-note").textContent = `Example portfolio · live prices ${new Date().toISOString().slice(11, 16)} UTC`;
  } catch {
    $("#px-note").textContent = "Example portfolio · prices offline, showing last known";
  }
}
setInterval(() => { if (!document.hidden) prices(); }, 30_000);

// ---------- agent top-ups over the last 24 hours: bar height = buffer left that hour; orange = the hour the agent topped up ----------
const H = [0.86, 0.88, 0.87, 0.9, 0.89, 0.91, 0.9, 0.92, 0.9, 0.88, 0.86, 0.83, 0.8, 0.78, 0.74, 0.71, 0.69, 1, 0.97, 0.96, 0.95, 0.96, 0.95, 0.94];
const TOPUP = 17;
$("#bars").innerHTML = H.map((h, i) => `<i class="${i === TOPUP ? "now" : ""}" style="height:${h * 100}%" title="${String(i).padStart(2, "0")}:00 UTC · ${i === TOPUP ? "agent topped up 6,100 USDC from Base" : "checked, no action"}"></i>`).join("");

// ---------- health-check clock: the agent checks every second ----------
const clock = () => { const d = new Date(); $("#chk-time").textContent = d.toISOString().slice(11, 19) + " UTC"; $("#chk-next").textContent = (1 - d.getMilliseconds() / 1000).toFixed(1) + " s"; };
clock(); setInterval(clock, 100);

// ---------- intent → agent plan ----------
const STOCKS = Object.fromEntries(BOOK.map((r) => [r.stock, r]));
const ASSETS = Object.fromEntries(BOOK.map((r) => [r.asset, r]));
const money = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });
function plan(text) {
  const t = text.toUpperCase();
  const stock = Object.keys(STOCKS).find((s) => t.includes(s));
  const asset = Object.keys(ASSETS).find((a) => new RegExp(`\\b${a}\\b`).test(t)) || (stock && STOCKS[stock].asset);
  const pct = +(t.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1];
  if (/PROTECT|GUARD|SAFE|AMANKAN|LINDUNGI|JAGA/.test(t) && stock && asset && pct > 0 && pct < 90) {
    // at the trigger price, add enough USDC to bring this position back to the health it has now
    const r = STOCKS[stock], trig = PRICES[asset] * (1 - pct / 100), coll = asset === r.asset ? r.qty * trig : r.qty * PRICES[r.asset];
    const need = Math.max(0, (health(r) * r.pos) / LT - coll);
    return { ok: true, html: `If <b>${asset} &lt; ${money(trig)}</b>, move ${need > 0 ? (Math.ceil(need / 100) * 100).toLocaleString("en-US") : "no"} USDC from Base to your ${stock} position via <code>LayerZero</code>, signed by session key 0x4c1e…a92b.` };
  }
  if (/CLOSE|TUTUP/.test(t) && stock) { const r = STOCKS[stock]; return { ok: true, html: `Close <b>${stock}</b> on Robinhood Chain, repay ${usd(r.pos)}, then unlock ${r.qty.toLocaleString("en-US")} ${r.asset} ${r.where} via <code>LayerZero</code>.` }; }
  if (/YIELD|DIVIDEN|ROTATE|PUTAR/.test(t)) return { ok: true, html: `Every Friday 21:00 UTC, sweep stock-vault yield into <b>USDC on Base</b> and add it to the buffer. Session key scope: top-up and sweep only.` };
  return { ok: false, html: `The agent can't act on that yet. Try <b>"Protect NVDA if SOL drops 10%"</b>, <b>"Close TSLA"</b> or <b>"Rotate yield to USDC"</b>.` };
}
$("#verify").addEventListener("submit", (e) => {
  e.preventDefault();
  const r = $("#result"), t = $("#result-t"), p = plan($("#cid").value);
  r.classList.add("busy"); r.classList.remove("bad");
  setTimeout(() => { r.classList.remove("busy"); r.classList.toggle("bad", !p.ok); t.innerHTML = p.html; }, 600);
});
// the first answer matches today's prices
$("#result-t").innerHTML = plan($("#cid").value).html;
prices().then(() => ($("#result-t").innerHTML = plan($("#cid").value).html));

// ---------- token contract: set by the owner in /studio, hidden until then ----------
(async () => {
  const box = $("#ca-chip"); if (!box) return;
  try {
    const t = await (await fetch("/studio/api/token", { cache: "no-store" })).json();
    if (!t.live || !t.ca) return;
    $("#ca-sym").textContent = "$" + t.symbol;
    $("#ca-addr").textContent = innerWidth < 640 ? t.ca.slice(0, 6) + "…" + t.ca.slice(-4) : t.ca.slice(0, 10) + "…" + t.ca.slice(-8);
    $("#ca-buy").href = t.buy;
    $("#ca-copy").onclick = async () => { try { await navigator.clipboard.writeText(t.ca); $("#ca-copy").textContent = "Copied"; setTimeout(() => ($("#ca-copy").textContent = "Copy"), 1500); } catch {} };
    box.hidden = false;
  } catch {}
})();

// ---------- session key: revoke / re-enable the agent (preview: changes this page only, no transaction) ----------
(() => {
  const btn = $("#sk-toggle"); if (!btn) return;
  let paused = false;
  btn.addEventListener("click", () => {
    paused = !paused;
    btn.textContent = paused ? "Re-enable" : "Revoke";
    btn.setAttribute("aria-pressed", String(paused));
    $("#sk-state").textContent = paused ? "Revoked · agent paused" : "Top-up only · 30 days";
    $("#agent-state").textContent = paused ? "Agent paused" : "Agent online";
    $("#agent-dot").style.background = paused ? "#ffb14a" : "";
    $("#agent-dot").style.boxShadow = paused ? "0 0 6px rgba(255,177,74,.8)" : "";
    const r = $("#result"), tx = $("#result-t");
    r.classList.toggle("bad", paused);
    tx.innerHTML = paused ? "Session key revoked. The agent can't top up until you re-enable it. Your positions and buffer are unchanged." : plan($("#cid").value).html;
  });
  // while paused, intents are planned but not armed
  $("#verify").addEventListener("submit", () => { if (paused) setTimeout(() => { $("#result").classList.add("bad"); $("#result-t").innerHTML = "Agent paused. Re-enable the session key to arm this plan."; }, 650); });
})();
