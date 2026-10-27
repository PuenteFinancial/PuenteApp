// V02 · 03 Evaluate & Improve AI Systems, the third offering. An isometric chart of weekly
// evaluation scores: eight columns, one per week, rise in turn through a dashed plane at the
// baseline (how the work ran before). Each column is drawn in two parts, below and above the
// plane, so the plane sits between them and the later weeks visibly break through it. The latest
// week is marked once every column is up. Plays when the chart comes on screen, and again each
// time it comes back. Answers 'offering-go' for evaluate.
import { Iso, box, flat, f1, setViewBox, clamp01, easeOut, DRAFT_CSS } from "../../kit/iso.js";

const NAV = 64;
// Illustrative scores, one per week, and the baseline they are measured against
const WEEKS = [0.52, 0.6, 0.67, 0.75, 0.8, 0.84, 0.88, 0.91];
const BASE = 0.7;
// Weeks run up and to the right (along -y), 48 apart so no column hides the next
const SP = 48, W = 24, D = 24;
const H = (v) => (v - 0.3) * 300; // height of a score; the axis starts at 30% so the climb reads
const ZB = H(BASE);
const T = { plane: 300, stagger: 150, grow: 650, markAt: 2000, end: 2300 };

const at = (k) => -k * SP; // y of week k
const PLANE = { x: -16, y: at(WEEKS.length - 1) - 16, w: W + 32, d: (WEEKS.length - 1) * SP + D + 32 };

// Phones (compact) leave the baseline label to an HTML key in the frame, label only the first and
// latest weeks, and draw the text larger so it still reads once the drawing is scaled down.
function chart(svg, reduced, compact) {
  const P = Iso(0, 0, 1);
  // Fix the viewBox once over the whole finished drawing, so nothing rescales mid-animation
  P(PLANE.x, PLANE.y, 0); P(PLANE.x + PLANE.w, PLANE.y + PLANE.d, 0); P(PLANE.x, PLANE.y + PLANE.d, 0); P(PLANE.x + PLANE.w, PLANE.y, 0);
  WEEKS.forEach((v, k) => P(W / 2, at(k) + D / 2, H(v) + 30));
  setViewBox(svg, { ...P.bounds }, compact ? [18, 18, 26, 30] : [16, 20, 20, 150]);

  const order = WEEKS.map((_, k) => k).reverse(); // back (latest) to front (first week)
  const corner = P(PLANE.x, PLANE.y + PLANE.d, ZB); // the plane's left corner, for its label

  function render(t) {
    const pa = clamp01(t / T.plane);
    const marked = t >= T.markAt;
    const last = WEEKS.length - 1;
    const hs = WEEKS.map((v, k) => H(v) * easeOut(clamp01((t - T.plane - k * T.stagger) / T.grow)));
    let o = `<polygon class="base" points="${flat(P, PLANE.x, PLANE.y, 0, PLANE.w, PLANE.d)}"/>`;
    // below the baseline, then the plane, then whatever has broken through it
    for (const k of order) if (hs[k] > 0.5) o += box(P, 0, at(k), 0, W, D, Math.min(hs[k], ZB), marked && k === last ? "hl" : "");
    o += `<polygon class="bplane" style="opacity:${pa.toFixed(2)}" points="${flat(P, PLANE.x, PLANE.y, ZB, PLANE.w, PLANE.d)}"/>`;
    for (const k of order) if (hs[k] > ZB + 0.5) o += box(P, 0, at(k), ZB, W, D, hs[k] - ZB, marked && k === last ? "hl" : "over");
    // week numbers along the front edge, scores on the first and latest weeks
    WEEKS.forEach((v, k) => {
      const g = P(W, at(k) + D, 0);
      if (!compact || k === 0 || k === last) o += `<text class="sm" x="${f1(g[0] + 4)}" y="${f1(g[1] + 14)}" text-anchor="start">W${k + 1}</text>`;
      if ((k === 0 || k === last) && hs[k] >= H(v) - 0.5) {
        const top = P(W / 2, at(k) + D / 2, hs[k]);
        o += `<text class="score${k === last && marked ? " top" : ""}" x="${f1(top[0])}" y="${f1(top[1] - 12)}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
      }
    });
    if (!compact) o += `<g style="opacity:${pa.toFixed(2)}"><text class="blab" x="${f1(corner[0] - 12)}" y="${f1(corner[1] + 4)}" text-anchor="end">Baseline ${Math.round(BASE * 100)}%</text>` +
      `<text class="sm" x="${f1(corner[0] - 12)}" y="${f1(corner[1] + 19)}" text-anchor="end">How the work ran before</text></g>`;
    svg.innerHTML = o;
  }

  let raf = 0;
  function play() {
    cancelAnimationFrame(raf);
    if (reduced) { render(T.end); return; }
    const t0 = performance.now();
    const step = (now) => {
      const t = now - t0;
      render(Math.min(t, T.end));
      if (t < T.end) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  render(reduced ? T.end : 0);
  return { play, finish: () => { cancelAnimationFrame(raf); render(T.end); }, destroy: () => cancelAnimationFrame(raf) };
}

function mount(root, ctx) {
  const bus = ctx && ctx.bus;
  const REDUCED = !!(ctx && ctx.reducedMotion);
  const style = document.createElement("style");
  style.textContent = DRAFT_CSS;
  root.prepend(style);

  const svg = root.getElementById("ev");
  const narrow = matchMedia("(max-width: 899px)");
  let c = null, shown = false;
  // redrawing for the other mode shows the finished chart if it has already played
  const fit = () => {
    if (c) c.destroy();
    svg.classList.toggle("compact", narrow.matches);
    c = chart(svg, REDUCED, narrow.matches);
    if (shown) c.finish();
  };
  narrow.addEventListener("change", fit);
  fit();

  // Plays when most of the chart is on screen, and again each time it comes back
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver(([en]) => {
        if (en.isIntersecting && !shown) c.play();
        shown = en.isIntersecting;
      }, { threshold: 0.6 })
    : null;
  if (io) io.observe(root.getElementById("frame"));
  else c.play();

  const onGo = (e) => {
    if (!e.detail || e.detail.key !== "evaluate") return;
    const top = root.getElementById("evaluate").getBoundingClientRect().top + window.scrollY - NAV + 24;
    window.scrollTo({ top, behavior: REDUCED ? "auto" : "smooth" });
  };
  if (bus) bus.addEventListener("offering-go", onGo);

  return function cleanup() {
    c.destroy();
    narrow.removeEventListener("change", fit);
    if (io) io.disconnect();
    if (bus) bus.removeEventListener("offering-go", onGo);
  };
}

export default mount;
