// Kryonark app. Everything on this page is read from, or sent to, the KryonarkVault and KryoOracle contracts on
// Robinhood Chain (addresses in assets/network.json) and the Kryonark agent's live status (/agent/api/status).
// Nothing is simulated: without a wallet the page shows protocol totals; without an agent heartbeat it says "offline".
(() => {
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let E = null;
const fmtUsd = (n) => (n == null || !isFinite(n) ? "–" : "$" + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + "K" : n.toLocaleString("en-US", { minimumFractionDigits: n && Math.abs(n) < 10 ? 2 : 0, maximumFractionDigits: 2 })));
const fmtNum = (n, d = 4) => (n == null || !isFinite(n) ? "–" : (+n).toLocaleString("en-US", { maximumFractionDigits: d }));
const fmtH = (h) => (h == null ? "–" : !isFinite(h) || h > 99 ? "∞" : h.toFixed(2));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LOGO = (name) => `assets/logos/${name}.svg`;
const ZERO = "0x0000000000000000000000000000000000000000";
const OPEN_HEALTH = 1.25, GUARD = 1.3;

const VAULT_ABI = [
  "function assets(address) view returns (bool listed, uint8 decimals, uint16 ltBps, uint256 cap, uint256 total)",
  "function collateral(address,address) view returns (uint256)", "function debtOf(address) view returns (uint256)",
  "function healthOf(address) view returns (uint256)", "function buffer(address) view returns (uint256)",
  "function guardians(address) view returns (address agent, uint64 expiry)", "function shares(address) view returns (uint256)",
  "function totalShares() view returns (uint256)", "function cash() view returns (uint256)", "function totalDebt() view returns (uint256)",
  "function totalBuffer() view returns (uint256)", "function aprBps() view returns (uint256)", "function borrowCap() view returns (uint256)",
  "function paused() view returns (bool)",
  "function depositEth() payable", "function deposit(address,uint256)", "function withdraw(address,uint256)",
  "function borrow(uint256)", "function repay(address,uint256) returns (uint256)",
  "function supply(uint256) returns (uint256)", "function unsupply(uint256) returns (uint256)",
  "function depositBuffer() payable", "function withdrawBuffer(uint256)", "function setGuardian(address,uint256)",
  "error NotOwner()", "error IsPaused()", "error NotListed()", "error Unhealthy(uint256 health)", "error Healthy(uint256 health)", "error Amount()",
  "error Cap()", "error Liquidity()", "error NotGuardian()", "error Expired()", "error TransferFailed()", "error Reentrancy()",
  "error Stale(address asset)", "error BadPrice(address asset)",
];
const ORACLE_ABI = ["function peek(address) view returns (uint256 p, uint256 at, bool ok)", "function feeds(address) view returns (address aggregator, uint32 maxAge)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function faucet(uint256)"];

let NET = null, rp = null, vaultR = null, oracleR = null;
const S = { ok: false, assets: [], usdPx: 1, cash: 0, debt: 0, apr: 0, buf: 0, paused: false, shares: 0, cap: 0 };
let ME = null;   // { address, eth, col: {SYM: amt}, wallet: {SYM: amt}, usdBal, debt, buffer, guardian, lend }
let AGENT = null;

// ------------------------------------------------------------------ boot
async function boot() {
  E = window.ethers;
  try { NET = await (await fetch("assets/network.json", { cache: "no-store" })).json(); } catch { NET = null; }
  status(); setInterval(() => { if (!document.hidden) status(); }, 4000);
  if (!NET || !NET.vault || !E) {
    $("#px-note").textContent = "The vault contracts are being deployed";
    $("#assets").innerHTML = `<li class="empty">The vault isn't live yet. This panel fills in from the contracts as soon as they are.</li>`;
    return;
  }
  $("#net-eyebrow").textContent = NET.chainName;
  $("#st-block").textContent = NET.blockMs ? `~${NET.blockMs} ms` : "–";
  $("#usd-sym").textContent = NET.usd.symbol;
  rp = new E.JsonRpcProvider(NET.rpc, NET.chainId, { staticNetwork: true, batchMaxCount: 25 });
  vaultR = new E.Contract(NET.vault, VAULT_ABI, rp);
  oracleR = new E.Contract(NET.oracle, ORACLE_ABI, rp);
  $("#col-asset").innerHTML = NET.collateral.map((a) => `<option value="${a.symbol}">${a.symbol} · ${esc(a.name)}</option>`).join("");
  foot();
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 8000);
  autoReconnect();
}

function foot() {
  const parts = [];
  if (NET.testnet) parts.push(`Testnet: <button type="button" data-act="faucet">get 1,000 ${esc(NET.usd.symbol)}</button> · <a href="${NET.faucet}" target="_blank" rel="noopener">test ETH and stock tokens</a>`);
  parts.push(`Prices: ${NET.testnet ? "Coinbase and Robinhood, pushed by the agent" : "Chainlink"} · <a href="${NET.explorer}/address/${NET.vault}" target="_blank" rel="noopener">vault contract</a>`);
  $("#act-foot").innerHTML = parts.join("<br>");
}

// ------------------------------------------------------------------ chain reads
const unit = (x, d) => +E.formatUnits(x, d);
let seq = 0;
async function refresh() {
  const id = ++seq;
  try {
    const [usdPx, cash, debt, apr, buf, paused, shares, cap] = await Promise.all([
      oracleR.peek(NET.usd.address), vaultR.cash(), vaultR.totalDebt(), vaultR.aprBps(), vaultR.totalBuffer(), vaultR.paused(), vaultR.totalShares(), vaultR.borrowCap(),
    ]);
    S.usdPx = Number(usdPx[0]) / 1e8 || 1;
    S.cash = unit(cash, NET.usd.decimals); S.debt = unit(debt, NET.usd.decimals); S.apr = Number(apr) / 100;
    S.buf = +E.formatEther(buf); S.paused = paused; S.shares = shares; S.cap = unit(cap, NET.usd.decimals);
    S.assets = await Promise.all(NET.collateral.map(async (a) => {
      const [m, px, f] = await Promise.all([vaultR.assets(a.address), oracleR.peek(a.address), oracleR.feeds(a.address)]);
      return { ...a, lt: Number(m.ltBps) / 1e4, cap: unit(m.cap, a.decimals), total: unit(m.total, a.decimals), usd: Number(px[0]) / 1e8, at: Number(px[1]) * 1000, fresh: px[2], chainlink: f[0] !== ZERO };
    }));
    S.ok = true;
    if (ME) { const who = ME.address, me = await readMe(who); if (id !== seq || !ME || ME.address !== who) return; Object.assign(ME, me); }
    if (id !== seq) return;
    render();
  } catch (e) {
    $("#px-note").textContent = "Can't reach Robinhood Chain right now, retrying";
    console.warn(e);
  }
}

async function readMe(a = ME.address) {
  const usdT = new E.Contract(NET.usd.address, ERC20_ABI, rp);
  const [eth, debt, buf, g, sh, usdBal] = await Promise.all([rp.getBalance(a), vaultR.debtOf(a), vaultR.buffer(a), vaultR.guardians(a), vaultR.shares(a), usdT.balanceOf(a)]);
  const col = {}, wallet = { ETH: +E.formatEther(eth) }, raw = {};
  await Promise.all(NET.collateral.map(async (c) => {
    const amt = await vaultR.collateral(a, c.address); raw[c.symbol] = amt; col[c.symbol] = unit(amt, c.decimals);
    if (c.address !== ZERO) wallet[c.symbol] = unit(await new E.Contract(c.address, ERC20_ABI, rp).balanceOf(a), c.decimals);
  }));
  const totalAssets = S.cash + S.debt;
  return { eth: wallet.ETH, col, raw, wallet, usdBal: unit(usdBal, NET.usd.decimals), debtRaw: debt, debt: unit(debt, NET.usd.decimals),
    buffer: +E.formatEther(buf), guardian: { agent: g[0], expiry: Number(g[1]) * 1000 }, sharesRaw: sh,
    lend: S.shares > 0n ? (Number(sh) / Number(S.shares)) * totalAssets : 0 };
}
const loadMe = async () => { const who = ME.address, me = await readMe(who); if (ME && ME.address === who) Object.assign(ME, me); };

const A = (sym) => S.assets.find((a) => a.symbol === sym);
const guardOn = () => !!(ME && ME.guardian && ME.guardian.agent !== ZERO && ME.guardian.expiry > Date.now());
function healthWith(dCol = {}, dDebt = 0) {
  let c = 0;
  for (const a of S.assets) c += Math.max(0, (ME?.col?.[a.symbol] || 0) + (dCol[a.symbol] || 0)) * a.usd * a.lt;
  const d = Math.max(0, (ME?.debt || 0) + dDebt) * S.usdPx;
  return d > 0 ? c / d : Infinity;
}

// ------------------------------------------------------------------ render
function render() {
  if (!S.ok) return;
  const usdSym = NET.usd.symbol, rows = [];
  const mine = !!(ME && ME.col);
  if (mine) {
    $("#book-h").textContent = "Your collateral";
    for (const a of S.assets) {
      const amt = ME.col[a.symbol]; if (!amt) continue;
      const v = amt * a.usd;
      rows.push(`<li>
        <div class="asset"><span class="coin logo"><img src="${LOGO(a.logo)}" alt=""></span><span><b>${fmtNum(amt)} ${a.symbol}</b><small>${fmtUsd(a.usd)} · counts ${Math.round(a.lt * 100)}%</small></span></div>
        <div class="track"><div class="h"></div><div class="o" style="width:${ME.debt ? Math.min(100, ((ME.debt * S.usdPx) / Math.max(1e-9, totalLT())) * 100).toFixed(1) : 0}%"></div>
          <div class="lbl"><span>${fmtUsd(v)} locked</span><span class="stk">${fmtUsd(v * a.lt)} borrowing power</span></div></div>
        <div class="pct">${fmtUsd(v)}</div>
      </li>`);
    }
    rows.push(`<li>
      <div class="asset"><span class="coin logo"><img src="${LOGO(NET.usd.logo)}" alt=""></span><span><b>${fmtNum(ME.debt, 2)} ${usdSym}</b><small>borrowed · ${S.apr.toFixed(2)}% a year</small></span></div>
      <div class="track"><div class="h" style="opacity:.25"></div><div class="o" style="width:${ME.debt ? 100 : 0}%"></div>
        <div class="lbl"><span>in your wallet ${fmtNum(ME.usdBal, 2)} ${usdSym}</span><span class="stk">${ME.lend ? `lending ${fmtNum(ME.lend, 2)} ${usdSym}` : ""}</span></div></div>
      <div class="pct" style="color:var(--fire)">${fmtUsd(ME.debt * S.usdPx)}</div>
    </li>`);
    if (rows.length === 1 && !ME.debt) rows.splice(0, 1, `<li class="empty">${short(ME.address)} has no collateral in the vault yet. Deposit below.</li>`);
  } else {
    $("#book-h").textContent = "Markets";
    for (const a of S.assets) {
      rows.push(`<li>
        <div class="asset"><span class="coin logo"><img src="${LOGO(a.logo)}" alt=""></span><span><b>${esc(a.name)}</b><small>${a.symbol} · ${fmtUsd(a.usd)}${a.fresh ? "" : " · price stale"}</small></span></div>
        <div class="track"><div class="h"></div><div class="o" style="width:${a.cap ? Math.min(100, (a.total / a.cap) * 100).toFixed(1) : 0}%"></div>
          <div class="lbl"><span>${fmtNum(a.total, 3)} ${a.symbol} deposited</span><span class="stk">counts ${Math.round(a.lt * 100)}% · ${a.chainlink ? "Chainlink" : "agent price"}</span></div></div>
        <div class="pct">${fmtUsd(a.total * a.usd)}</div>
      </li>`);
    }
    const util = S.cash + S.debt > 0 ? (S.debt / (S.cash + S.debt)) * 100 : 0;
    rows.push(`<li>
      <div class="asset"><span class="coin logo"><img src="${LOGO(NET.usd.logo)}" alt=""></span><span><b>${esc(NET.usd.symbol)} pool</b><small>lending · ${S.apr.toFixed(2)}% a year</small></span></div>
      <div class="track"><div class="h"></div><div class="o" style="width:${util.toFixed(1)}%"></div>
        <div class="lbl"><span>${fmtNum(S.cash, 2)} ${usdSym} available</span><span class="stk">${fmtNum(S.debt, 2)} borrowed</span></div></div>
      <div class="pct">${Math.round(util)}%</div>
    </li>`);
  }
  $("#assets").innerHTML = rows.join("");
  stats();

  let hf;
  if (mine) hf = ME.debt > 0 ? healthWith() : null;
  else { const c = S.assets.reduce((x, a) => x + a.total * a.usd * a.lt, 0); hf = S.debt > 0 ? c / (S.debt * S.usdPx) : null; }
  $("#hf").textContent = hf == null ? "–" : fmtH(hf);
  const hn = $("#hf-note");
  hn.innerHTML = `<i></i>${hf == null ? (mine ? "no debt" : "no borrowing yet") : hf < GUARD ? "Guard zone" : "Safe"} · liquidation at 1.00`;
  hn.className = hf != null && hf < GUARD ? "warn" : "ok";
  const eth = A("ETH"), age = eth && eth.at ? Math.round((Date.now() - eth.at) / 60000) : null;
  $("#px-note").textContent = `${mine ? "Live from the vault" : "Protocol totals, live from the vault"} · ETH ${fmtUsd(eth?.usd)}${age != null ? ` · price ${age < 1 ? "<1" : age} min old` : ""}${S.paused ? " · paused" : ""}`;

  const ethL = mine ? ME.col.ETH || 0 : eth?.total || 0, B = mine ? ME.buffer : S.buf;
  $("#lb-scope").textContent = mine ? "your ETH" : "protocol ETH";
  $("#split-l").style.width = (ethL + B > 0 ? (ethL / (ethL + B)) * 100 : 100).toFixed(1) + "%";
  $("#lb-locked").innerHTML = `${fmtNum(ethL)} ETH <em>locked</em>`;
  $("#lb-buffer").innerHTML = `${fmtNum(B)} ETH <em>buffer</em>`;

  $("#wallet-line").innerHTML = mine ? `<b>${short(ME.address)}</b> · ${fmtNum(ME.eth)} ETH · ${fmtNum(ME.usdBal, 2)} ${usdSym}` : "No wallet connected";
  $$("[data-wallet]").forEach((b) => (b.textContent = ME ? "Disconnect" : "Connect wallet"));
  const sk = $("#sk-state"), tg = $("#sk-toggle");
  if (!mine) { sk.textContent = "Connect a wallet"; tg.textContent = "Connect"; }
  else {
    const g = ME.guardian, ours = AGENT && g.agent.toLowerCase() === AGENT.agent.toLowerCase();
    sk.textContent = guardOn() ? `${ours ? "Kryonark agent" : short(g.agent)} · top-up only · until ${new Date(g.expiry).toISOString().slice(0, 10)}` : "Not appointed";
    tg.textContent = guardOn() ? "Revoke" : "Appoint";
  }
  hint();
}
function stats() {
  const tvl = S.assets.reduce((x, a) => x + a.total * a.usd, 0) + S.cash + S.buf * (A("ETH")?.usd || 0);
  $("#st-tvl").textContent = fmtUsd(tvl);
  $("#st-debt").textContent = fmtUsd(S.debt * S.usdPx);
  $("#st-apr").textContent = `Borrowed · ${S.apr.toFixed(2)}% a year`;
  const box = $("#st-assets");
  if (box && !box.childElementCount) box.innerHTML = S.assets.map((a) => `<img src="${LOGO(a.logo)}" alt="" title="${esc(a.name)}">`).join("");
}
const totalLT = () => S.assets.reduce((x, a) => x + (ME?.col?.[a.symbol] || 0) * a.usd * a.lt, 0);

function hint() {
  const el = $("#act-hint");
  if (!ME || !ME.col) { el.textContent = "Connect a wallet to start"; return; }
  const sym = $("#col-asset").value, a = A(sym), amt = +$("#col-amt").value.replace(",", ".") || 0, usd = +$("#usd-amt").value.replace(",", ".") || 0;
  const maxBorrow = Math.max(0, totalLT() / OPEN_HEALTH / S.usdPx - ME.debt);
  const h = healthWith({ [sym]: amt }, usd);
  el.textContent = `wallet ${fmtNum(ME.wallet[sym], 4)} ${sym} · can borrow ${fmtNum(Math.min(maxBorrow, S.cash), 2)} ${NET.usd.symbol}${amt || usd ? ` · health after ${fmtH(h)}` : ""}`;
}
["#col-asset", "#col-amt", "#usd-amt"].forEach((s) => $(s).addEventListener("input", hint));

// ------------------------------------------------------------------ agent status (real heartbeat)
let lastCheck = 0, every = 0, statusSeen = false;
async function status() {
  let s = null;
  try { const r = await fetch("/agent/api/status", { cache: "no-store", signal: AbortSignal.timeout(5000) }); if (r.ok) s = await r.json(); } catch {}
  statusSeen = true;
  AGENT = s && s.agent ? s : null;
  const online = !!(s && s.online);
  $("#agent-state").textContent = online ? "Agent online" : "Agent offline";
  $("#agent-dot").style.background = online ? "" : "#ffb14a";
  $("#agent-dot").style.boxShadow = online ? "" : "0 0 6px rgba(255,177,74,.8)";
  $("#agent-guarded").textContent = !s ? "not reachable" : s.configured === false ? "waiting for the vault" : `${s.guarded} account${s.guarded === 1 ? "" : "s"} guarded`;
  lastCheck = online ? s.lastCheck : 0; every = s ? s.checkEveryMs : 0;
  const now = Date.now(), hours = Array.from({ length: 24 }, () => []);
  for (const a of (s && s.actions) || []) { const k = Math.floor((now - a.at) / 3600e3); if (k >= 0 && k < 24) hours[23 - k].push(a); }
  const max = Math.max(1, ...hours.map((h) => h.length));
  $("#bars").innerHTML = hours.map((h, i) => {
    const t = h.length ? `${h.length} top-up${h.length > 1 ? "s" : ""}: ` + h.map((a) => `${(+a.eth).toFixed(4)} ETH, health ${a.before.toFixed(2)}→${a.after.toFixed(2)}`).join("; ") : online ? "checked, no top-up needed" : "no data";
    return `<i class="${h.length ? "now" : ""}" style="height:${h.length ? 25 + (h.length / max) * 75 : 8}%" title="${23 - i}h ago · ${t}"></i>`;
  }).join("");
  const n = hours.reduce((a, h) => a + h.length, 0);
  $("#st-checks").textContent = s && s.configured !== false ? Number(s.checks24h || 0).toLocaleString("en-US") : "–";
  // the count covers less than 24 h while the agent is younger than a day; say so
  const winH = s && s.checksWindowMs ? s.checksWindowMs / 3_600_000 : 24;
  $("#st-checks-l").textContent = winH < 23.5 ? `Agent health checks, last ${winH < 1 ? Math.max(1, Math.round(winH * 60)) + " min" : Math.round(winH) + " h"}` : "Agent health checks, 24 h";
  $("#tops-n").textContent = s && s.configured !== false ? `${n} top-up${n === 1 ? "" : "s"} · ${Number(s.checks24h || 0).toLocaleString("en-US")} checks${winH < 23.5 ? "" : " in 24 h"}` : "waiting for the vault";
  if (ME && S.ok) render();
}
setInterval(() => {
  if (!lastCheck) { $("#chk-time").textContent = statusSeen ? "agent offline" : "connecting…"; $("#chk-next").textContent = "–"; return; }
  $("#chk-time").textContent = new Date(lastCheck).toISOString().slice(11, 19) + " UTC";
  $("#chk-next").textContent = (Math.max(0, every - (Date.now() - lastCheck)) / 1000).toFixed(1) + " s";
}, 100);

// ------------------------------------------------------------------ wallet (EIP-6963 discovery, injected fallback)
const providers = [];
addEventListener("eip6963:announceProvider", (e) => { if (!providers.some((p) => p.info.uuid === e.detail.info.uuid)) providers.push(e.detail); });
dispatchEvent(new Event("eip6963:requestProvider"));
let injected = null;

async function pickWallet() {
  dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 150));
  if (providers.length === 1) return providers[0].provider;
  if (providers.length > 1) return chooser();
  if (window.ethereum) return window.ethereum;
  toast("No wallet found. Install MetaMask, Rabby or Coinbase Wallet, then reload.");
  return null;
}
function chooser() {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal in"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
    m.innerHTML = `<div class="modal-card"><button class="modal-x" type="button" aria-label="Close" data-x>×</button><span class="eyebrow">Connect</span><h3>Choose a wallet</h3>
      <div class="wallets">${providers.map((p, i) => `<button type="button" class="wallet" data-i="${i}"><img src="${esc(p.info.icon)}" alt="">${esc(p.info.name)}</button>`).join("")}</div></div>`;
    document.body.appendChild(m);
    const done = (v) => { m.remove(); removeEventListener("keydown", key); resolve(v); };
    const key = (e) => { if (e.key === "Escape") done(null); };
    addEventListener("keydown", key);
    m.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) done(providers[+b.dataset.i].provider); else if (e.target === m || e.target.closest("[data-x]")) done(null); });
  });
}
async function ensureChain(eth) {
  const want = "0x" + NET.chainId.toString(16);
  if ((await eth.request({ method: "eth_chainId" })) === want) return;
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
  catch (e) {
    if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: NET.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [NET.rpc], blockExplorerUrls: [NET.explorer] }] });
  }
}
let listening = false;
async function connect() {
  if (!NET || !NET.vault) return toast("The vault isn't deployed yet.");
  if (!consent()) return;
  const eth = await pickWallet(); if (!eth) return;
  try {
    const [addr] = await eth.request({ method: "eth_requestAccounts" });
    await ensureChain(eth);
    injected = eth; ME = { address: E.getAddress(addr) };
    try { localStorage.setItem("kryo-wallet", "1"); } catch {}
    if (!listening && eth.on) {
      listening = true;
      eth.on("accountsChanged", (a) => { if (!a.length) disconnect(); else { ME = { address: E.getAddress(a[0]) }; refresh(); } });
      eth.on("chainChanged", () => refresh());
    }
    await loadMe(); render();
    toast(`Connected ${short(ME.address)} on ${NET.chainName}`);
  } catch (e) { ME = null; toast(errText(e)); render(); }
}
// Stock Tokens may not be offered to US persons (Robinhood's terms); ask once before the first connection.
function consent() {
  try { if (localStorage.getItem("kryo-terms") === "1") return true; } catch {}
  const ok = confirmBox();
  return ok;
}
function confirmBox() {
  // a synchronous, dialog-free check: the first click shows the notice, the second (after reading) proceeds
  const n = $("#terms-note");
  if (n && n.dataset.seen === "1") { try { localStorage.setItem("kryo-terms", "1"); } catch {} n.hidden = true; return true; }
  if (n) { n.hidden = false; n.dataset.seen = "1"; n.scrollIntoView({ behavior: "smooth", block: "center" }); }
  return false;
}
function disconnect() { ME = null; injected = null; try { localStorage.removeItem("kryo-wallet"); } catch {} render(); }
async function autoReconnect() {
  let was = false; try { was = localStorage.getItem("kryo-wallet") === "1"; } catch {}
  if (!was) return;
  await new Promise((r) => setTimeout(r, 300));
  const eth = providers[0]?.provider || window.ethereum; if (!eth) return;
  const a = await eth.request({ method: "eth_accounts" }).catch(() => []);
  if (a.length) { injected = eth; ME = { address: E.getAddress(a[0]) }; await loadMe().catch(() => {}); render(); }
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-wallet]")) { e.preventDefault(); ME ? disconnect() : connect(); } });
window.kryonarkConnect = () => (ME ? toast(`Connected ${short(ME.address)}`) : connect());

// ------------------------------------------------------------------ transactions
async function signer() {
  if (!ME || !injected) { await connect(); if (!ME) throw new Error("Connect a wallet first"); }
  await ensureChain(injected);
  return new E.BrowserProvider(injected).getSigner();
}
let IFACE = null;
function revertName(e) {
  if (e?.revert?.name) return e.revert.name;
  IFACE ||= new E.Interface(VAULT_ABI);
  for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data, e?.error?.data?.data]) {
    if (typeof d === "string" && /^0x[0-9a-f]{8}/i.test(d)) { try { return IFACE.parseError(d).name; } catch {} }
  }
  return "";
}
function errText(e) {
  const rn = revertName(e);
  const m = (rn ? rn + "()" : "") + " " + (e?.shortMessage || e?.info?.error?.message || e?.reason || e?.message || String(e));
  if (/user rejected|denied|ACTION_REJECTED/i.test(m)) return "Cancelled in the wallet.";
  if (/TransferFailed/.test(m)) return "The token transfer failed (balance, allowance, or the token is paused or blocked).";
  const map = { Unhealthy: "That would take your health below 1.25.", Liquidity: "Not enough in the pool right now.", "Cap()": "That's above the current cap.", IsPaused: "Deposits and borrowing are paused right now.", "Amount()": "Check the amount.", "Stale": "A price is stale; try again in a minute.", "BadPrice": "A price is missing right now.", "NotListed": "That asset isn't listed.", Expired: "The agent's permission has expired.", Blocked: "The stock token refused the transfer (Robinhood blocklist).", "insufficient funds": "Not enough ETH for this and gas.", "max 10k": "The faucet gives at most 10,000 per call." };
  for (const k in map) if (m.includes(k)) return map[k];
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}
async function send(label, fn) {
  const s = await signer();
  const v = new E.Contract(NET.vault, VAULT_ABI, s);
  toast(`${label}: confirm in your wallet`);
  const tx = await fn(v, s);
  toast(`${label}: sent, waiting for the block`, tx.hash);
  await tx.wait();
  toast(`${label}: done`, tx.hash);
  await refresh();
  return tx;
}
async function approve(s, token, symbol, amount) {
  const t = new E.Contract(token, ERC20_ABI, s);
  if ((await t.allowance(ME.address, NET.vault)) >= amount) return;
  toast(`Approve ${symbol}: confirm in your wallet`);
  const tx = await t.approve(NET.vault, amount); await tx.wait();
}
const num = (x) => String(x || "0").trim().replace(",", ".");
const need = (x, what) => { if (!(+num(x) > 0)) throw new Error(`Enter ${what}.`); return num(x); };
const colBy = (sym) => NET.collateral.find((c) => c.symbol === sym.toUpperCase());
const USDu = (x) => E.parseUnits(num(x), NET.usd.decimals);

const ACT = {
  async deposit(sym, amt) {
    const c = colBy(sym); amt = need(amt, `the ${sym} amount`);
    const raw = E.parseUnits(amt, c.decimals);
    if (c.address === ZERO) return send(`Deposit ${amt} ETH`, (v) => v.depositEth({ value: raw }));
    return send(`Deposit ${amt} ${sym}`, async (v, s) => { await approve(s, c.address, sym, raw); return v.deposit(c.address, raw); });
  },
  async withdraw(sym, amt) {
    const c = colBy(sym);
    const raw = /^(all|max)$/i.test(String(amt).trim()) ? E.MaxUint256 : E.parseUnits(need(amt, `the ${sym} amount`), c.decimals);
    return send(`Withdraw ${sym}`, (v) => v.withdraw(c.address, raw));
  },
  async borrow(amt) { amt = need(amt, "the amount to borrow"); return send(`Borrow ${amt} ${NET.usd.symbol}`, (v) => v.borrow(USDu(amt))); },
  async repay(amt) {
    const all = !(+num(amt) > 0) || /^(all|max)$/i.test(String(amt).trim());
    const raw = all ? (ME.debtRaw * 1001n) / 1000n + 1n : USDu(amt); // a hair extra for interest accrued until the block; the vault only takes what's owed
    if (ME.debtRaw === 0n) throw new Error("No debt to repay.");
    return send(`Repay ${all ? "all" : amt} ${NET.usd.symbol}`, async (v, s) => { await approve(s, NET.usd.address, NET.usd.symbol, raw); return v.repay(ME.address, all ? E.MaxUint256 : raw); });
  },
  async bufIn(amt) { amt = need(amt, "the buffer amount"); return send(`Add ${amt} ETH buffer`, (v) => v.depositBuffer({ value: E.parseEther(amt) })); },
  async bufOut(amt) { const all = /^(all|max)$/i.test(String(amt).trim()); return send("Take back buffer", (v) => v.withdrawBuffer(all ? E.MaxUint256 : E.parseEther(need(amt, "the buffer amount")))); },
  async lendIn(amt) { amt = need(amt, "the amount to lend"); const raw = USDu(amt); return send(`Supply ${amt} ${NET.usd.symbol}`, async (v, s) => { await approve(s, NET.usd.address, NET.usd.symbol, raw); return v.supply(raw); }); },
  async lendOut(amt) {
    const all = !(+num(amt) > 0) || /^(all|max)$/i.test(String(amt).trim());
    const sh = all ? E.MaxUint256 : (ME.sharesRaw * USDu(amt)) / USDu(String(Math.max(ME.lend, 1e-9)));
    return send("Withdraw lending", (v) => v.unsupply(sh));
  },
  async appoint(days = 30) { if (!AGENT) throw new Error("The agent is offline; try again shortly."); return send("Appoint the agent", (v) => v.setGuardian(AGENT.agent, days)); },
  async revoke() { return send("Revoke the agent", (v) => v.setGuardian(ZERO, 0)); },
  async faucet() {
    if (!NET.testnet) return;
    const s = await signer();
    const t = new E.Contract(NET.usd.address, ERC20_ABI, s);
    toast(`Faucet: confirm in your wallet`);
    const tx = await t.faucet(E.parseUnits("1000", NET.usd.decimals)); toast("Faucet: sent", tx.hash); await tx.wait(); toast(`Faucet: +1,000 ${NET.usd.symbol}`, tx.hash); await refresh();
  },
};
const run = async (fn) => { try { if (!ME) await connect(); if (!ME) return; await fn(); } catch (e) { toast(errText(e)); } };

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  if (!NET || !NET.vault) return toast("The vault isn't deployed yet.");
  const sym = $("#col-asset").value, c = $("#col-amt").value, u = $("#usd-amt").value, bf = $("#buf-eth").value, l = $("#lend-amt").value;
  const go = { dep: () => ACT.deposit(sym, c), wd: () => ACT.withdraw(sym, c), borrow: () => ACT.borrow(u), repay: () => ACT.repay(u),
    "buf-in": () => ACT.bufIn(bf), "buf-out": () => ACT.bufOut(bf), "lend-in": () => ACT.lendIn(l), "lend-out": () => ACT.lendOut(l), faucet: () => ACT.faucet() }[b.dataset.act];
  if (go) run(go);
});
$("#sk-toggle").addEventListener("click", () => {
  if (!NET || !NET.vault) return toast("The vault isn't deployed yet.");
  if (!ME) return connect();
  run(() => (guardOn() ? ACT.revoke() : ACT.appoint(30)));
});

// ------------------------------------------------------------------ intents → real transactions (English and Indonesian)
function plan(text) {
  const t = " " + text.toUpperCase().replace(/(\d),(\d)/g, "$1.$2") + " ";
  const usd = NET.usd.symbol.toUpperCase();
  const syms = NET.collateral.map((c) => c.symbol.toUpperCase());
  const sym = syms.find((s) => new RegExp(`\\b${s}\\b`).test(t));
  const amtOf = (s) => { const m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:LEMBAR\\s*|SHARES?\\s*(?:OF\\s*)?)?${s}\\b`)); return m ? m[1] : null; };
  const dollars = (t.match(new RegExp(`\\$\\s*(\\d+(?:\\.\\d+)?)|(\\d+(?:\\.\\d+)?)\\s*(?:${usd}|USD|DOLLARS?|DOLAR)`)) || []).slice(1).find(Boolean);
  const eth = amtOf("ETH");
  if (/REVOKE|STOP THE AGENT|CABUT|HENTIKAN|MATIKAN/.test(t)) return { text: "Revoke the agent: it can no longer top up your account.", go: () => ACT.revoke() };
  if (/PROTECT|GUARD|AMANKAN|LINDUNGI|JAGA/.test(t)) return {
    text: `Appoint the Kryonark agent for 30 days (top-up only)${eth ? ` and add <b>${eth} ETH</b> to your buffer` : ""}. Below 1.30 health it moves your buffer into collateral, aiming for 1.50.`,
    go: async () => { if (eth) await ACT.bufIn(eth); if (!(guardOn() && AGENT && ME.guardian.agent.toLowerCase() === AGENT.agent.toLowerCase())) await ACT.appoint(30); } };
  if (/BORROW|PINJAM/.test(t) && dollars) return { text: `Borrow <b>${dollars} ${NET.usd.symbol}</b>. Health after: <b>${fmtH(healthWith({}, +dollars))}</b>${healthWith({}, +dollars) < OPEN_HEALTH ? ", below 1.25, so the vault would refuse it" : ""}.`, go: () => ACT.borrow(dollars) };
  if (/REPAY|BAYAR|LUNASI/.test(t)) return { text: `Repay <b>${dollars || "all"} ${NET.usd.symbol}</b>.`, go: () => ACT.repay(dollars || "all") };
  if (/WITHDRAW|TARIK|TAKE BACK/.test(t) && /BUFFER/.test(t)) return { text: `Take back <b>${eth || "all"} ETH</b> from your buffer.`, go: () => ACT.bufOut(eth || "all") };
  if (/BUFFER/.test(t) && eth) return { text: `Add <b>${eth} ETH</b> to your buffer for the agent.`, go: () => ACT.bufIn(eth) };
  if (/WITHDRAW|TARIK/.test(t) && sym) { const a = amtOf(sym) || "all"; return { text: `Withdraw <b>${a} ${sym}</b> from your collateral (health must stay above 1.25).`, go: () => ACT.withdraw(sym, a) }; }
  if (/(DEPOSIT|ADD|TAMBAH|SETOR|LOCK|KUNCI)/.test(t) && sym && amtOf(sym)) { const a = amtOf(sym); return { text: `Deposit <b>${a} ${sym}</b> as collateral. Health after: <b>${fmtH(healthWith({ [sym]: +a }))}</b>.`, go: () => ACT.deposit(sym, a) }; }
  if (/(LEND|SUPPLY|PINJAMKAN)/.test(t) && dollars) return { text: `Lend <b>${dollars} ${NET.usd.symbol}</b> to the pool at ${S.apr.toFixed(2)}% a year.`, go: () => ACT.lendIn(dollars) };
  return null;
}
let pending = null;
$("#verify").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = NET && NET.vault && S.ok ? plan($("#cid").value) : null;
  $("#result").classList.toggle("bad", !p);
  pending = p && p.go;
  $("#result-go").hidden = !p;
  $("#result-t").innerHTML = !NET || !NET.vault ? "The vault isn't deployed yet." : p ? p.text : `Couldn't read that. Try <b>"Deposit 0.1 ETH"</b>, <b>"Borrow $50"</b>, <b>"Protect my account with 0.05 ETH"</b>, <b>"Repay all"</b> or <b>"Revoke the agent"</b>.`;
});
$("#result-go").addEventListener("click", () => { if (pending) run(pending); });

// ------------------------------------------------------------------ toast with explorer link
let tt;
function toast(msg, tx) {
  let el = $(".toast"); if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.innerHTML = esc(msg) + (tx && NET?.explorer ? ` · <a href="${NET.explorer}/tx/${tx}" target="_blank" rel="noopener">view tx</a>` : "");
  el.classList.add("in"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("in"), tx ? 7000 : 3500);
}

// ------------------------------------------------------------------ token contract chip (set by the owner in /studio)
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

if (document.readyState === "complete") boot(); else addEventListener("load", boot);
})();
