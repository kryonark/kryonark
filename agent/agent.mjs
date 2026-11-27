// Kryonark agent.
//  1. Prices: for every asset whose KryoOracle entry has no Chainlink feed (testnet), pushes ETH from Coinbase,
//     stock tokens from Robinhood's Stock Token price API (mid of tokenBid/tokenAsk), and the test dollar at $1.
//     On mainnet the oracle reads Chainlink and the agent pushes nothing.
//  2. Guard: watches every account in KryonarkVault and, for accounts that appointed this agent as guardian,
//     moves their own ETH buffer into their collateral when health drops below 1.30 (target 1.50).
//  3. Serves live status at 127.0.0.1:$PORT (/agent/api/status) for the site.
// AGENT_KEY is read from .env and never logged.
import http from "node:http";
import fs from "node:fs";
import { ethers } from "ethers";

// config: .env (operator settings) then .env.network (written by kryonark.xyz/studio after a deploy)
const ENV_FILES = [".env", ".env.network"].map((f) => new URL("./" + f, import.meta.url));
for (const f of ENV_FILES) {
  try {
    for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
// the agent's own hot key: created once on this server, kept in .key (0600), never printed. Fund its address for gas.
const KEY_FILE = new URL("./.key", import.meta.url);
if (!process.env.AGENT_KEY) {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, ethers.Wallet.createRandom().privateKey + "\n", { mode: 0o600 });
  process.env.AGENT_KEY = fs.readFileSync(KEY_FILE, "utf8").trim();
}
// a deploy from the studio rewrites .env.network; restart (pm2 brings the agent back) to pick it up
const NET_FILE = ENV_FILES[1];
const netStamp = () => { try { return fs.statSync(NET_FILE).mtimeMs; } catch { return 0; } };
const stamp0 = netStamp();
setInterval(() => { if (netStamp() !== stamp0) { console.log("network config changed, restarting"); process.exit(0); } }, 5000);

const E = process.env;
const RPC = E.RPC_URL, VAULT = E.VAULT, ORACLE = E.ORACLE, FROM_BLOCK = +E.FROM_BLOCK || 0;
const PORT = +E.PORT || 5831, CHECK_MS = +E.CHECK_MS || 5000, PRICE_MS = +E.PRICE_MS || 60_000;
const NETWORK = E.NETWORK || "testnet";
const STOCKS = (E.STOCKS || "").split(",").filter(Boolean).map((s) => { const [sym, addr] = s.split(":"); return { sym, addr: ethers.getAddress(addr) }; });
const idleWallet = new ethers.Wallet(E.AGENT_KEY);
if (!RPC || !VAULT || !ORACLE) {
  // not deployed yet: report the agent's address (the studio uses it as the oracle reporter) and wait for the config
  console.log(`kryonark agent ${idleWallet.address}: waiting for contracts (deploy from kryonark.xyz/studio)`);
  http.createServer((req, res) => {
    res.writeHead(req.url.startsWith("/agent/api/status") ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ configured: false, online: false, agent: idleWallet.address, now: Date.now() }));
  }).listen(PORT, "127.0.0.1");
  await new Promise(() => {});
}
// public RPCs rate-limit: every request times out after 15 s instead of hanging, and calls go in small batches
const rpcReq = new ethers.FetchRequest(RPC); rpcReq.timeout = 15_000;
const provider = new ethers.JsonRpcProvider(rpcReq, undefined, { staticNetwork: true, batchMaxCount: 10 });
const wallet = new ethers.Wallet(E.AGENT_KEY, provider);
delete process.env.AGENT_KEY;
const vault = new ethers.Contract(VAULT, [
  "function usd() view returns (address)", "function usdDecimals() view returns (uint8)",
  "function assets(address) view returns (bool listed, uint8 decimals, uint16 ltBps, uint256 cap, uint256 total)",
  "function healthOf(address) view returns (uint256)", "function accountValues(address) view returns (uint256 collLT, uint256 debt8)",
  "function debtOf(address) view returns (uint256)", "function buffer(address) view returns (uint256)",
  "function guardians(address) view returns (address agent, uint64 expiry)",
  "function totalDebt() view returns (uint256)", "function cash() view returns (uint256)", "function totalBuffer() view returns (uint256)",
  "function aprBps() view returns (uint256)", "function paused() view returns (bool)",
  "function guardTopUp(address,uint256)",
  "event Deposited(address indexed account, address indexed asset, uint256 amount)",
  "event Borrowed(address indexed account, uint256 amount)",
  "event GuardianSet(address indexed account, address indexed agent, uint64 expiry)",
  "event GuardTopUp(address indexed account, address indexed agent, uint256 amount, uint256 healthBefore, uint256 healthAfter)",
], wallet);
const oracle = new ethers.Contract(ORACLE, [
  "function push(address[],uint256[])", "function feeds(address) view returns (address aggregator, uint32 maxAge)",
  "function pushed(address) view returns (uint128 price, uint64 updatedAt)", "function peek(address) view returns (uint256 p, uint256 at, bool ok)",
  "function maxJumpBps() view returns (uint256)", "function reporter() view returns (address)",
], wallet);

const status = {
  configured: true, network: NETWORK, chainId: null, agent: wallet.address, vault: VAULT, oracle: ORACLE,
  startedAt: Date.now(), lastCheck: 0, checkEveryMs: CHECK_MS, checks24h: 0, block: 0,
  accounts: 0, guarded: 0, borrowers: 0, atRisk: 0, prices: {}, lastPricePush: null, actions: [], errors: 0, lastError: null,
};
const checkTimes = [];
let USD = null, ETH_LT = 8000;

// ---------- off-chain prices (only used for assets without a Chainlink feed) ----------
async function ethPrice() {
  const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(8000) });
  const v = +(await r.json()).data.amount; if (!(v > 0)) throw new Error("ETH price"); return v;
}
async function stockPrice(sym) {
  const r = await fetch(`https://api.robinhood.com/rhj/prices/${sym}`, { signal: AbortSignal.timeout(8000) });
  const q = (await r.json()).quotes?.[0];
  const bid = +(q?.tokenBid ?? q?.bid), ask = +(q?.tokenAsk ?? q?.ask);
  if (!(bid > 0 && ask > 0)) throw new Error(sym + " price");
  return { v: (bid + ask) / 2, halted: !!q.isTradingHalt };
}
const to8 = (v) => BigInt(Math.round(v * 1e8));

let lastPush = 0;
async function pushPrices() {
  const wanted = [{ key: "ETH", addr: ethers.ZeroAddress, get: ethPrice }, ...STOCKS.map((s) => ({ key: s.sym, addr: s.addr, get: async () => (await stockPrice(s.sym)).v })), { key: "USD", addr: USD, get: async () => 1 }];
  const outA = [], outP = [];
  const jump = await oracle.maxJumpBps();
  const now = Math.floor(Date.now() / 1000);
  for (const w of wanted) {
    if (await isChainlink(w.addr)) continue; // Chainlink handles it
    let v; try { v = await w.get(); } catch (e) { fail("price " + w.key)(e); continue; }
    const cur = await oracle.pushed(w.addr);
    let p = to8(v);
    const prev = cur.price;
    if (prev > 0n) { const lim = (prev * jump) / 10000n; if (p > prev + lim) p = prev + lim; if (p < prev - lim) p = prev - lim; }
    const moved = prev === 0n || (p > prev ? p - prev : prev - p) * 1000n > prev;
    if (moved || now - Number(cur.updatedAt) > 600) { outA.push(w.addr); outP.push(p); }
  }
  if (outA.length) {
    const tx = await oracle.push(outA, outP); await tx.wait();
    status.lastPricePush = { at: Date.now(), tx: tx.hash, assets: outA.length };
  }
  lastPush = Date.now();
}
const feedCache = new Map(); // asset -> { chainlink, at }
async function isChainlink(a) {
  const c = feedCache.get(a); if (c && Date.now() - c.at < 600_000) return c.chainlink;
  const f = await oracle.feeds(a); const chainlink = f.aggregator !== ethers.ZeroAddress;
  feedCache.set(a, { chainlink, at: Date.now() }); return chainlink;
}
let lastRead = 0;
async function readPrices() {
  if (Date.now() - lastRead < 30_000) return;
  const list = [["ETH", ethers.ZeroAddress], ...STOCKS.map((s) => [s.sym, s.addr]), ["USD", USD]];
  const out = {};
  for (const [k, a] of list) {
    const [[px, at, ok], chainlink] = await Promise.all([oracle.peek(a), isChainlink(a)]); // (Result.at is Array#at, so destructure)
    out[k] = { usd: Number(px) / 1e8, at: Number(at) * 1000, ok, source: chainlink ? "chainlink" : "kryonark-agent" };
  }
  status.prices = out; lastRead = Date.now();
}

// ---------- accounts, discovered from vault events ----------
const accounts = new Set();
let scanned = FROM_BLOCK - 1, lastScan = 0;
// one getLogs per window for every vault event (not one per event type), at most every 15 s: public RPCs rate-limit
async function scan(head) {
  if (Date.now() - lastScan < 15_000 && scanned > FROM_BLOCK) return;
  const STEP = 10_000;
  while (scanned < head) {
    const to = Math.min(head, scanned + STEP);
    const logs = await provider.getLogs({ address: VAULT, fromBlock: scanned + 1, toBlock: to });
    for (const l of logs) {
      let e; try { e = vault.interface.parseLog(l); } catch { continue; }
      if (!e || !e.args || !("account" in e.args.toObject())) continue;
      accounts.add(ethers.getAddress(e.args.account));
      if (e.name === "GuardTopUp") {
        const blk = await provider.getBlock(l.blockNumber);
        status.actions.unshift({ at: blk.timestamp * 1000, account: e.args.account, eth: ethers.formatEther(e.args.amount),
          before: Number(e.args.healthBefore) / 1e18, after: Number(e.args.healthAfter) / 1e18, tx: l.transactionHash });
      }
    }
    status.actions = status.actions.slice(0, 100);
    scanned = to;
  }
  lastScan = Date.now();
}

// ---------- the guard ----------
const GUARD = 1.30, TARGET = 1.50;
async function check() {
  const head = await provider.getBlockNumber();
  status.block = head;
  await scan(head);
  let guarded = 0, borrowers = 0, atRisk = 0;
  const now = Math.floor(Date.now() / 1000);
  const [ethPx] = await oracle.peek(ethers.ZeroAddress);
  for (const acct of accounts) {
    const [g, debt] = await Promise.all([vault.guardians(acct), vault.debtOf(acct)]);
    const mine = g.agent === wallet.address && Number(g.expiry) > now;
    if (mine) guarded++;
    if (debt === 0n) continue;
    borrowers++;
    let h; try { h = Number(await vault.healthOf(acct)) / 1e18; } catch { continue; } // stale price: nothing safe to do
    if (h < GUARD) atRisk++;
    if (!mine || h >= GUARD) continue;
    const buf = await vault.buffer(acct);
    if (buf === 0n || ethPx === 0n) continue;
    // ETH needed: (TARGET × debt8 − collLT) ÷ (ethPx × LT)
    const v = await vault.accountValues(acct);
    const target = (v.debt8 * BigInt(Math.round(TARGET * 1000))) / 1000n;
    if (target <= v.collLT) continue;
    let amt = ((target - v.collLT) * 10n ** 18n * 10000n) / (ethPx * BigInt(ETH_LT)) + 1n;
    if (amt > buf) amt = buf;
    const tx = await vault.guardTopUp(acct, amt);
    await tx.wait();
    console.log(`top-up ${acct} ${ethers.formatEther(amt)} ETH  health ${h.toFixed(3)}  tx ${tx.hash}`);
  }
  status.accounts = accounts.size; status.guarded = guarded; status.borrowers = borrowers; status.atRisk = atRisk;
  status.lastCheck = Date.now();
  checkTimes.push(status.lastCheck);
  while (checkTimes.length && checkTimes[0] < Date.now() - 86_400_000) checkTimes.shift();
  status.checks24h = checkTimes.length;
}

// ---------- loops ----------
const fail = (where) => (e) => { status.errors++; status.lastError = { at: Date.now(), where, msg: String(e?.shortMessage || e?.message || e).slice(0, 200) }; console.error(where, status.lastError.msg); };
let busy = false;
// a cycle can never hang the agent: each step is capped, and the next tick always runs
const capped = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + " timed out")), ms))]);
async function tick() {
  if (busy) return; busy = true;
  try {
    if (Date.now() - lastPush >= PRICE_MS) await capped(pushPrices(), 90_000, "price push").catch(fail("prices"));
    await capped(readPrices(), 30_000, "read prices").catch(fail("read prices"));
    await capped(check(), 60_000, "health check");
  } catch (e) { fail("check")(e); }
  busy = false;
}

status.chainId = Number((await provider.getNetwork()).chainId);
USD = await vault.usd();
ETH_LT = Number((await vault.assets(ethers.ZeroAddress)).ltBps) || 8000;
const rep = await oracle.reporter();
if (rep !== wallet.address) console.warn(`note: oracle reporter is ${rep}, not this agent; price pushes will fail unless Chainlink covers every asset`);
console.log(`kryonark agent ${wallet.address} on chain ${status.chainId}, vault ${VAULT}`);
tick(); setInterval(tick, CHECK_MS);

http.createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith("/agent/api/status")) return send({ ...status, online: Date.now() - status.lastCheck < Math.max(CHECK_MS * 6, 60_000), now: Date.now() });
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`status on 127.0.0.1:${PORT}`));
