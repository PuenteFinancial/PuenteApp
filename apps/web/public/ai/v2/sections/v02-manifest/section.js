// V02 · 02 Data & AI Engineering, the second offering. One Foundry-shaped isometric scene that plays
// through four stages on its own while it is in view:
//   0  before: agents and applications wired straight to each source (a tangle)
//   1  data foundation: pipelines rise from every source into one Manifest plane
//   2  AI agents & automation: agents read from the Manifest only; a person approves
//   3  custom applications: applications read from the same Manifest
// The whole drawing is built once; stages are cumulative classes (s1, s2, s3) on the svg, and
// CSS transitions do the moving. The text beside it is static: a heading, two sentences, and one
// short line per stage, the current one lit as the diagram plays, so nothing has to be paused to
// be read. Stage 0 is labeled as how things stand before Puente, in the list and on the diagram;
// the three stages after it are numbered 1 to 3. Clicking a line jumps to that stage. The scene starts from "without a foundation" each
// time it comes back on screen. Reports each stage as 'manifest-stage' {stage} on ctx.bus (the
// scroll guide follows it) and answers 'offering-go' for engineering.
import { Iso, box, flat, person, f1, pt, setViewBox, DRAFT_CSS } from "../../kit/iso.js";

const NAV = 64;
const DURATION = [4000, 4500, 4000, 4000]; // ms per stage; each stage line reads in a glance
// Each tier is a 250 x 150 plane, whose rhombus is (w + d) / 2 = 200 tall on screen. Spacing
// the tiers by a little more than that keeps every plane clear of the boxes on the one below.
const PLANE = [0, 0, 250, 150]; // x, y, w, d shared by all three tiers
const Z_M = 205, Z_C = 410; // Manifest plane and the agents / applications tier
// Phones draw the tiers closer together (the Manifest plane goes translucent where it overlaps
// the sources) and leave the labels to the step lines, so the diagram fits beside the text.
const ZC_M = 150, ZC_C = 300;

const SOURCES = [
  { key: "erp", label: "ERP", x: 14, y: 14 },
  { key: "crm", label: "CRM", x: 108, y: 14 },
  { key: "acct", label: "Accounting", x: 202, y: 14 },
  { key: "email", label: "Email", x: 14, y: 100 },
  { key: "docs", label: "Documents", x: 108, y: 100 },
  { key: "sheets", label: "Spreadsheets", x: 202, y: 100 },
];
const SW = 34, SH = 22;
const ENTITIES = [
  { key: "company", label: "Company", x: 16, y: 14 },
  { key: "deal", label: "Deal", x: 150, y: 14 },
  { key: "person", label: "Person", x: 16, y: 92 },
  { key: "material", label: "Material", x: 150, y: 92 },
];
const EW = 40, EH = 6;
const RELATIONS = [["company", "deal"], ["company", "person"], ["deal", "person"], ["deal", "material"]];
// Each agent and application stands directly above one entity, so its link to the Manifest runs
// straight up from the center of that entity's tile.
const AW = 30, AH = 24, PW = 46, PD = 6, PH = 36;
const over = (key, w, d) => { const e = ENTITIES.find((x) => x.key === key); return { x: e.x + EW / 2 - w / 2, y: e.y + EW / 2 - d / 2 }; };
const AGENTS = [
  { ...over("company", AW, AW), wires: ["crm", "docs"] },
  { ...over("person", AW, AW), wires: ["email", "sheets", "erp"] },
];
const APPS = [
  { ...over("deal", PW, PD), wires: ["erp", "crm", "acct"] },
  { ...over("material", PW, PD), wires: ["acct", "sheets"] },
];
const PEOPLE_APPROVE = [80, 122], PEOPLE_USE = [[214, 58], [214, 136]];

function draw(svg, compact = false) {
  const zm = compact ? ZC_M : Z_M, zc = compact ? ZC_C : Z_C;
  const P = Iso(0, 0, 1);
  const src = Object.fromEntries(SOURCES.map((s) => [s.key, s]));
  const ent = Object.fromEntries(ENTITIES.map((e) => [e.key, e]));
  const srcTop = (s) => P(s.x + SW / 2, s.y + SW / 2, SH);
  const agentC = (a) => [a.x + AW / 2, a.y + AW / 2];
  const appC = (a) => [a.x + PW / 2, a.y + PD / 2];
  let o = "";

  // ground tier and the data sources
  o += `<polygon class="base" points="${flat(P, ...PLANE.slice(0, 2), 0, ...PLANE.slice(2))}"/>`;
  for (const s of SOURCES) o += box(P, s.x, s.y, 0, SW, SW, SH);
  for (const s of SOURCES) {
    const f = P(s.x + SW, s.y + SW, 0);
    o += `<text class="sm" x="${f1(f[0])}" y="${f1(f[1] + 14)}" text-anchor="middle">${s.label}</text>`;
  }

  // stage 0: every consumer wired to the sources it needs
  o += `<g class="tangle">`;
  for (const [list, center] of [[AGENTS, agentC], [APPS, appC]]) {
    for (const a of list) {
      const [cx, cy] = center(a);
      const c = P(cx, cy, zc);
      for (const k of a.wires) {
        const s = srcTop(src[k]);
        o += `<path d="M${pt(c)} C${f1(c[0])},${f1(c[1] + 130)} ${f1(s[0])},${f1(s[1] - 130)} ${pt(s)}"/>`;
      }
    }
  }
  o += `</g>`;

  // stage 1: pipelines up into the Manifest
  o += `<g class="pipes">`;
  for (const s of SOURCES) {
    const a = srcTop(s), b = P(s.x + SW / 2, s.y + SW / 2, zm);
    o += `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}"/>`;
  }
  o += `</g>`;

  o += `<g class="mlayer">`;
  o += `<polygon class="mplane" points="${flat(P, PLANE[0], PLANE[1], zm, PLANE[2], PLANE[3])}"/>`;
  o += `<g class="rel">`;
  for (const [a, b] of RELATIONS) {
    const p = P(ent[a].x + EW / 2, ent[a].y + EW / 2, zm + EH), q = P(ent[b].x + EW / 2, ent[b].y + EW / 2, zm + EH);
    o += `<line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(q[0])}" y2="${f1(q[1])}"/>`;
  }
  o += `</g>`;
  // labels sit off each tile's right corner, clear of the link that rises from its center
  ENTITIES.forEach((e, i) => {
    const rc = P(e.x + EW, e.y, zm + EH);
    o += `<g class="ent" style="transition-delay:${0.45 + i * 0.14}s">${box(P, e.x, e.y, zm, EW, EW, EH)}` +
      `<text class="acc" x="${f1(rc[0] + 6)}" y="${f1(rc[1] + 4)}">${e.label}</text></g>`;
  });
  o += `</g>`;

  // agents and applications tier
  o += `<polygon class="ctier" points="${flat(P, PLANE[0], PLANE[1], zc, PLANE[2], PLANE[3])}"/>`;
  let delay = 0;
  const links = (list, center, cls) => {
    let g = `<g class="${cls}">`;
    for (const a of list) {
      const [cx, cy] = center(a);
      const b = P(cx, cy, zm + EH), t = P(cx, cy, zc);
      g += `<line x1="${f1(b[0])}" y1="${f1(b[1])}" x2="${f1(t[0])}" y2="${f1(t[1])}"/>`;
      for (let m = 0; m < 2; m++) {
        g += `<circle class="mk" cx="${f1(b[0])}" cy="${f1(b[1])}" r="2.6" style="animation-delay:${(delay + m) * 0.55}s"/>`;
      }
      delay += 1;
    }
    return g + `</g>`;
  };
  o += links(AGENTS, agentC, "alinks");
  o += links(APPS, appC, "plinks");

  for (const a of AGENTS) o += `<g class="agent">${box(P, a.x, a.y, zc, AW, AW, AH)}</g>`;
  for (const a of APPS) {
    // a standing panel: screen lines drawn on its left face
    const fy = a.y + PD;
    const ui = [[6, 28, 26], [6, 38, 19], [6, 22, 11]].map(([x0, x1, z]) => {
      const p = P(a.x + x0, fy, zc + z), q = P(a.x + x1, fy, zc + z);
      return `<line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(q[0])}" y2="${f1(q[1])}"/>`;
    }).join("");
    o += `<g class="app">${box(P, a.x, a.y, zc, PW, PD, PH)}<g class="ui">${ui}</g></g>`;
  }

  // the person who signs off on an agent's action, and the people using the applications
  const ap = P(...PEOPLE_APPROVE, zc);
  o += `<g class="approver">${person(ap[0], ap[1])}<g class="check" transform="translate(${f1(ap[0] + 10)},${f1(ap[1] - 24)})">` +
    `<circle r="5.5"/><path d="M-2.4,0.2 L-0.6,2 L2.6,-1.8"/></g></g>`;
  o += `<g class="users">`;
  for (const [x, y] of PEOPLE_USE) { const s = P(x, y, zc); o += person(s[0], s[1]); }
  o += `</g>`;

  // tier labels at each plane's left corner
  // (.tierlab ones are dropped on narrow screens, where the Manifest label is the only one kept)
  const tier = (z, label, cls, sub) => {
    const c = P(PLANE[0], PLANE[1] + PLANE[3], z);
    return `<text class="${cls}" x="${f1(c[0] - 14)}" y="${f1(c[1] + 4)}" text-anchor="end">${label}</text>` +
      (sub ? `<text class="sm tierlab" x="${f1(c[0] - 14)}" y="${f1(c[1] + 20)}" text-anchor="end">${sub}</text>` : "");
  };
  o += tier(0, "Data sources", "sm tierlab");
  o += `<g class="mlayer">${tier(zm, "Manifest", "mlabel", "Your data foundation")}</g>`;
  o += tier(zc, "Agents and applications", "sm tierlab");

  svg.innerHTML = o;
  // Labels hang off the left corners, so the full frame pads the left for the longest one;
  // the compact frame has no labels and hugs the drawing.
  setViewBox(svg, P.bounds, compact ? [14, 10, 14, 10] : [34, 24, 34, 196]);
}

function setStage(svg, s) {
  for (let k = 1; k <= 3; k++) svg.classList.toggle("s" + k, s >= k);
}

function mount(root, ctx) {
  const bus = ctx && ctx.bus;
  const REDUCED = !!(ctx && ctx.reducedMotion);
  const style = document.createElement("style");
  // markers ride from the Manifest up to the agents and applications tier (one distance per mode)
  const rise = (name, d) => `@keyframes ${name}{0%{transform:translateY(0);opacity:0}15%{opacity:1}85%{opacity:1}100%{transform:translateY(-${d}px);opacity:0}}`;
  style.textContent = DRAFT_CSS + rise("rise", Z_C - Z_M - EH) + rise("rise-c", ZC_C - ZC_M - EH);
  root.prepend(style);

  const svg = root.getElementById("dg");
  const narrow = matchMedia("(max-width: 899px)");
  // the stage classes live on the svg itself, so redrawing for a new mode keeps the current stage
  const fit = () => { svg.classList.toggle("compact", narrow.matches); draw(svg, narrow.matches); };
  narrow.addEventListener("change", fit);
  fit();

  const steps = [...root.querySelectorAll(".steps [data-s]")];
  const phase = root.getElementById("phase");
  let stage = 0, elapsed = 0;
  function paintBars() {
    const frac = REDUCED ? 1 : Math.min(1, elapsed / DURATION[stage]);
    // each step knows whether it is done, playing or still ahead; --p is how far the playing one has run
    steps.forEach((b, k) => {
      b.dataset.state = k < stage ? "done" : k === stage ? "active" : "next";
      b.style.setProperty("--p", k < stage ? "1" : k === stage ? frac.toFixed(3) : "0");
    });
  }
  function show(s) {
    stage = s;
    elapsed = 0;
    setStage(svg, s);
    phase.textContent = s === 0 ? "Before Puente" : "With Puente";
    phase.classList.toggle("on", s > 0);
    steps.forEach((b, k) => b.setAttribute("aria-current", String(k === s)));
    paintBars();
    if (bus) bus.dispatchEvent(new CustomEvent("manifest-stage", { detail: { stage: s } }));
  }

  // Plays only while the scene is on screen and the tab is visible
  let inView = false, raf = 0, last = 0, keepStage = false;
  const shouldPlay = () => !REDUCED && inView && !document.hidden;
  function tick(now) {
    raf = 0;
    if (!shouldPlay()) { last = 0; return; }
    elapsed += last ? Math.min(100, now - last) : 0;
    last = now;
    if (elapsed >= DURATION[stage]) show((stage + 1) % steps.length);
    else paintBars();
    raf = requestAnimationFrame(tick);
  }
  const sync = () => { if (shouldPlay() && !raf) { last = 0; raf = requestAnimationFrame(tick); } };
  document.addEventListener("visibilitychange", sync);

  root.getElementById("steps").addEventListener("click", (e) => {
    const b = e.target.closest("[data-s]");
    if (b) show(Number(b.dataset.s));
  });

  // From the offering index or the scroll guide: bring the scene into view on the asked-for stage
  const KEYS = { engineering: 0 };
  const onGo = (e) => {
    const s = KEYS[e.detail && e.detail.key];
    if (s == null) return;
    keepStage = true; // arriving on purpose: don't rewind
    show(s);
    const top = root.getElementById("manifest").getBoundingClientRect().top + window.scrollY - NAV + 24;
    window.scrollTo({ top, behavior: REDUCED ? "auto" : "smooth" });
  };
  if (bus) bus.addEventListener("offering-go", onGo);

  // Hold the looping dashes and markers, and the stage clock, while the scene is off screen
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver(([en]) => {
        const entering = en.isIntersecting && !inView;
        inView = en.isIntersecting;
        if (entering && !keepStage) show(0);
        if (entering) keepStage = false;
        svg.classList.toggle("paused", !inView);
        sync();
      }, { threshold: 0.35 })
    : null;
  if (io) io.observe(root.querySelector(".grid"));
  else { inView = true; sync(); }

  show(0);

  return function cleanup() {
    if (raf) cancelAnimationFrame(raf);
    narrow.removeEventListener("change", fit);
    document.removeEventListener("visibilitychange", sync);
    if (bus) bus.removeEventListener("offering-go", onGo);
    if (io) io.disconnect();
  };
}

export default mount;
