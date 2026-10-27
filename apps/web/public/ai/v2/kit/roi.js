// Isometric ROI chart shared by the V02 homepage (01 AI Strategy & Roadmapping) and the V02
// private equity page (01 Due diligence). Six opportunity columns rise in a scrambled order,
// slide into rank order, and the top one is marked to build first.
//
//   const chart = roiChart(svg, { reduced, onFrame });
//   chart.watch(frameEl)   plays once frameEl is fully on screen (or as much of it as fits),
//                          replays on hover
//   chart.hover(i)         outlines one column (-1 for none)
//   onFrame(t, ranked)     called on every frame, e.g. to light up a ranked list
import { Iso, box, flat, f1, setViewBox, clamp01, easeInOut, easeOut } from "./iso.js";

// Illustrative, and the same example workflows the live private equity page uses.
export const ROADMAP = [
  { name: "Invoice processing", m: 4.2 },
  { name: "Customer onboarding", m: 3.1 },
  { name: "Monthly reporting", m: 2.9 },
  { name: "Contract review", m: 2.1 },
  { name: "Scheduling", m: 1.6 },
  { name: "Vendor setup", m: 1.2 },
];
const START = [2, 4, 0, 5, 1, 3]; // which opportunity stands in each slot before ranking
const SP = 58, W = 30, D = 30, HU = 44; // slot spacing, footprint, height per 1.0x
export const T = { grow: 700, stagger: 110, sortAt: 1500, sort: 900, rankAt: 2400, end: 3100 };

export const ROI_CSS = `
.dg .box.hov polygon{stroke:var(--accent);stroke-opacity:1}
.dg .box.hov .ft{fill:var(--pale-2)}
.dg .mult{font-size:11px}
.dg .mult.top{fill:var(--hi,var(--accent))}
`;

export function roiChart(svg, { reduced = false, onFrame = () => {} } = {}) {
  const data = ROADMAP;
  const P = Iso(0, 0, 1);
  const maxH = data[0].m * HU;
  // Fix the viewBox once, over every position a column can reach, so nothing rescales mid-animation.
  for (let k = 0; k < data.length; k++) { P(k * SP, 0, maxH + 34); P(k * SP + W, D, 0); P(k * SP, D, 0); P(k * SP + W, 0, maxH); }
  P(-14, D + 14, 0); P(5 * SP + W + 14, -14, 0); P(5 * SP + W + 14, D + 14, 0);
  setViewBox(svg, { ...P.bounds }, [10, 26, 26, 26]);

  const slot0 = data.map((_, i) => START.indexOf(i));
  let hoverIdx = -1, raf = 0, played = false, running = false, io = null;

  function render(t) {
    const sortP = easeInOut(clamp01((t - T.sortAt) / T.sort));
    const ranked = t >= T.rankAt;
    const cols = data.map((d, i) => {
      const g = easeOut(clamp01((t - slot0[i] * T.stagger) / T.grow));
      return { i, d, s: slot0[i] + (i - slot0[i]) * sortP, h: d.m * HU * g, g };
    }).sort((a, b) => a.s - b.s); // back to front

    let out = `<polygon class="base" points="${flat(P, -14, -14, 0, 5 * SP + W + 28, D + 28)}"/>`;
    for (const c of cols) {
      if (c.h < 0.5) continue;
      const cls = (ranked && c.i === 0 ? "hl" : "") + (c.i === hoverIdx ? " hov" : "");
      out += box(P, c.s * SP, 0, 0, W, D, c.h, cls);
    }
    for (const c of cols) {
      if (c.g < 0.98) continue;
      const top = P(c.s * SP + W / 2, D / 2, c.h);
      out += `<text class="mult${ranked && c.i === 0 ? " top" : ""}" x="${f1(top[0])}" y="${f1(top[1] - 12)}" text-anchor="middle">${c.d.m.toFixed(1)}x</text>`;
      if (ranked) {
        const base = P(c.s * SP, D, 0);
        out += `<text class="sm" x="${f1(base[0] - 6)}" y="${f1(base[1] + 14)}" text-anchor="end">${String(c.i + 1).padStart(2, "0")}</text>`;
      }
    }
    svg.innerHTML = out;
    onFrame(t, ranked);
  }

  function play() {
    if (running) return;
    running = true; played = true;
    const t0 = performance.now();
    const step = (now) => {
      const t = now - t0;
      render(t);
      if (t < T.end) raf = requestAnimationFrame(step);
      else { running = false; render(T.end); }
    };
    raf = requestAnimationFrame(step);
  }

  return {
    data,
    watch(frameEl) {
      if (reduced || !("IntersectionObserver" in window)) { render(T.end); return; }
      render(0);
      // Wait until the chart is on screen, so the sort is seen rather than missed. A frame
      // taller than the window can never be fully visible, so it only needs to fill most of it.
      io = new IntersectionObserver(([e]) => {
        if (played || !e.isIntersecting) return;
        const fits = e.boundingClientRect.height <= window.innerHeight * 0.9;
        if (e.intersectionRatio >= (fits ? 0.95 : 0.6)) play();
      }, { threshold: [0.25, 0.6, 0.8, 0.95, 1] });
      io.observe(frameEl);
      frameEl.addEventListener("mouseenter", () => { if (played && !running) play(); });
    },
    hover(i) {
      if (i === hoverIdx) return;
      hoverIdx = i;
      if (!running) render(played || reduced ? T.end : 0);
    },
    destroy() { cancelAnimationFrame(raf); if (io) io.disconnect(); },
  };
}
