// Fills contract addresses and network names on the docs and security pages from assets/network.json.
(async () => {
  let n; try { n = await (await fetch("/assets/network.json", { cache: "no-store" })).json(); } catch { return; }
  const link = (a) => (n.explorer ? `<a href="${n.explorer}/address/${a}" target="_blank" rel="noopener">${a}</a>` : a);
  for (const el of document.querySelectorAll("[data-addr]")) {
    const k = el.dataset.addr, a = k === "usd" ? n.usd && n.usd.address : n[k];
    el.innerHTML = a ? link(a) + (k === "usd" ? ` (${n.usd.symbol})` : "") : "not deployed yet";
  }
  for (const el of document.querySelectorAll("[data-net]")) el.textContent = el.dataset.net === "usd" ? (n.usd ? n.usd.symbol : "USD") : n.chainName || "Robinhood Chain";
  if (n.testnet) document.querySelectorAll("[data-testnet]").forEach((el) => (el.hidden = false));
})();
