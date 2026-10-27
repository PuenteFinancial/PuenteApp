// V02 · 05 Private equity, in V01's private equity card. Answers 'offering-go' {key:'private-equity'}.
function mount(root, ctx) {
  var REDUCED = !!(ctx && ctx.reducedMotion);
  var bus = ctx && ctx.bus;
  function onGo(e) {
    if (!e.detail || e.detail.key !== "private-equity") return;
    var el = root.getElementById("private-equity");
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 64, behavior: REDUCED ? "auto" : "smooth" });
  }
  if (bus) bus.addEventListener("offering-go", onGo);
  // In the viewer or a review build, open the V02 private equity page in place; otherwise follow the link
  var card = root.querySelector(".pe a");
  function onCard(e) {
    if (window.__REVIEW) { e.preventDefault(); window.dispatchEvent(new CustomEvent("review:go", { detail: { page: "pe" } })); }
    else if (window.parent !== window) { e.preventDefault(); window.parent.postMessage({ type: "viewer:go", key: "v02-pe" }, location.origin); }
  }
  card.addEventListener("click", onCard);
  var rv = root.querySelectorAll(".rv");
  var io = null;
  if (REDUCED || !("IntersectionObserver" in window)) {
    rv.forEach(function (el) { el.classList.add("in"); });
  } else {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    rv.forEach(function (el, k) {
      el.style.transitionDelay = ((k % 3) * 80) + "ms";
      io.observe(el);
    });
  }
  return function cleanup() {
    if (bus) bus.removeEventListener("offering-go", onGo);
    card.removeEventListener("click", onCard);
    if (io) io.disconnect();
    io = null;
  };
}

export default mount;
