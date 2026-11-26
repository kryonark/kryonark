// kryonark-studio: the owner panel for the Kryonark token at kryonark.xyz/studio, plus /studio/api/token for the public site.
// The terminal (equi-terminal on :5780) serves everything else; nginx sends only /studio* here, so nothing clashes with the terminal's /api.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as T from "./burn.mjs";

const PORT = +(process.env.PORT || 5830), HOST = process.env.HOST || "127.0.0.1";
const SITE = new URL("../site/", import.meta.url).pathname;
const TYPES = { ".png": "image/png", ".html": "text/html; charset=utf-8" };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 20_000) { no(new Error("Request too large.")); req.destroy(); } }); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { no(new Error("Bad JSON.")); } }); });
const ipOf = (req) => (/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || "") && req.headers["x-real-ip"]) || req.socket.remoteAddress || "";

// wrong keys lock an address out for 10 minutes after 10 tries
const digest = (x) => crypto.createHash("sha256").update(String(x)).digest(), misses = new Map();
function studioOk(req) {
  const ip = ipOf(req), now = Date.now(), m = (misses.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (m.length >= 10) return "locked";
  if (crypto.timingSafeEqual(digest(req.headers["x-studio-key"] || ""), digest(T.STUDIO_KEY))) return "ok";
  misses.set(ip, [...m, now]); if (misses.size > 5000) misses.clear(); return "bad";
}
const OWNER = "/studio/api/owner";
async function owner(req, res, p) {
  const a = studioOk(req); if (a !== "ok") return send(res, a === "locked" ? 429 : 401, { error: a === "locked" ? "Too many wrong keys. Wait 10 minutes." : "Wrong studio key." });
  const k = `${req.method} ${p.slice(OWNER.length)}`;
  if (k === "GET /status") return send(res, 200, await T.status());
  if (k === "POST /token") return send(res, 200, await T.saveToken(await body(req)));
  if (k === "POST /wallet") return send(res, 200, T.saveKey((await body(req)).privateKey || ""));
  if (k === "DELETE /wallet") return send(res, 200, T.removeKey());
  if (k === "POST /buyback") return send(res, 200, await T.buyback((await body(req)).usd));
  if (k === "POST /supply") return send(res, 200, await T.burnSupply((await body(req)).usd));
  if (k === "POST /burn-held") return send(res, 200, await T.burnHeld());
  return send(res, 404, { error: "Not found." });
}

const ROUTES = { "/studio": "studio.html", "/studio/": "studio.html", "/studio/favicon.png": "favicon.png", "/studio/logo.png": "logo.png" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/studio/api/")) {
    try {
      if (u.pathname === "/studio/api/token" && req.method === "GET") return send(res, 200, await T.publicView(), { "access-control-allow-origin": "*" });
      if (u.pathname.startsWith(OWNER + "/")) return await owner(req, res, u.pathname);
      return send(res, 404, { error: "Not found." });
    } catch (e) { return send(res, 400, { error: e.shortMessage || e.message || "Something went wrong." }); }
  }
  const rel = ROUTES[u.pathname];
  const f = rel ? path.normalize(path.join(SITE, rel)) : "";
  if (!rel || !f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache", "x-robots-tag": "noindex" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(f).pipe(res);
}).listen(PORT, HOST, () => console.log(`kryonark-studio on http://${HOST}:${PORT}`));
