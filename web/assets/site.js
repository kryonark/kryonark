// Kryonark · shared bits for every page: Connect wallet, the footer year, the X toast and the phone menu.
(() => {
  // "Connect wallet": on the home page it opens the real wallet connection (app.js); elsewhere it goes there and connects.
  const open = () => {
    if (window.kryonarkConnect) { document.getElementById("engine")?.scrollIntoView({ behavior: "smooth" }); window.kryonarkConnect(); }
    else location.href = "/#connect";
  };
  document.querySelectorAll("[data-connect]").forEach((b) => b.addEventListener("click", open));
  if (location.hash === "#connect") addEventListener("load", () => setTimeout(() => { history.replaceState(null, "", "/#engine"); open(); }, 400));
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
