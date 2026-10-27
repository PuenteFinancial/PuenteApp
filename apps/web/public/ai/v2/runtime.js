// V02 runtime (from Topsail, rebranded for Puente /ai). build_site.py pre-renders every section into a declarative shadow root, so
// the content is in the HTML before any script runs; this only starts each section's own script,
// with the same context the mockup composer gives it (a shared event bus and scroll-to-section).
// Section sources live in mockups/homepage-composer/sections; rebuild with build_site.py.

const NAV_H = 64;
const page = document.getElementById("page");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const bus = new EventTarget();

function scrollToSlot(slot) {
  const el = page.querySelector(`.slot[data-slot="${slot}"]`);
  if (!el) return false;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - NAV_H, behavior: reducedMotion ? "auto" : "smooth" });
  return true;
}

// Browsers without declarative shadow DOM leave the <template>: attach it by hand
for (const host of page.querySelectorAll(".slot__host")) {
  if (host.shadowRoot) continue;
  const t = host.querySelector("template[shadowrootmode]");
  if (!t) continue;
  host.attachShadow({ mode: "open" }).appendChild(t.content);
  t.remove();
}

// Import every section script at once, then mount top to bottom
const slots = [...page.querySelectorAll(":scope > .slot")];
const modules = await Promise.all(slots.map((s) =>
  import(`./sections/${s.dataset.id}/section.js`).catch((err) => { console.error(s.dataset.id, err); return null; })));
slots.forEach((slot, i) => {
  const mod = modules[i], host = slot.querySelector(".slot__host");
  if (!mod || !host.shadowRoot) return;
  try {
    mod.default(host.shadowRoot, { host, bus, reducedMotion, scrollTo: scrollToSlot });
  } catch (err) {
    console.error(slot.dataset.id, err);
  }
});

// "See our offering": the homepage's offering, or the first offer on the private equity page
document.querySelectorAll("[data-offer]").forEach((a) => a.addEventListener("click", (e) => {
  if (scrollToSlot("pillars") || scrollToSlot("proof")) e.preventDefault();
  const menu = document.getElementById("mobileMenu");
  if (menu && menu.classList.contains("open")) document.getElementById("navMenu").click();
}));

// Links into the homepage's offerings from other pages (/#strategy, /#engineering, /#evaluate).
// The sections sit in shadow roots, where the browser can't find the anchor, so ask the section
// that owns the key to bring itself into view, once the fonts have settled the layout.
const OFFER_KEYS = ["strategy", "engineering", "evaluate"];
function goToHash() {
  const key = location.hash.slice(1);
  if (OFFER_KEYS.includes(key)) bus.dispatchEvent(new CustomEvent("offering-go", { detail: { key } }));
}
window.addEventListener("hashchange", goToHash);
if (OFFER_KEYS.includes(location.hash.slice(1))) {
  if (document.fonts) await document.fonts.ready;
  goToHash();
}
