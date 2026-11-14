// The tree's lines (tree.js) as a layer of their own in the gutter left of the rows, not pieces of
// the rows: one line per opened row, drawn as one thing. When a row opens, its line leaves the row
// (┌) and runs down evenly, and as it passes each row it opened an arm reaches out to it (├, └ for
// the last), with that row coming in at the same moment. When the row closes the line draws itself
// back up. Between those it follows the rows wherever the layout puts them: a row opening into a
// card, rows gliding to a new place.

const tlLayer = document.createElement("div");
tlLayer.id = "tree-lines";
resultsContainer.appendChild(tlLayer);

// Opened node id → { el, top, v, arms, last, geo } (tlCreate).
const tlNodes = new Map();
// Corner radius, line width and the distance between the columns of two levels, in px; the gutter is
// the room left of the rows (the results' side padding).
const TL_R = 7;
const TL_W = 3;
const TL_COL = 6;
const TL_GUTTER = 20;
// The line's own curve: it starts and stops softly, so it reads as drawn rather than shot.
const TL_EASE = [0.4, 0, 0.2, 1];
const TL_ARM_MS = 150;

// The time (0..1) at which a cubic-bezier curve has covered `f` of its way.
function tlTimeAt(f, [x1, y1, x2, y2]) {
  const b = (s, a, c) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * c + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (b(m, y1, y2) < f) lo = m;
    else hi = m;
  }
  return b((lo + hi) / 2, x1, x2);
}

// Where each opened node's line goes now, in the results container's own coordinates: from the arm
// of the row that opened it down to the arm of the last row it shows. Arms meet a row at the middle
// of a plain row, so a row opened into a card has its arm at its title.
function tlMeasure() {
  const rows = [...resultsList.children].filter((el) => el._item);
  const byItem = new Map(rows.map((el) => [el._item, el]));
  const plain = Math.min(...rows.map((el) => el.offsetHeight).filter((h) => h > 0), Infinity);
  const armAt = (el) => el.offsetTop + Math.min(el.offsetHeight, plain) / 2;
  const nodes = new Map();
  for (const el of rows) {
    const it = el._item;
    if (!it.treeVia || !it.treeParent) continue;
    const parentEl = byItem.get(it.treeParent);
    if (!parentEl) continue;
    let n = nodes.get(it.treeVia);
    if (!n) {
      const x = parentEl.offsetLeft - TL_GUTTER + (it.treeDepth - 1) * TL_COL;
      n = { parentEl, x, w: Math.max(TL_W, el.offsetLeft - 2 - x), top: armAt(parentEl), rows: [], arms: [] };
      nodes.set(it.treeVia, n);
    }
    n.rows.push(el);
    n.arms.push(armAt(el));
  }
  for (const n of nodes.values()) n.h = Math.max(2 * TL_R, n.arms[n.arms.length - 1] - n.top);
  return nodes;
}

function tlPart(cls) {
  const el = document.createElement("i");
  el.className = cls;
  return el;
}

function tlCreate(geo, parent = tlLayer) {
  const el = document.createElement("div");
  el.className = "tl-node";
  const n = { el, top: tlPart("tl-top"), v: tlPart("tl-v"), arms: [], last: tlPart("tl-last"), geo: null };
  el.append(n.top, n.v);
  for (let i = 0; i < geo.arms.length - 1; i++) {
    const arm = tlPart("tl-arm");
    n.arms.push(arm);
    el.append(arm);
  }
  el.append(n.last);
  parent.append(el);
  tlPlace(n, geo, null);
  return n;
}

// Puts a node's line where `geo` says; with `glide` it moves there as the rows do.
function tlPlace(n, geo, glide) {
  const box = { left: geo.x, top: geo.top, width: geo.w, height: geo.h };
  const armTops = geo.arms.slice(0, -1).map((y) => y - geo.top - TL_W / 2);
  const old = n.geo;
  const same = old && old.left === box.left && old.top === box.top && old.width === box.width && old.height === box.height &&
    old.armTops.length === armTops.length && old.armTops.every((y, i) => y === armTops[i]);
  if (same) return;
  if (glide && old) {
    const px = (b) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    n.el.animate([px(old), px(box)], glide);
    n.arms.forEach((arm, i) => {
      if (old.armTops[i] !== undefined && old.armTops[i] !== armTops[i]) {
        arm.animate([{ top: `${old.armTops[i]}px` }, { top: `${armTops[i]}px` }], glide);
      }
    });
  }
  Object.assign(n.el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  n.arms.forEach((arm, i) => { arm.style.top = `${armTops[i]}px`; });
  n.geo = { ...box, armTops };
}

// Draws a new node's line, starting at `start` ms, and notes when its arm reaches each of its rows.
function tlDraw(n, geo, start, appear) {
  const len = Math.max(1, geo.h - 2 * TL_R);
  const down = Math.round(Math.min(650, Math.max(220, geo.h * 1.1)));
  const turn = 90; // the ┌ out of the row
  const backwards = { fill: "backwards" };
  n.top.animate([
    { clipPath: `inset(0 0 calc(100% - ${TL_W}px) 100%)` },
    { clipPath: `inset(0 0 calc(100% - ${TL_W}px) 0)`, offset: 0.7 },
    { clipPath: "inset(0)" },
  ], { duration: turn, delay: start, easing: "linear", ...backwards });
  n.v.animate([{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0)" }],
    { duration: down, delay: start + turn, easing: `cubic-bezier(${TL_EASE.join(",")})`, ...backwards });
  const reach = (y) => start + turn + down * tlTimeAt(Math.min(1, Math.max(0, (y - TL_R) / len)), TL_EASE);
  n.arms.forEach((arm, i) => {
    const at = reach(geo.arms[i] - geo.top);
    arm.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0)" }],
      { duration: TL_ARM_MS, delay: at, easing: "ease-out", ...backwards });
    appear.set(geo.rows[i], at);
  });
  const end = start + turn + down;
  n.last.animate([
    { clipPath: "inset(0 100% 100% 0)" },
    { clipPath: `inset(0 calc(100% - ${TL_W}px) 0 0)`, offset: 0.35 },
    { clipPath: "inset(0)" },
  ], { duration: TL_ARM_MS + 40, delay: end - 40, easing: "ease-out", ...backwards });
  appear.set(geo.rows[geo.rows.length - 1], end - 40);
}

// Brings the lines up to date with the rows. `created` (the rows a row's opening just added, their
// enter animation held back by renderResults) makes new lines draw themselves and those rows come
// in as their arms reach them; `glide` moves the lines that stay along with the rows' glide.
function tlSync({ created = null, glide = false } = {}) {
  const want = tlMeasure();
  const moveMs = motionMs("move", 550);
  for (const [id, n] of tlNodes) {
    if (want.has(id)) continue;
    tlNodes.delete(id);
    const back = Math.min(220, moveMs);
    if (back <= 0 || !n.geo) {
      n.el.remove();
      continue;
    }
    n.el.animate([{ clipPath: "inset(0 0 -10px 0)" }, { clipPath: "inset(0 0 100% 0)" }],
      { duration: back, easing: "ease-in", fill: "forwards" }).finished.then(() => n.el.remove(), () => n.el.remove());
  }
  const appear = new Map();
  const glideOpts = glide && moveMs > 0 ? { duration: moveMs, easing: motionEase() } : null;
  for (const [id, geo] of want) {
    let n = tlNodes.get(id);
    if (n) {
      tlPlace(n, geo, glideOpts);
      continue;
    }
    n = tlCreate(geo);
    tlNodes.set(id, n);
    // A line inside one being drawn starts when that one's arm reaches the row it comes out of.
    if (created && moveMs > 0) tlDraw(n, geo, appear.get(geo.parentEl) ?? 0, appear);
  }
  for (const el of created || []) {
    el.style.animation = "";
    if (appear.has(el)) el.style.animationDelay = `${Math.round(appear.get(el))}ms`;
  }
}

// After a render (main.js): the lines follow the new rows, and keep following them while they move.
function treeLinesAfterRender(opts = {}) {
  tlSync(opts);
  tlWatch();
}

// The window going away: no line is left for the next summon.
function treeLinesClear() {
  tlNodes.clear();
  tlLayer.replaceChildren();
}

// While anything in the list moves or changes size (a row opening into a card, rows gliding, the
// window resized) the lines are put in place every frame, then left alone.
let tlLoop = false;
let tlTail = 0;
function tlWatch() {
  tlTail = 3;
  if (tlLoop || !tlNodes.size) return;
  tlLoop = true;
  requestAnimationFrame(tlFrame);
}
function tlFrame() {
  tlSync();
  const moving = resultsList.getAnimations({ subtree: true })
    .some((a) => a.playState === "running" && a.effect && a.effect.getComputedTiming().endTime !== Infinity);
  if (moving) tlTail = 3;
  if (tlTail-- > 0 && tlNodes.size) requestAnimationFrame(tlFrame);
  else tlLoop = false;
}
for (const ev of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
  resultsList.addEventListener(ev, tlWatch, true);
}
addEventListener("resize", tlWatch);

// The same line in the setup tour's copy of the window: `container` (positioned, with the gutter on
// its left) gets the line from `parentEl` down to `rows`, drawn as the results draw theirs, and the
// rows (their enter animation held back) come in as it reaches them.
function treeLinesDemo(container, parentEl, rows) {
  const plain = Math.min(...[parentEl, ...rows].map((el) => el.offsetHeight));
  const armAt = (el) => el.offsetTop + Math.min(el.offsetHeight, plain) / 2;
  const x = parentEl.offsetLeft - TL_GUTTER;
  const geo = { parentEl, x, w: Math.max(TL_W, rows[0].offsetLeft - 2 - x), top: armAt(parentEl), rows, arms: rows.map(armAt) };
  geo.h = Math.max(2 * TL_R, geo.arms[geo.arms.length - 1] - geo.top);
  const n = tlCreate(geo, container);
  const appear = new Map();
  if (motionMs("move", 550) > 0) tlDraw(n, geo, 0, appear);
  for (const el of rows) {
    el.style.animation = "";
    if (appear.has(el)) el.style.animationDelay = `${Math.round(appear.get(el))}ms`;
  }
}
