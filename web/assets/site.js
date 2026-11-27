// Kryonark · shared bits for every page: the "Connect wallet" panel and the footer year.
(() => {
  const html = `
  <div class="modal" id="connect" role="dialog" aria-modal="true" aria-labelledby="connect-h" hidden>
    <div class="modal-card">
      <button class="modal-x" type="button" aria-label="Close" data-close>×</button>
      <span class="eyebrow">Preview</span>
      <h3 id="connect-h">Wallet connect opens with the vaults</h3>
      <p>Kryonark is in preview. The vault contracts go to Robinhood Chain testnet next; until then nothing on this site asks for a wallet, a signature or funds.</p>
      <p>What works today:</p>
      <ul>
        <li><a href="/#engine">The engine preview</a>: live prices, health factors, the agent's intent box</li>
        <li><code>npx kryonark</code>: the same engine in your terminal</li>
        <li><a href="/docs">Docs</a> and <a href="/security">the security model</a></li>
      </ul>
      <div class="modal-row">
        <a class="btn fire" href="/#engine" data-close>Try the engine</a>
        <a class="btn ghost" href="https://github.com/kryonark/kryonark" target="_blank" rel="noopener">GitHub</a>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  const m = document.getElementById("connect");
  let last = null;
  const open = () => { last = document.activeElement; m.hidden = false; requestAnimationFrame(() => m.classList.add("in")); m.querySelector("[data-close]").focus(); };
  const close = () => { m.classList.remove("in"); setTimeout(() => (m.hidden = true), 180); last?.focus?.(); };
  document.querySelectorAll("[data-connect]").forEach((b) => b.addEventListener("click", open));
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !m.hidden) close(); });
  document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = new Date().getFullYear()));

  // ---- X: the account isn't live yet. When it is, replace the <span data-x> with <a class="soc" href="https://x.com/…">.
  const toast = document.createElement("div"); toast.className = "toast"; toast.setAttribute("role", "status"); document.body.appendChild(toast);
  let tt; const say = (t) => { toast.textContent = t; toast.classList.add("in"); clearTimeout(tt); tt = setTimeout(() => toast.classList.remove("in"), 2200); };
  document.addEventListener("click", (e) => { if (e.target.closest("[data-x]")) say("Kryonark on X is coming soon."); });

  // ---- phone menu: the nav links, plus the socials and Connect wallet that the bar hides on small screens
  const nav = document.querySelector(".nav"), btn = nav && nav.querySelector("[data-menu]"), links = nav && nav.querySelector(".links");
  if (nav && btn && links) {
    const extra = document.createElement("li"); extra.className = "menu-extra";
    const soc = nav.querySelector(".socials"); if (soc) extra.appendChild(soc.cloneNode(true));
    const cw = document.createElement("button"); cw.type = "button"; cw.className = "btn ghost"; cw.textContent = "Connect wallet"; cw.dataset.connect = "";
    cw.addEventListener("click", () => { setMenu(false); open(); }); extra.appendChild(cw);
    links.appendChild(extra);
    const setMenu = (v) => { nav.classList.toggle("open", v); btn.setAttribute("aria-expanded", String(v)); };
    btn.addEventListener("click", () => setMenu(!nav.classList.contains("open")));
    links.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
    document.addEventListener("click", (e) => { if (nav.classList.contains("open") && !nav.contains(e.target)) setMenu(false); });
    addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  }
})();
