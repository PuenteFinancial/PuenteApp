// V02 · The Puente experience. 01 AI Strategy & Roadmapping draws the shared isometric ROI chart
// (kit/roi.js) beside a ranked list that lights up once the columns are in rank order.
//
// This section also owns the scroll guide on the right edge: the four offerings, shown only while
// the offering sections (this one, Data & AI Engineering, Evaluate & Improve, the private equity
// card) are on screen. The current item follows the scroll. Clicking an item sends 'offering-go'
// {key}; every V02 section answers for the keys it owns.
import { DRAFT_CSS } from "../../kit/iso.js";
import { roiChart, ROI_CSS, T } from "../../kit/roi.js";

function scrollToEl(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function mount(root, ctx) {
  const REDUCED = !!(ctx && ctx.reducedMotion);
  const bus = ctx && ctx.bus;
  const style = document.createElement("style");
  style.textContent = DRAFT_CSS + ROI_CSS;
  root.prepend(style);

  const onGo = (e) => { if (e.detail && e.detail.key === "strategy") scrollToEl(root.getElementById("strategy")); };
  if (bus) bus.addEventListener("offering-go", onGo);

  /* ---------- chart + ranked list ---------- */
  const list = root.getElementById("rank");
  let rows = [];
  const chart = roiChart(root.getElementById("roi"), {
    reduced: REDUCED,
    onFrame: (t) => rows.forEach((r, k) => r.classList.toggle("on", t >= T.rankAt + k * 90)),
  });
  list.innerHTML = chart.data.map((d, i) =>
    `<li data-i="${i}"><span class="r">${String(i + 1).padStart(2, "0")}</span>` +
    `<span class="nm">${d.name}${i === 0 ? '<span class="first">Build first</span>' : ""}</span>` +
    `<span class="mx">${d.m.toFixed(1)}x</span></li>`).join("");
  rows = [...list.children];
  chart.watch(root.getElementById("frame"));

  // Hovering a roadmap row outlines its column
  list.addEventListener("mouseover", (e) => {
    const li = e.target.closest("li");
    chart.hover(li && li.classList.contains("on") ? Number(li.dataset.i) : -1);
  });
  list.addEventListener("mouseleave", () => chart.hover(-1));

  /* ---------- scroll guide ---------- */
  const snav = root.getElementById("snav");
  const items = [...snav.querySelectorAll("[data-go]")];
  snav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (b && bus) bus.dispatchEvent(new CustomEvent("offering-go", { detail: { key: b.dataset.go } }));
  });

  const section = root.querySelector(".offer");
  const slot = (name) => document.querySelector(`#page > .slot[data-slot="${name}"]`);
  let queued = false;
  function update() {
    queued = false;
    const line = window.innerHeight * 0.45;
    const mf = slot("story"), ev = slot("evaluate"), pe = slot("pe");
    const last = pe || mf || ctx.host;
    const inRange = section.getBoundingClientRect().top <= line && last.getBoundingClientRect().bottom >= line;
    snav.classList.toggle("on", inRange);
    let cur = 0;
    if (pe && pe.getBoundingClientRect().top <= line) cur = 3;
    else if (ev && ev.getBoundingClientRect().top <= line) cur = 2;
    else if (mf && mf.getBoundingClientRect().top <= line) cur = 1;
    items.forEach((b, k) => b.setAttribute("aria-current", String(k === cur)));
  }
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();

  return function cleanup() {
    chart.destroy();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    if (bus) bus.removeEventListener("offering-go", onGo);
  };
}

export default mount;
