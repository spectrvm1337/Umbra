// Background blur under the cards (theme.blurOn; drawn by blur.rs). Every frame the visible cards
// are measured and, when they moved, sent to Rust, which keeps one blurred sprite under each.

const BLUR_CARDS = "#search-box, .result-item, .special-card, #hint, #context-menu, #content-menu, #anim-menu, " +
  "#color-picker, #cc-pill, .cc-tool, .dock-tile, #setup";
const blurList = document.getElementById("results-wrapper");

let blurOn = false;
let blurSent = "";

// How opaque the card is on screen, its enter animation and its sections' fades included, so its
// blur fades in and out with it. The window's own fade is #app-container's and is done in Rust.
function blurOpacity(el) {
  let o = 1;
  for (let n = el; n && n !== appContainer; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
  return Math.round(o * 100) / 100;
}

// The page's px per #app-container px (the zoom).
function blurScale() {
  return appContainer.offsetHeight ? appContainer.getBoundingClientRect().height / appContainer.offsetHeight : 1;
}

// The column's move (--lift, pinsfold.js) is left out of the cards and done in Rust as an animation
// of its own (set_blur_lift), so the blur moves with the column instead of a frame or two behind it.
function blurColumnShift() {
  const t = getComputedStyle(appContainer).translate;
  const y = t && t !== "none" ? parseFloat(t.split(" ")[1]) || 0 : 0;
  return y * blurScale();
}

let blurLiftSent = null;
// Called by syncPinsFold with the column's new place, in #app-container px.
function blurLift(lift) {
  if (!blurOn) return;
  const y = Math.round(lift * blurScale() * (window.devicePixelRatio || 1) * 10) / 10;
  if (y === blurLiftSent) return;
  blurLiftSent = y;
  // The length the stylesheet gives `translate`: the fourth of #app-container's transitions.
  let ms = 0;
  if (!appContainer.classList.contains("lift-instant")) {
    const dur = (getComputedStyle(appContainer).transitionDuration.split(",")[3] || "0s").trim();
    ms = dur.endsWith("ms") ? parseFloat(dur) : parseFloat(dur) * 1000;
  }
  invoke("set_blur_lift", { y, ms: ms || 0 }).catch((err) => console.warn("blur lift:", err));
}

// The card's corner curve as the K of superellipse(K): 1 is a circular arc, 2 a squircle. Chromium
// may hand the computed value back as the keyword or as superellipse(2), so both are read; Rust draws
// the clip with the same curve.
function blurCornerK(cs) {
  const v = (cs.cornerTopLeftShape || cs.cornerShape || "round").trim().split(/\s+(?![^(]*\))/)[0];
  const m = /^superellipse\(\s*([-\d.]+)/.exec(v);
  if (m) return parseFloat(m[1]) || 1;
  return v === "squircle" ? 2 : 1;
}

function blurShapes() {
  const d = window.devicePixelRatio || 1;
  const list = blurList.getBoundingClientRect();
  const shift = blurColumnShift();
  const out = [];
  for (const el of document.querySelectorAll(BLUR_CARDS)) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    let { top, bottom } = r;
    // Rows scrolled out of the list are cut at its edge.
    if (blurList.contains(el)) {
      top = Math.max(top, list.top);
      bottom = Math.min(bottom, list.bottom);
    }
    const w = r.width, h = bottom - top;
    if (w < 1 || h < 1) continue;
    // The radius is in the card's own px; the rect is after zoom and transforms.
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1;
    const cs = getComputedStyle(el);
    const rad = Math.min((parseFloat(cs.borderTopLeftRadius) || 0) * scale, w / 2, h / 2);
    const px = [r.left, top - shift, w, h, rad].map((v) => Math.round(v * d * 10) / 10);
    out.push([...px, blurOpacity(el), blurCornerK(cs)]);
  }
  return out;
}

// The cards measured in one frame are sent in the next: the page reaches the screen through
// WebView2's renderer a frame later than the blur through DWM, so sent at once the blur ran ahead.
let blurPending = null;
// Measuring walks every card's parents through getComputedStyle, so it is skipped while nothing can
// have moved: no change to the page, no scroll or resize, and no animation or transition running.
let blurDirty = true;
const blurMarkDirty = () => { blurDirty = true; };
new MutationObserver(blurMarkDirty).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
addEventListener("scroll", blurMarkDirty, true);
addEventListener("resize", blurMarkDirty);
function blurFrame() {
  if (!blurOn) return; // applyBlur starts the loop again
  requestAnimationFrame(blurFrame);
  if (blurPending) {
    invoke("set_blur_shapes", { shapes: blurPending }).catch((err) => console.warn("blur:", err));
    blurPending = null;
  }
  if (!blurDirty && document.getAnimations().length === 0) return;
  blurDirty = false;
  const shapes = blurShapes();
  const key = JSON.stringify(shapes);
  if (key === blurSent) return;
  blurSent = key;
  blurPending = shapes;
}

// The blur is drawn by Windows, outside the page, so it does not fade with #app-container on its own:
// it is told to, with the same length as the container's opacity transition (its first one).
let blurShown = appContainer.classList.contains("window-showing");
new MutationObserver(() => {
  const shown = appContainer.classList.contains("window-showing");
  if (shown === blurShown) return;
  blurShown = shown;
  if (!blurOn) return;
  const first = getComputedStyle(appContainer).transitionDuration.split(",")[0].trim();
  const ms = first.endsWith("ms") ? parseFloat(first) : parseFloat(first) * 1000;
  invoke("set_blur_fade", { visible: shown, ms: ms || 0 }).catch((err) => console.warn("blur fade:", err));
}).observe(appContainer, { attributes: true, attributeFilter: ["class"] });

// Called by applyTheme (main.js).
function applyBlur(on) {
  const was = blurOn;
  blurOn = !!on;
  blurSent = ""; // a fresh blur gets the cards again
  blurDirty = true;
  blurLiftSent = null; // and the column's place
  if (!was && blurOn) {
    requestAnimationFrame(blurFrame);
    const lift = parseFloat(appContainer.style.getPropertyValue("--lift")) || 0;
    blurLift(lift);
  }
}
// The theme may have loaded before this file.
if (typeof theme !== "undefined" && theme) applyBlur(theme.blurOn);
