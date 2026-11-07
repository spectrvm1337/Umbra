// Background blur under the cards (theme.blurOn; drawn by blur.rs). Every frame the visible cards
// are measured and, when they moved, sent to Rust, which keeps one blurred sprite under each.

// The menus and the colour picker too: with Blur on they are see-through cards (styles.css).
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

// The column's move (--lift, pinsfold.js) is the window's own now (set_window_lift), so the blur
// goes with it; nothing in the page is shifted. Kept for a translate a theme might add.
function blurColumnShift() {
  const t = getComputedStyle(appContainer).translate;
  const y = t && t !== "none" ? parseFloat(t.split(" ")[1]) || 0 : 0;
  return y * blurScale();
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
// The loop runs only while something can move: it is woken by a change to the page, a scroll or
// resize, or a transition or animation starting or ending, and goes back to sleep once nothing is
// running. Running every frame for good kept the renderer at a quarter of a core with the window
// open and idle (the blinking caret is an endless animation, so "no animations" was never true).
let blurDirty = true;
let blurLoop = false;
// Frames still measured after the last animation stops: animations started from script (the rows'
// glide) end without an event, and their last frame has to be caught.
let blurTail = 0;
function blurWake() {
  blurDirty = true;
  if (blurOn && !blurLoop) {
    blurLoop = true;
    requestAnimationFrame(blurFrame);
  }
}
// The typing examples in the empty box change its placeholder many times a second and move nothing.
// Neither do the rolling examples that replace it (#ph-roll), which turn over every few seconds.
const blurIgnored = (node) => {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return !!(el && el.closest && el.closest("#ph-roll"));
};
new MutationObserver((records) => {
  if (records.some((r) => r.attributeName !== "placeholder" && !blurIgnored(r.target))) blurWake();
}).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
// Pointer moves too: with Animations off a hover that resizes a card starts no transition at all.
for (const ev of ["scroll", "transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend",
  "pointerover", "pointerout"]) {
  addEventListener(ev, (e) => {
    if (!blurIgnored(e.target)) blurWake();
  }, true);
}
addEventListener("resize", blurWake);
// Endless animations (the caret's blink, pulses) never move a card, so only ones that end count.
function blurMoving() {
  return document.getAnimations().some((a) => a.playState === "running" && a.effect
    && a.effect.getComputedTiming().endTime !== Infinity);
}
function blurFrame() {
  blurLoop = false;
  if (!blurOn) return; // applyBlur wakes the loop again
  if (blurPending) {
    invoke("set_blur_shapes", { shapes: blurPending }).catch((err) => console.warn("blur:", err));
    blurPending = null;
  }
  if (blurMoving()) blurTail = 3;
  if (blurDirty || blurTail > 0) {
    if (blurTail > 0) blurTail--;
    blurDirty = false;
    const shapes = blurShapes();
    const key = JSON.stringify(shapes);
    if (key !== blurSent) {
      blurSent = key;
      blurPending = shapes;
    }
  }
  if (blurPending || blurTail > 0) {
    blurLoop = true;
    requestAnimationFrame(blurFrame);
  }
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
  blurOn = !!on;
  blurSent = ""; // a fresh blur gets the cards again
  blurWake();
}
// The theme may have loaded before this file.
if (typeof theme !== "undefined" && theme) applyBlur(theme.blurOn);
