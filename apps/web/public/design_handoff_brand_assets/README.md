# Handoff: Puente Financial — Brand Assets (favicon, logo, OG image)

## Overview
This bundle contains the launch brand assets for **Puente Financial** — a credit-building
remittance app (USD → MXN today; no card product, see below). It delivers a simplified
single-color **bridge mark** (a *puente*), a favicon set, standalone logo files, and a
social/Open-Graph share image.

> **Superseded framing, kept for history:** this doc originally described a "remittance-backed
> credit card" concept. That framing is dead — the shipped product is the app itself (send
> money, build credit doing it), not a card. See `apps/web/PRODUCT.md` § Positioning /
> Brand Commitments for the current, authoritative framing. The mark/logo/favicon files below
> are still current and accurate; only the old product-framing prose has been corrected here.

The mark is provided as **production-ready SVG/PNG** — you do not need to recreate it, just
place the files and add the markup below.

**Typography note:** the wordmark spec below (Hanken Grotesk alone) predates the shipped type
system. The live site pairs **Bricolage Grotesque** (display/headings) with **Hanken Grotesk**
(body) and **Space Mono** (monospace accent) — see `apps/web/app/layout.tsx`. Hanken Grotesk is
still correct for the wordmark lockup itself; don't extend it to headings/body copy.

**Compliance note:** credit reporting/furnishing to bureaus is **not built** (no furnisher
integration exists). Marketing copy must keep credit-building claims forward-looking
("coming soon"), never present-tense, until that ships and counsel signs off — see
`apps/web/PRODUCT.md` § Capabilities and Constraints and the guard comment in
`packages/shared/src/i18n/translations.ts` above the `hero.pills` copy.

## Fidelity
**High-fidelity / final.** Colors, geometry, and proportions are final. The SVG/PNG files are
the real exported assets — ship them as-is. The two `*.html` files are *references only*
(a brand-kit board and the OG-image generator); do not ship them.

## The Mark
A three-arch stone-bridge silhouette, reduced to **one solid shape in one color** (no rail, no
multi-color detail). It reads as a bridge at large sizes and as a clean glyph at favicon sizes.
- **Single path**, `fill-rule="evenodd"` (the three arches are knocked out as negative space).
- `mark.svg` uses `fill="currentColor"` — recolor it by setting CSS `color` on the SVG.
- Default brand color is **Blue `#2D6BE4`**; use **White `#FFFFFF`** on blue/photo, **Navy
  `#0F2B4A`** on light backgrounds.
- Aspect ratio is fixed at **240 × 116** (≈ 2.07:1). Never stretch — scale by width.

### Wordmark / lockup
`Puente` in **Hanken Grotesk 900**, followed by `Financial` in **Hanken Grotesk 600** at the
muted color `#93A8C4`. Mark sits left of the wordmark, vertically centered, gap ≈ 0.32em of the
mark height. Letter-spacing `-0.02em`.

## Design Tokens
| Token | Hex | Use |
|-------|-----|-----|
| Navy | `#0F2B4A` | Primary background, favicon tile, mark on light bg |
| Navy Deep | `#0B2138` | Darkest background |
| Blue | `#2D6BE4` | Primary brand / mark / CTA |
| Orange | `#F6A724` | Spanish tagline accent |
| Green | `#4BDE80` | "Now accepting waitlist" status |
| Ink | `#F4F8FF` | Primary text on dark |
| Muted | `#93A8C4` | Secondary text, "Financial" suffix |

- **Font:** Hanken Grotesk (Google Fonts) — weights 400/600/700/800/900.
- **Favicon tile radius:** 24% of tile size (`rx=15` on a 64px tile).
- **OG image:** 1200 × 630, navy `#0F2B4A` ground with a radial blue glow top-right and a faint
  62px grid masked to the upper-left.

## Files
| File | What it is | Where it goes |
|------|-----------|---------------|
| `mark.svg` | Logo mark, `currentColor`, transparent | Header/nav logo (recolor via CSS) |
| `mark-blue.png` / `mark-white.png` / `mark-navy.png` | 960px raster marks, transparent | Fallback / email / non-SVG contexts |
| `favicon.svg` | Blue bridge on navy rounded tile | `/favicon.svg` |
| `favicon-32.png` / `favicon-16.png` | PNG favicons | `/` root |
| `favicon-192.png` / `favicon-512.png` | PWA / Android icons | referenced from web manifest |
| `apple-touch-icon.png` | 180px iOS home-screen icon | `/apple-touch-icon.png` |
| `og-image.png` | 1200×630 social share image | `/og-image.png` (or CDN) |
| `og-final2.html` | *Reference* — OG generator (not shipped) | — |
| `logo-explore.html` | *Reference* — brand board showing the mark, treatments, favicon sizes (not shipped) | — |

## Drop-in `<head>` snippet
This is illustrative markup only — `apps/web/app/layout.tsx` already wires favicons and OG/Twitter
tags via Next.js `metadata`, with current copy. Don't copy the old title/description text below;
it's kept only to show the tag shape.
```html
<!-- Favicons -->
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">

<!-- Open Graph (see app/layout.tsx `metadata.openGraph` for the current, real copy) -->
<meta property="og:type" content="website">
<meta property="og:title" content="Puente Financial | Send money home. Build U.S. credit doing it.">
<meta property="og:description" content="Send money home for $5 flat at the real exchange rate, and build your U.S. credit history with every payment. One app, built for newcomers.">
<meta property="og:image" content="https://YOUR_DOMAIN/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Puente Financial | Send money home. Build U.S. credit doing it.">
<meta name="twitter:description" content="Send money home for $5 flat at the real exchange rate, and build your U.S. credit history with every payment. One app, built for newcomers.">
<meta name="twitter:image" content="https://YOUR_DOMAIN/og-image.png">
```

### `site.webmanifest`
```json
{
  "name": "Puente Financial",
  "short_name": "Puente",
  "icons": [
    { "src": "/favicon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/favicon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#0F2B4A",
  "background_color": "#0B2138",
  "display": "standalone"
}
```

### Header logo markup
```html
<a href="/" class="logo" aria-label="Puente Financial — home">
  <!-- mark.svg inline; set color to recolor -->
  <svg width="40" viewBox="0 0 240 116" fill="none" style="color:#2D6BE4">
    <path fill="currentColor" fill-rule="evenodd"
      d="M8 108 L8 58 Q120 30 232 58 L232 108 Z M40 108 L40 78 A20 20 0 0 1 80 78 L80 108 Z M100 108 L100 78 A20 20 0 0 1 140 78 L140 108 Z M160 108 L160 78 A20 20 0 0 1 200 78 L200 108 Z"/>
  </svg>
  <span class="wordmark">Puente <span class="suffix">Financial</span></span>
</a>
```

## Notes
- Generate a `favicon.ico` (16+32+48) from `favicon-32.png` if you need legacy browser support;
  modern browsers use `favicon.svg`.
- If the OG image is re-rendered, use `og-final2.html` as the source of truth for layout/copy.
- Keep clear space around the mark equal to the height of one arch.
