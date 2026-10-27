// V02 hero: "The leading AI department for [industry]". Opens on private equity, then the word
// rolls through the major industry categories, every word on the same timing.
// The roller is V01's (per-character masked roll); the bus protocol for the old industry panel is gone.

const INDUSTRIES = [
  { word: "private equity" },
  { word: "software" },
  { word: "healthcare" },
  { word: "construction" },
  { word: "logistics" },
  { word: "supply chain" },
  { word: "e-commerce" },
  { word: "consumer" },
  { word: "financial services" },
  { word: "manufacturing" },
  { word: "education" },
];
const CHAR_MS = 620, STAGGER_MS = 24, EASE = "cubic-bezier(.11,.72,0,1)";
const HOLD_MS = 1200;

function mount(root, ctx) {
  const REDUCED = !!(ctx && ctx.reducedMotion);
  const el = root.getElementById("heroRoller");
  const sr = root.getElementById("heroSr");
  const timeouts = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms); timeouts.add(id); return id; };

  // Every word shares one grid cell with an invisible sizer, so the line never reflows.
  const sizer = document.createElement("span");
  sizer.className = "sizer";
  for (const ind of INDUSTRIES) {
    const s = document.createElement("span");
    s.textContent = ind.word + ".";
    sizer.appendChild(s);
  }
  el.appendChild(sizer);

  let current = null;
  function build(text) {
    const w = document.createElement("span");
    w.className = "word";
    const full = text + ".";
    for (let k = 0; k < full.length; k++) {
      const c = document.createElement("span");
      c.className = "ch" + (k === full.length - 1 ? " pt" : "");
      c.textContent = full[k] === " " ? " " : full[k];
      w.appendChild(c);
    }
    return w;
  }
  // Returns how long the roll takes, so the hold starts once the word has landed.
  function set(text, animate) {
    const next = build(text), prev = current;
    el.appendChild(next);
    current = next;
    sr.textContent = text + ".";
    if (!animate || REDUCED || !next.animate) { if (prev) prev.remove(); return 0; }
    let outLen = 0;
    if (prev) {
      [...prev.children].forEach((pc, a) => {
        pc.animate([{ transform: "translateY(-150%)" }], { duration: CHAR_MS * 0.6, delay: a * STAGGER_MS * 0.4, easing: EASE, fill: "forwards" });
      });
      outLen = CHAR_MS * 0.6 + (prev.children.length - 1) * STAGGER_MS * 0.4;
      later(() => prev.remove(), outLen + 30);
    }
    [...next.children].forEach((nc, b) => {
      nc.animate([{ transform: "translateY(150%)" }, { transform: "translateY(0)" }], { duration: CHAR_MS, delay: (prev ? 90 : 0) + b * STAGGER_MS, easing: EASE, fill: "backwards" });
    });
    return Math.max(outLen, CHAR_MS + (next.children.length - 1) * STAGGER_MS);
  }

  let i = 0, timer = null, paused = false;
  function schedule(entryMs) {
    clearTimeout(timer);
    if (paused) return;
    const hold = HOLD_MS * (INDUSTRIES[i].hold || 1) * (REDUCED ? 1.6 : 1);
    timer = setTimeout(() => {
      i = (i + 1) % INDUSTRIES.length;
      schedule(set(INDUSTRIES[i].word, true));
    }, (entryMs || 0) + hold);
  }
  function setPaused(p) {
    if (p === paused) return;
    paused = p;
    if (paused) clearTimeout(timer); else schedule(0);
  }

  // Pause while the tab is hidden or the hero is scrolled out of view.
  let hidden = document.hidden, offscreen = false;
  const sync = () => setPaused(hidden || offscreen);
  const onVis = () => { hidden = document.hidden; sync(); };
  document.addEventListener("visibilitychange", onVis);
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver(([e]) => { offscreen = !e.isIntersecting; sync(); }, { threshold: 0 })
    : null;
  if (io) io.observe(root.querySelector(".hero"));

  root.getElementById("seeOffering").addEventListener("click", () => {
    if (ctx && typeof ctx.scrollTo === "function") ctx.scrollTo("pillars");
  });

  set(INDUSTRIES[0].word, false);
  schedule(0);

  return function cleanup() {
    clearTimeout(timer);
    timeouts.forEach(clearTimeout);
    document.removeEventListener("visibilitychange", onVis);
    if (io) io.disconnect();
  };
}

export default mount;
