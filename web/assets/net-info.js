// Fills contract addresses and network names on the docs and security pages from assets/network.json.
(async () => {
  let n = null; try { const r = await fetch("/assets/network.json", { cache: "no-store" }); if (r.ok) n = await r.json(); } catch {}
  if (!n || !n.vault) { document.querySelectorAll("[data-addr]").forEach((el) => (el.textContent = "being deployed")); return; }
  const link = (a) => (n.explorer ? `<a href="${n.explorer}/address/${a}" target="_blank" rel="noopener">${a}</a>` : a);
  for (const el of document.querySelectorAll("[data-addr]")) {
    const k = el.dataset.addr, a = k === "usd" ? n.usd && n.usd.address : n[k];
    el.innerHTML = a ? link(a) + (k === "usd" ? ` (${n.usd.symbol})` : "") : "not deployed yet";
  }
  for (const el of document.querySelectorAll("[data-net]")) el.textContent = el.dataset.net === "usd" ? (n.usd ? n.usd.symbol : "USD") : n.chainName || "Robinhood Chain";
  if (n.testnet) document.querySelectorAll("[data-testnet]").forEach((el) => (el.hidden = false));
})();
