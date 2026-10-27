// Isometric drafting kit shared by the V02 diagrams. Lifted from V02 "Where we came in"
// (Braden's original, commit 8a262f2) so every figure uses the same projection and faces.
//
//   const P = Iso(ox, oy, u);   P(x, y, z) -> [sx, sy]; x runs right-down, y left-down, z up
//   box(P, x, y, z, w, d, h, cls)   a prism with left, right and top faces
//   flat(P, x, y, z, w, d)          polygon points for a plane at height z
//   person(sx, sy, cls)             a small person glyph standing at a screen point

export const C30 = 0.8660254;

export const f1 = (n) => (Math.round(n * 10) / 10).toString();
export const pt = (a) => f1(a[0]) + "," + f1(a[1]);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export function Iso(ox, oy, u = 1) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const P = (x, y, z = 0) => {
    const s = [ox + (x - y) * C30 * u, oy + (x + y) * 0.5 * u - z * u];
    if (s[0] < b.x0) b.x0 = s[0];
    if (s[0] > b.x1) b.x1 = s[0];
    if (s[1] < b.y0) b.y0 = s[1];
    if (s[1] > b.y1) b.y1 = s[1];
    return s;
  };
  P.bounds = b;
  return P;
}

export function box(P, x, y, z, w, d, h, cls = "", attrs = "") {
  const t = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)];
  const l = [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)];
  const r = [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)];
  return `<g class="box ${cls}"${attrs}>` +
    `<polygon class="fl" points="${l.map(pt).join(" ")}"/>` +
    `<polygon class="fr" points="${r.map(pt).join(" ")}"/>` +
    `<polygon class="ft" points="${t.map(pt).join(" ")}"/></g>`;
}

export function flat(P, x, y, z, w, d) {
  return [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)].map(pt).join(" ");
}

export function person(sx, sy, cls = "") {
  return `<g class="ppl ${cls}" transform="translate(${f1(sx)},${f1(sy)})">` +
    `<path d="M-6,0 C-6,-12 6,-12 6,0 Z"/><circle cx="0" cy="-15" r="4.2"/></g>`;
}

export function setViewBox(svg, b, pad) {
  const [t, r, bt, l] = pad;
  svg.setAttribute("viewBox", `${f1(b.x0 - l)} ${f1(b.y0 - t)} ${f1(b.x1 - b.x0 + l + r)} ${f1(b.y1 - b.y0 + t + bt)}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

// Shared drafting styles, injected into each section's shadow root.
export const DRAFT_CSS = `
.dg{overflow:visible}
.dg .box polygon{stroke:var(--ink);stroke-width:.9;stroke-linejoin:round;stroke-opacity:.72;transition:fill .45s,stroke .45s}
.dg .ft{fill:#fff}.dg .fl{fill:#cedbc3}.dg .fr{fill:#e8eedf}
.dg .box.hl polygon{stroke:var(--hl-top,var(--accent));stroke-opacity:1}
.dg .box.hl .ft{fill:var(--hl-top,var(--accent))}.dg .box.hl .fl{fill:var(--hl-left,#2c5240)}.dg .box.hl .fr{fill:var(--hl-right,#4f8068)}
.dg .base{fill:none;stroke:var(--ink);stroke-opacity:.3;stroke-dasharray:3 4}
.dg text{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;fill:var(--ink);text-transform:uppercase;paint-order:stroke;stroke:var(--page);stroke-width:4px;stroke-linejoin:round}
.dg text.sm{font-size:9.5px;fill:var(--muted)}
.dg text.acc{fill:var(--accent)}
.dg .ppl path,.dg .ppl circle{fill:#fff;stroke:var(--ink);stroke-width:1}
`;
