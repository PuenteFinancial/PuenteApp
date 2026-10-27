// Client logo loop, ported from the live site's app.js: a continuous drift that can be
// dragged or flung. The track holds identical sets, so wrapping the offset by one set's width is
// seamless. Includes the live fix from bbc6bf5 (Oct 1): two sets leave a blank stretch before the
// wrap on screens wider than one set, so copies are added until the window is always covered.
function mount(root, ctx) {
  if (ctx.reducedMotion) return function () {};
  var mq = root.getElementById("mq");
  var track = root.getElementById("track");
  var set = track.querySelector(".marquee__set");
  mq.classList.add("is-live");
  var w = 0, x = 0, v = 0, cruise = 0, last = 0, raf = 0, visible = true;
  var dragging = false, px = 0, pt = 0;
  function fill() {
    if (w <= 0) return;
    var need = Math.ceil(mq.clientWidth / w) + 1; // one set plus the visible window
    var have = track.querySelectorAll(".marquee__set").length;
    for (var n = have; n < Math.min(need, 12); n++) {
      var copy = set.cloneNode(true);
      copy.setAttribute("aria-hidden", "true");
      copy.querySelectorAll("img").forEach(function (img) { img.alt = ""; img.draggable = false; });
      track.appendChild(copy);
    }
  }
  function measure() { w = set.getBoundingClientRect().width; cruise = -w / 40; fill(); } // one set every 40s
  measure();
  track.querySelectorAll("img").forEach(function (img) {
    img.draggable = false;
    if (!img.complete) img.addEventListener("load", measure);
  });
  v = cruise;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (!visible) return;
    if (!dragging) { v += (cruise - v) * Math.min(1, dt * 2.2); x += v * dt; } // a fling eases back to the drift
    if (w > 0) { x %= w; if (x > 0) x -= w; }
    track.style.transform = "translate3d(" + x.toFixed(2) + "px,0,0)";
  }
  raf = requestAnimationFrame(frame);
  function down(e) {
    if (e.button !== 0) return;
    dragging = true; px = e.clientX; pt = e.timeStamp; v = 0;
    mq.classList.add("is-dragging");
    try { mq.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function move(e) {
    if (!dragging) return;
    var dx = e.clientX - px, dts = (e.timeStamp - pt) / 1000;
    x += dx;
    if (dts > 0) v = 0.7 * Math.max(-3000, Math.min(3000, dx / dts)) + 0.3 * v;
    px = e.clientX; pt = e.timeStamp;
  }
  function release(e) {
    if (!dragging) return;
    dragging = false;
    if (e.timeStamp - pt > 90) v = 0; // held still before letting go: no fling
    mq.classList.remove("is-dragging");
    try { mq.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  mq.addEventListener("pointerdown", down);
  mq.addEventListener("pointermove", move);
  mq.addEventListener("pointerup", release);
  mq.addEventListener("pointercancel", release);
  window.addEventListener("resize", measure);
  var io = new IntersectionObserver(function (es) { visible = es[0].isIntersecting; last = 0; });
  io.observe(ctx.host);
  return function cleanup() {
    cancelAnimationFrame(raf);
    io.disconnect();
    window.removeEventListener("resize", measure);
    mq.removeEventListener("pointerdown", down);
    mq.removeEventListener("pointermove", move);
    mq.removeEventListener("pointerup", release);
    mq.removeEventListener("pointercancel", release);
  };
}

export default mount;
