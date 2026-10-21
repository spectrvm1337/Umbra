// The selected row opens up in place into a large card that shows the thing itself -- an app's icon,
// a picture or gif, the head of a text file -- with what it is beside it. With the setting on that is
// always so (arrow keys move it); without, hold Shift+Space for a quick look and let go to fold it.
// The other rows stay as they are.
//
// The list is rebuilt from scratch on every keystroke, so nothing here holds on to a row: the card
// body is one element that is moved into whichever row is the anchor, and the anchor is worked out
// again whenever the lists change. When the selection moves, the new row is held where it is on
// screen while the row above it folds up.
// Loads are numbered, so a slow one never paints over a newer selection.

const SP_THUMB = 512;
const SP_TIMEOUT_MS = 1500;
const SP_ANIMATED = new Set(["gif", "webp", "apng"]);
const SP_ANIMATED_MAX_BYTES = 25 * 1024 * 1024;
const SP_GLYPHS = {
  folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"/>',
  url: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m.6-3h16.8M3.6 15h16.8"/><path d="M11.5 3a17 17 0 0 0 0 18m1-18a17 17 0 0 1 0 18"/>',
  file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2M9 9h1m-1 4h6m-6 4h6"/>',
  media: '<path d="M3 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0m10-1a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9 17V4l10-2v14"/>',
};

let spBody = null;
let spStage = null;
let spName = null;
let spMeta = null;
let spPath = null;
let spItem = null; // what the card is showing
let spKey = ""; // path|kind of that
let spRenderId = 0;
let spTimer = 0;
let spAnchor = null; // the open row
let spMuting = false;
const spCache = new Map(); // path -> Preview (or null)

const spT = (key) => (window.i18n ? window.i18n.t(key) : key);
let spHeld = false;
// Open all the time (the setting), or while Shift+Space is held.
const spOn = () => spHeld || document.documentElement.dataset.sidePreview === "on";

function spEnsure() {
  if (spBody) return;
  spBody = document.createElement("div");
  spBody.className = "sp-body";
  spBody.setAttribute("aria-hidden", "true");
  spBody.innerHTML =
    '<div class="sp-stage"></div>' +
    '<div class="sp-info"><div class="sp-name"></div><div class="sp-meta"></div><div class="sp-path result-path"></div></div>';
  spStage = spBody.querySelector(".sp-stage");
  spName = spBody.querySelector(".sp-name");
  spMeta = spBody.querySelector(".sp-meta");
  spPath = spBody.querySelector(".sp-path");
}

function spVisible(el) {
  return !!el && !el.classList.contains("hidden");
}

// Held, the card follows the selection wherever it goes. Open by the setting it follows the keyboard
// and the search only: a hovered row borrows the highlight, and opening under the pointer would
// slide the list away from it.
function spAnchorIndex() {
  return spHeld || selectionBeforeHover === null ? selectedIndex : selectionBeforeHover;
}

// How long the row's own size change takes (the card grows with it).
function spDuration() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--t-size").trim();
  const n = parseFloat(v);
  if (!(n >= 0)) return 260;
  return v.endsWith("ms") ? n : n * 1000;
}

// While the rows above fold up and this one grows, keeps it in view frame by frame, so the list
// follows the card instead of waiting for it to finish and then jumping. Only the latest move counts,
// which is what holding an arrow key needs.
let spFollowId = 0;
function spFollow(row, ms) {
  const box = document.getElementById("results-container");
  const id = ++spFollowId;
  const until = performance.now() + ms;
  const step = () => {
    if (id !== spFollowId || !row.isConnected) return;
    const r = row.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    if (r.height > c.height || r.top < c.top) box.scrollTop -= c.top - r.top;
    else if (r.bottom > c.bottom) box.scrollTop += r.bottom - c.bottom;
    if (typeof syncScrollFade === "function") syncScrollFade();
    if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function spPickAnchor() {
  if (!spOn()) return null;
  if (spVisible(settingsSection) || spVisible(specialSection)) return null;
  const item = selectableItems && selectableItems[spAnchorIndex()];
  if (!item || !item.path) return null;
  for (const list of [pinsList, resultsList]) {
    if (!spVisible(list.parentElement) && list !== resultsList) continue;
    const row = list.querySelector('.result-item[data-index="' + spAnchorIndex() + '"]');
    if (row) return row;
  }
  return null;
}

function spSelectedItem() {
  if (!selectableItems || !selectableItems.length) return null;
  const it = selectableItems[spAnchorIndex()];
  return it && it.path ? it : null;
}

// Opens the anchor row and closes the rest. Runs on every change to the lists, before the browser
// paints, so a new row never shows closed for a frame.
function spRefresh(live) {
  spEnsure();
  if (!spBody) return;
  if (document.body.classList.contains("is-dragging-pin")) return;
  const row = spPickAnchor();
  spMuting = true;
  document.querySelectorAll(".result-item.sp-open").forEach((el) => {
    if (el !== row) el.classList.remove("sp-open");
  });
  if (!row) {
    spBody.remove();
    spAnchor = null;
    spKey = "";
    spMuting = false;
    return;
  }
  if (row !== spAnchor) {
    // A move between rows or a row opened by the key, not a new list.
    if (live === undefined || live === null) live = !!spAnchor && spAnchor.isConnected;
    const small = live ? row.querySelector(".result-icon") : null;
    const from = small ? small.getBoundingClientRect() : null;
    spAnchor = row;
    spKey = "";
    spStage.innerHTML = "";
    const seed = spSeed(row);
    row.appendChild(spBody);
    row.classList.add("sp-open");
    if (seed && from && from.width) {
      // The row's own icon grows into the card: it starts where it was, small, and ends up in place.
      const to = spStage.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.height / 2);
      seed.animate([{ transform: "translateX(" + dx + "px)" }, { transform: "none" }], {
        duration: spDuration(), easing: "cubic-bezier(0.2, 1, 0.3, 1)",
      });
    }
    if (live) {
      const dur = spDuration();
      spFollow(row, dur + 80);
    }
  }
  spObservers.forEach((o) => o.takeRecords());
  spMuting = false;
  spUpdateContent();
  // The selection and its items may only settle just after the rows are drawn.
  requestAnimationFrame(spUpdateContent);
}

// The icon the row already has, put in the card at once so it is never empty while the real picture
// loads; spPaint fades the real one in over it.
function spSeed(row) {
  const item = selectableItems && selectableItems[Number(row.dataset.index)];
  const src = item && spRowIcon(item);
  if (!src) return null;
  const el = document.createElement("div");
  el.className = "sp-content sp-seed";
  el.innerHTML = '<img class="sp-icon" alt="">';
  el.firstChild.src = src;
  spStage.appendChild(el);
  spBody.classList.remove("sp-wide");
  return el.firstChild;
}

// What the card shows follows the anchor; fast arrowing is thinned out a little.
function spUpdateContent() {
  if (!spAnchor) return;
  const item = spSelectedItem();
  const key = item ? item.path + "|" + item.kind : "";
  if (key === spKey) return;
  spKey = key;
  clearTimeout(spTimer);
  spTimer = setTimeout(() => spPaint(item), spItem ? 40 : 0);
}

function spExt(path) {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.includes(".") ? base.split(".").pop().toLowerCase() : "";
}

function spTypeLabel(item, p) {
  switch (item.kind) {
    case "app": return spT("spApp");
    case "shortcut": return spT("spShortcut");
    case "folder": return spT("spFolder");
    case "system": return spT("spSystem");
    case "url": return spT("spLink");
    default: {
      const ext = spExt(item.path);
      return ext ? ext.toUpperCase() : spT("spFile");
    }
  }
}

function spGlyph(name) {
  return (
    '<svg class="sp-glyph ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" ' +
    'stroke-linejoin="round">' + (SP_GLYPHS[name] || SP_GLYPHS.file) + "</svg>"
  );
}

function spFetch(path) {
  if (spCache.has(path)) return Promise.resolve(spCache.get(path));
  const load = invoke("get_preview", { path, size: SP_THUMB }).then((p) => p || null).catch(() => null);
  const timeout = new Promise((r) => setTimeout(() => r(undefined), SP_TIMEOUT_MS));
  return Promise.race([load, timeout]).then((p) => {
    // A timeout is not remembered: the handler may only have been slow.
    if (p !== undefined) {
      spCache.set(path, p);
      if (spCache.size > 80) spCache.delete(spCache.keys().next().value);
    }
    return p || null;
  });
}

function spAssetUrl(path) {
  try {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.convertFileSrc === "function") return core.convertFileSrc(path);
  } catch {}
  return "";
}

// The row's own icon, for what the shell has no big picture of.
function spRowIcon(item) {
  return item.icon_data || (typeof iconCache !== "undefined" && iconCache.get(item.path)) || "";
}

async function spPaint(item) {
  const id = ++spRenderId;
  if (!item) return;
  spItem = item;
  const iconish = item.kind === "app" || item.kind === "shortcut" || item.kind === "system" || item.kind === "folder";
  const real = item.kind !== "system" && item.kind !== "url" && /^[a-zA-Z]:[\\/]|^\\\\/.test(item.path);
  const p = real ? await spFetch(item.path) : null;
  if (id !== spRenderId || !spBody) return;

  // ---- the stage: the thing itself ----
  let stage = "";
  const kind = p && p.kind;
  if (kind === "text" && p.text) {
    stage = '<pre class="sp-text"></pre>';
  } else if (kind === "video") {
    // Plays on its own, silently and in a loop, for as long as the card is on it.
    stage = '<video class="sp-photo" muted loop autoplay playsinline preload="auto"></video>';
  } else if (kind === "audio") {
    stage = spGlyph("media");
  } else if (spExt(item.path) === "pdf") {
    // The Shell only has the file-type icon for a PDF, so the webview's own PDF viewer shows the file.
    stage = '<iframe class="sp-pdf" tabindex="-1"></iframe>';
  } else if (p && p.thumb) {
    stage = '<img class="' + (iconish || kind === "other" ? "sp-icon" : "sp-photo") + '" alt="">';
  } else if (kind === "folder" || item.kind === "folder") {
    stage = spGlyph("folder");
  } else if (spRowIcon(item)) {
    stage = '<img class="sp-icon" alt="">';
  } else if (item.kind === "url") {
    stage = spGlyph("url");
  } else {
    stage = spGlyph(iconish ? "app" : "file");
  }
  // Icons keep to a square at the start of the card; pictures and text get more room.
  const pdfLive = spExt(item.path) === "pdf";
  spBody.classList.toggle("sp-wide", !!(p && (kind === "text" || kind === "video" || pdfLive || (p.thumb && !iconish && kind !== "other"))));
  const fresh = document.createElement("div");
  fresh.className = "sp-content";
  fresh.innerHTML = stage;
  const text = fresh.querySelector(".sp-text");
  if (text) text.textContent = p.text;
  const img = fresh.querySelector("img");
  if (img) {
    img.src = (p && p.thumb) || spRowIcon(item);
    // A gif is only animated from the file itself; the Shell thumbnail is a still of it.
    const ext = spExt(item.path);
    if (p && p.thumb && SP_ANIMATED.has(ext) && (p.size_bytes || 0) <= SP_ANIMATED_MAX_BYTES) {
      const live = new Image();
      live.addEventListener("load", () => { if (id === spRenderId) img.src = live.src; }, { once: true });
      live.src = spAssetUrl(item.path);
    }
  }
  const video = fresh.querySelector("video");
  if (video) {
    video.src = spAssetUrl(item.path);
    video.addEventListener("click", (e) => {
      e.stopPropagation();
      if (video.paused) video.play().catch(() => {}); else video.pause();
    });
    video.play().catch(() => {});
  }
  const pdf = fresh.querySelector("iframe");
  if (pdf) pdf.src = spAssetUrl(item.path) + "#toolbar=0&navpanes=0&scrollbar=0&view=FitH";
  const olds = [...spStage.querySelectorAll(".sp-content")];
  spStage.appendChild(fresh);
  olds.forEach((old) => {
    old.classList.add("sp-leaving");
    setTimeout(() => old.remove(), 220);
  });

  // ---- what it is ----
  spName.textContent = item.name || item.path;
  spName.title = item.path;
  const meta = [spTypeLabel(item, p)];
  if (p) {
    if (p.size_bytes != null && p.kind !== "folder" && p.kind !== "url") meta.push(spBytes(p.size_bytes));
    if (p.thumb_w && p.thumb_h && p.kind === "image") meta.push(p.thumb_w + "×" + p.thumb_h);
    if (p.modified_ms) meta.push(spWhen(p.modified_ms));
  }
  spMeta.textContent = meta.filter(Boolean).join("  ·  ");
  spPath.innerHTML = real || item.kind === "url" ? pathHtml(item.path) : "";
  spPath.hidden = !spPath.innerHTML;

}

function spBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + " " + units[i];
}
function spWhen(ms) {
  try {
    return new Date(Number(ms)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// Any change to the lists or to which row is selected, or to which section is on screen.
// (Two observers: observing one target twice with the same observer replaces the first options.)
let spObservers = [];
function spInit() {
  spEnsure();
  const onChange = () => {
    if (!spMuting) spRefresh();
  };

  const rowsChanged = new MutationObserver(onChange);
  const classesChanged = new MutationObserver(onChange);
  for (const list of [pinsList, resultsList]) {
    rowsChanged.observe(list, { childList: true });
    classesChanged.observe(list, { attributes: true, attributeFilter: ["class"], subtree: true });
  }
  for (const section of [pinsSection, resultsSection, specialSection, settingsSection]) {
    classesChanged.observe(section, { attributes: true, attributeFilter: ["class"] });
  }
  classesChanged.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  spObservers = [rowsChanged, classesChanged];
  spRefresh();
}

// Shift+Space down / up. Returns whether there is a row to open.
function spSetHeld(on) {
  if (on === spHeld) return on;
  spHeld = on;
  if (!on) {
    spRefresh();
    return false;
  }
  if (!spSelectedItem() || document.body.classList.contains("is-dragging-pin")) {
    spHeld = false;
    return false;
  }
  spRefresh(true);
  if (!spAnchor) spHeld = false;
  return spHeld;
}
const spRelease = () => spSetHeld(false);
// Capture phase, so the chord is taken before the search box can type the space.
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || hotkeyCapturing) return;
  // A repeat of the hold's key, or that key after a modifier came up, is not typing.
  const used = spHeld && kbIsBase(e, "previewHold") ? true : kbMatches(e, "previewHold") && spSetHeld(true);
  if (!used) return;
  e.preventDefault();
  e.stopPropagation();
}, true);
document.addEventListener("keyup", (e) => {
  // A modifier goes up before the key when the chord is typed fastest; either one ends the hold.
  if (kbReleases(e, "previewHold")) spRelease();
});
window.addEventListener("blur", spRelease);
document.addEventListener("visibilitychange", spRelease);

window.UmbraSidePreview = { refresh: spRefresh, hold: spSetHeld, held: () => spHeld };
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", spInit);
