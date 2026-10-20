// File preview: hold Shift+Space for a quick look, Alt+Enter (or Shift+click, or the
// context menu) for the full one. Which shape it takes is a setting, `overlay` or
// `popup`.
//
// Two things shape the design. The results list is rebuilt from scratch on every
// keystroke (performSearch), so nothing here may hold on to a row: everything is
// re-resolved from `selectedIndex` and discarded when the selection moves. And a
// preview that is still loading must never resurrect itself afterwards, so every
// async step checks a generation counter before touching the DOM -- the same
// guard currency.js uses for its rate table.

const PV_THUMB_SIZE = 320; // peek
const PV_THUMB_SIZE_FULL = 560; // full preview
const PV_TIMEOUT_MS = 1200; // the UI stops waiting; the Rust thread may linger
const PV_CACHE_MAX = 60;

const PV_ICON = {
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  url: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  media: '<path d="M5 3l14 9-14 9V3z"/>',
  none: '<circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/>',
};

const pvCache = new Map(); // "path|size" -> Preview or null
let pvCacheOrder = [];

function pvCacheGet(key) {
  if (!pvCache.has(key)) return undefined;
  const v = pvCache.get(key);
  // Refresh recency.
  pvCacheOrder = pvCacheOrder.filter((k) => k !== key);
  pvCacheOrder.push(key);
  return v;
}
function pvCacheSet(key, value) {
  pvCache.set(key, value);
  pvCacheOrder = pvCacheOrder.filter((k) => k !== key);
  pvCacheOrder.push(key);
  while (pvCacheOrder.length > PV_CACHE_MAX) {
    pvCache.delete(pvCacheOrder.shift());
  }
}

function pvEscape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function pvNum(n) {
  if (!n && n !== 0) return "";
  return Number(n).toLocaleString(document.documentElement.lang || undefined);
}
function pvBytes(n) {
  if (n === null || n === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + " " + units[i];
}
function pvWhen(ms) {
  if (!ms) return "";
  try {
    return new Date(Number(ms)).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

let pvStyle = "overlay";
let pvPanel = null;
let pvBody = null;
let pvTitle = null;
let pvMeta = null;
let pvActions = null;
let pvTrack = null;
let pvThumb = null;
let pvTrackFade = null;
let pvLastPointer = null;
let pvSeg = null;
let pvPaintSeg = null;

// Called when the settings panel opens, so the switch always shows the mode
// that is actually in effect.
function pvRefreshSettings() {
  if (pvPaintSeg) pvPaintSeg(pvStyle);
}
let pvOpen = false;
let pvMode = null; // "peek" | "full"
let pvItem = null;
let pvAnchor = null; // {x, y} for popup mode
let pvRenderId = 0;

// Kinds the index already labels, for which there is nothing to show: an
// executable has no readable head and the Shell has no thumbnail handler that
// says anything useful, and a folder is not a file. Rather than opening a panel
// that would immediately have to close again, these are refused up front.
const PV_NO_PREVIEW_KINDS = new Set(["app", "shortcut", "system", "folder"]);

function pvSelected() {
  if (selectedIndex < 0 || selectedIndex >= selectableItems.length) return null;
  const it = selectableItems[selectedIndex];
  return it && it.path && !["help", "copy", "open"].includes(it.kind) ? it : null;
}

// Settings and the right-click menu own the window while they are up.
function pvBlocked() {
  const settings = document.getElementById("settings-section");
  if (settings && !settings.classList.contains("hidden")) return true;
  const menu = document.getElementById("context-menu");
  return !!(menu && menu.classList.contains("visible"));
}

function pvAllowed(item) {
  if (!item) return false;
  if (PV_NO_PREVIEW_KINDS.has(item.kind)) return false;
  return !pvBlocked();
}

function pvEnsure() {
  if (pvPanel) return;
  pvPanel = document.createElement("div");
  pvPanel.id = "preview-panel";
  pvPanel.className = "pv-hidden";
  pvPanel.setAttribute("role", "dialog");
  pvPanel.setAttribute("aria-label", t("pvTitle"));
  pvPanel.innerHTML =
    '<div class="pv-head"><span class="pv-title"></span>' +
    '<button class="pv-close" type="button" data-pv-action="close" aria-label="' +
    pvEscape(t("pvClose")) +
    '"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/>' +
    '<line x1="10" y1="2" x2="2" y2="10"/></svg></button></div>' +
    '<div class="pv-wrap">' +
    '<div class="pv-body"></div>' +
    '<div class="pv-scrollbar"><div class="pv-thumbbar"></div></div>' +
    "</div>" +
    '<div class="pv-meta"></div>' +
    '<div class="pv-actions"></div>';
  pvTitle = pvPanel.querySelector(".pv-title");
  pvBody = pvPanel.querySelector(".pv-body");
  pvMeta = pvPanel.querySelector(".pv-meta");
  pvActions = pvPanel.querySelector(".pv-actions");
  pvTrack = pvPanel.querySelector(".pv-scrollbar");
  pvThumb = pvPanel.querySelector(".pv-thumbbar");
  // On <body>, not inside #app-container: that element carries a transform and a
  // filter while the window animates, which makes it the containing block for
  // anything absolutely positioned inside it. The panel is position:fixed and
  // measured against the viewport, so it has to sit outside all of that -- which
  // is also why clicks reached the list through it before.
  document.body.appendChild(pvPanel);

  // A click inside the panel must not read as "clicked outside the window",
  // which hideWindow treats as a dismissal. stopPropagation is enough: nothing
  // here calls preventDefault, so text selection inside still works.
  pvPanel.addEventListener("pointerdown", (e) => e.stopPropagation());
  pvPanel.addEventListener("click", (e) => {
    const action = e.target.closest("[data-pv-action]");
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    pvRunAction(action.dataset.pvAction);
  });
  pvActions.addEventListener("keydown", (e) => e.stopPropagation());
  pvBody.addEventListener("scroll", () => pvSyncScrollbar(), { passive: true });

  // Dragging the bar scrolls, same as the one over the results list.
  pvThumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startTop = pvThumb.offsetTop;
    let trackH = 0;
    let thumbH = 0;
    const measure = () => {
      trackH = pvTrack ? pvTrack.clientHeight : 0;
      thumbH = pvThumb.offsetHeight;
    };
    measure();
    try { pvThumb.setPointerCapture(e.pointerId); } catch {}
    const onMove = (ev) => {
      const room = trackH - thumbH;
      if (room <= 0) return;
      let next = startTop + (ev.clientY - startY);
      next = Math.max(0, Math.min(room, next));
      pvThumb.style.top = next + "px";
      const range = pvBody.scrollHeight - pvBody.clientHeight;
      if (range > 0) pvBody.scrollTop = (next / room) * range;
    };
    const onUp = () => {
      pvThumb.removeEventListener("pointermove", onMove);
      pvThumb.removeEventListener("pointerup", onUp);
      pvThumb.removeEventListener("pointercancel", onUp);
      pvSyncScrollbar();
    };
    pvThumb.addEventListener("pointermove", onMove);
    pvThumb.addEventListener("pointerup", onUp);
    pvThumb.addEventListener("pointercancel", onUp);
  });
}

function pvIcon(kind) {
  const d = PV_ICON[kind] || PV_ICON.none;
  return (
    '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    d +
    "</svg>"
  );
}

// ---- opening and closing ----

// A peek is a glance: a small card, sized to its content, riding along with the
// pointer. It never takes over the list, because the list is what you are using
// while you hold the key -- arrowing through results while watching the card.
const PV_PEEK_MAX_W = 260;
const PV_PEEK_MAX_H = 260;
const PV_POPUP_W = 360;
// The ceiling for the full preview. Still content-sized, just with more room to
// breathe: never wider or taller than the results area it sits over.
const PV_FULL_MAX = 520;
const PV_CURSOR_GAP = 14;

function pvOpenFor(mode, item, anchor) {
  pvEnsure();
  const target = item || pvSelected();
  if (!pvAllowed(target)) return false;
  pvMode = mode;
  pvItem = target;
  pvAnchor = anchor || null;
  pvPanel.dataset.mode = mode;
  pvPanel.dataset.size = mode === "peek" ? "compact" : "full";
  pvPanel.dataset.kind = target.kind || "file";
  pvPanel.classList.remove("pv-hidden");
  pvPanel.classList.add("pv-open");
  pvOpen = true;
  if (mode === "peek" && !pvAnchor) {
    // Place at the pointer even before it moves again.
    const here = pvLastPointer;
    pvAnchor = here ? { x: here.x, y: here.y } : null;
  }
  pvRender(target, mode);
  pvPlace();
  // Re-placed once the content has a size; a card is positioned from it.
  requestAnimationFrame(() => {
    if (!pvOpen) return;
    pvPlace();
    pvSyncScrollbar();
  });
  return true;
}

function pvClose() {
  if (!pvOpen) return;
  pvOpen = false;
  pvMode = null;
  pvItem = null;
  pvAnchor = null;
  // Bump the generation so an in-flight load cannot repaint a closed panel.
  pvRenderId++;
  // Both classes have to go. .pv-open is the later rule of the two, so leaving it
  // on kept visibility and opacity and the panel only ever shrank to
  // scale(0.96) instead of closing.
  if (pvPanel) {
    pvPanel.classList.add("pv-hidden");
    pvPanel.classList.remove("pv-open");
  }
  if (pvActions) pvActions.innerHTML = "";
  if (pvThumb) pvThumb.style.display = "none";
}

function pvIsOpen() {
  return pvOpen;
}

// ---- placement ----
// The panel is position:fixed on <body>, so everything here is in viewport
// coordinates divided by the UI zoom, the same convention #context-menu uses.

function pvZoom() {
  const z = typeof uiZoom === "function" ? uiZoom() : 1;
  return z > 0 ? z : 1;
}

function pvListBox() {
  const list = document.getElementById("results-container");
  if (!list) return null;
  const r = list.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function pvPlace() {
  if (!pvOpen || !pvPanel) return;
  const peek = pvPanel.dataset.size === "compact";
  // A peek rides along with the pointer whatever the setting says -- it is
  // glanced at, not worked in. Both sizes hug their content; the setting only
  // decides where the full preview sits.
  if (peek || pvStyle === "popup") {
    pvPlaceCursor();
  } else {
    pvPlaceOverlay();
  }
}

// Drops the panel's own size so the content decides it, then measures what came
// out. Shared by both placements, which differ only in where they put the result.
function pvFitToContent(maxW, maxH) {
  pvPanel.style.width = "auto";
  pvPanel.style.height = "auto";
  pvPanel.style.maxWidth = maxW + "px";
  pvPanel.style.maxHeight = maxH + "px";
  return {
    w: Math.min(pvPanel.offsetWidth || maxW, maxW),
    h: Math.min(pvPanel.offsetHeight || 120, maxH),
  };
}

function pvPlaceOverlay() {
  const box = pvListBox();
  if (!box) return;
  const z = pvZoom();
  const maxW = Math.max(160, Math.min(PV_FULL_MAX, box.width - 24));
  const maxH = Math.max(120, Math.min(PV_FULL_MAX, box.height - 24));
  pvPanel.style.left = "0px";
  pvPanel.style.top = "0px";
  const size = pvFitToContent(maxW, maxH);
  // Centred over the results area, and never wider or taller than it.
  pvPanel.style.left = (box.left + (box.width - size.w) / 2) / z + "px";
  pvPanel.style.top = (box.top + (box.height - size.h) / 2) / z + "px";
}

// Hug contents: the width and height are left to the content and only the caps
// are ours, so an image keeps its own shape, a few lines of text stay short, and
// a bare filename does not become a wide empty box. The element is then measured
// from its real size and placed, flipping to stay inside the window.
function pvPlaceCursor() {
  const anchor = pvAnchor || pvAnchorForItem();
  if (!anchor) {
    pvPlaceOverlay();
    return;
  }
  const isPeek = pvPanel.dataset.size === "compact";
  const z = pvZoom();
  const vw = window.innerWidth * z;
  const vh = window.innerHeight * z;
  const maxW = Math.min(isPeek ? PV_PEEK_MAX_W : PV_POPUP_W, vw - 16);
  const maxH = Math.min(isPeek ? PV_PEEK_MAX_H : PV_FULL_MAX, vh - 16);

  pvPanel.style.left = "0px";
  pvPanel.style.top = "0px";
  const size = pvFitToContent(maxW, maxH);
  let x = anchor.x + PV_CURSOR_GAP;
  let y = anchor.y + PV_CURSOR_GAP;
  if (x + size.w > vw - 8) x = Math.max(8, anchor.x - size.w - PV_CURSOR_GAP);
  if (y + size.h > vh - 8) y = Math.max(8, anchor.y - size.h - PV_CURSOR_GAP);
  pvPanel.style.left = x / z + "px";
  pvPanel.style.top = y / z + "px";
}

// Re-placing reads offsetWidth after writing styles, so a pointer trail is
// collapsed into one measurement per frame rather than one per event.
let pvFollowRaf = 0;
function pvFollowCursor(x, y) {
  pvAnchor = { x, y };
  if (pvFollowRaf) return;
  pvFollowRaf = requestAnimationFrame(() => {
    pvFollowRaf = 0;
    if (pvOpen && pvPanel.dataset.size === "compact") pvPlaceCursor();
  });
}

// With no pointer of its own -- opened from the keyboard, say -- the card
// hangs off the row it describes.
function pvAnchorForItem() {
  const el = document.querySelector(".result-item.selected");
  if (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + 48, y: r.bottom - 4 };
  }
  return null;
}

// ---- rendering ----

function pvRender(item, mode) {
  const id = ++pvRenderId;
  const path = item.path;
  const size = mode === "full" ? PV_THUMB_SIZE_FULL : PV_THUMB_SIZE;
  const key = path + "|" + size;

  pvTitle.textContent = item.name || path;
  pvTitle.title = path;
  pvMeta.innerHTML = "";
  pvActions.innerHTML = "";
  pvBody.innerHTML = '<div class="pv-loading"><span class="pv-spinner"></span></div>';

  const cached = pvCacheGet(key);
  if (cached !== undefined) {
    if (cached) pvPaint(id, item, mode, cached);
    else pvPaintUnavailable(id, item, t("pvFailed"));
    return;
  }

  let settled = false;
  // The wait is capped on this side deliberately: a Shell thumbnail provider
  // that has gone out-of-process can block indefinitely, and cancelling that
  // needs a thread we can actually abort. The panel gives up instead and the
  // worker finishes on its own. A timeout is deliberately not cached, because
  // the handler may only have been slow rather than stuck.
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (id === pvRenderId && pvOpen) pvPaintUnavailable(id, item, t("pvTimeout"));
  }, PV_TIMEOUT_MS);

  invoke("get_preview", { path, size })
    .then((p) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pvCacheSet(key, p || null);
      if (p) pvPaint(id, item, mode, p);
      else pvPaintUnavailable(id, item, t("pvFailed"));
    })
    .catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = String(err || "").replace(/^Error:\s*/, "").trim();
      if (id === pvRenderId && pvOpen) pvPaintUnavailable(id, item, msg || t("pvFailed"));
    });
}

function pvPaint(id, item, mode, p) {
  if (id !== pvRenderId || !pvOpen) return;

  // Nothing came back that can be shown. Rather than leave an empty panel
  // sitting over the list, close it and say so -- a file with no preview is not
  // something to press Alt+Enter on twice.
  if (!pvHasContent(p)) {
    const name = item.name || p.path;
    pvClose();
    if (typeof showToast === "function") showToast(t("pvNone"), false, name);
    return;
  }

  pvTitle.textContent = item.name || p.path;

  if (pvIsMedia(p.kind)) {
    pvPaintMedia(item, mode, p);
  } else if (p.kind === "text" && p.text) {
    pvBody.innerHTML = '<pre class="pv-text"></pre>' + (p.truncated ? '<div class="pv-more">…</div>' : "");
    pvBody.querySelector(".pv-text").textContent = p.text;
  } else if (p.thumb) {
    // Arrowing through results with the peek held swaps one picture for another,
    // and a hard cut reads as a glitch. The outgoing one fades out under the
    // incoming one instead of being torn out.
    const outgoing = pvBody.querySelector(".pv-thumb, .pv-media");
    if (mode === "peek" && outgoing) {
      const next = new Image();
      next.alt = item.name || "";
      next.className = "pv-thumb";
      // Only swap once the incoming picture has decoded, so the fade never
      // plays over an empty box.
      next.addEventListener("load", () => pvSwapStill(outgoing, "<img>"), { once: true });
      next.src = p.thumb;
      pvMeta.textContent = "";
      return;
    }
    pvBody.innerHTML = '<img class="pv-thumb" alt="">';
    const img = pvBody.querySelector(".pv-thumb");
    img.src = p.thumb;
    img.alt = item.name || "";
  } else {
    pvBody.innerHTML = '<div class="pv-url"></div>';
    pvBody.querySelector(".pv-url").textContent = p.path;
  }

  const meta = [];
  if (p.kind !== "url" && p.kind !== "folder") meta.push(pvBytes(p.size_bytes));
  if (p.modified_ms) meta.push(pvWhen(p.modified_ms));
  if (p.encoding && p.kind === "text") meta.push(p.encoding);
  if (p.thumb_w && p.thumb_h && p.kind === "image") meta.push(p.thumb_w + "×" + p.thumb_h);
  // Media fills in its duration and dimensions from the element itself once the
  // metadata arrives; writing the line here would just be replaced.
  if (!pvIsMedia(p.kind)) pvMeta.textContent = meta.filter(Boolean).join("  ·  ");

  if (mode === "full") pvPaintActions(p);
  // Media shows its own line once the element reports; anything else can go in
  // now.
  if (pvIsMedia(p.kind)) {
    pvMeta.textContent = [pvBytes(p.size_bytes), pvWhen(p.modified_ms)].filter(Boolean).join("  ·  ");
  }
  // The content decides both the card's size and whether there is anything to
  // scroll, so the panel is placed and its bar drawn after painting.
  requestAnimationFrame(() => {
    if (id !== pvRenderId || !pvOpen) return;
    pvPlace();
    pvSyncScrollbar();
  });
}

// A preview is a picture, some text, something playable, or a URL. Media counts
// even with no Shell thumbnail: .webm and .mkv have none, and the player covers
// them. A directory, an executable or an extension nothing can open arrives with
// none of those, and is not worth a panel.
function pvHasContent(p) {
  if (!p) return false;
  return !!(p.thumb || p.text || p.kind === "url" || pvIsMedia(p.kind));
}

function pvPaintActions(p) {
  const isUrl = p.kind === "url";
  const buttons = [
    ["open", t("pvOpen"), isUrl],
    ["reveal", t("pvReveal"), p.kind === "folder" || isUrl],
    ["admin", t("pvAdmin"), p.kind !== "folder" && !isUrl],
  ];
  pvActions.innerHTML = buttons
    .filter(([, , show]) => show)
    .map(([action, label]) => '<button class="pv-btn" data-pv-action="' + action + '">' + pvEscape(label) + "</button>")
    .join("");
}

// The invoke itself failing is worth showing rather than swallowing: an empty
// panel would read as "this file has no preview" when in fact the backend did
// not answer.
function pvPaintUnavailable(id, item, reason) {
  if (id !== pvRenderId || !pvOpen) return;
  pvBody.innerHTML = '<div class="pv-note"></div>';
  pvBody.querySelector(".pv-note").textContent = reason || t("pvFailed");
  pvMeta.textContent = "";
}

function pvRunAction(action) {
  const item = pvItem;
  if (action === "close") {
    pvClose();
    return;
  }
  if (!item) return;
  const path = item.path;
  if (action === "open") {
    pvClose();
    if (typeof launchItem === "function") launchItem(path);
    return;
  }
  if (action === "reveal") {
    pvClose();
    invoke("reveal_in_explorer", { path }).catch((err) => console.warn("reveal failed:", err));
    if (typeof hideWindow === "function") hideWindow();
    return;
  }
  if (action === "admin") {
    pvClose();
    invoke("launch_admin", { path })
      .then(() => {
        if (typeof hideWindow === "function") hideWindow();
      })
      .catch((err) => console.warn("admin launch failed:", err));
  }
}

// ---- input ----

// Every key the panel owns comes through here, before the search box acts on it.
// Closed, this is just the two triggers; open, it keeps the list's keys from
// reaching past the panel.
function pvHandleKey(e) {
  if (!pvOpen) {
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === " ") {
      if (!pvAllowed(pvSelected())) return false;
      pvOpenFor("peek", null, null);
      e.preventDefault();
      return true;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "Enter") {
      if (!pvAllowed(pvSelected())) return false;
      pvToggleFull(null, null);
      e.preventDefault();
      return true;
    }
    return false;
  }

  if (e.key === "Escape") {
    pvClose();
    e.preventDefault();
    return true;
  }
  // Peek is held, not toggled: a Space while it is up must not become a typed
  // space when Shift comes up first and Space goes down second.
  if (pvMode === "peek") {
    if (e.key === " ") {
      e.preventDefault();
      return true;
    }
    // Arrow keys move the selection underneath, which the peek follows.
    return false;
  }

  // Copying what is selected is the reason the panel's text is selectable. A
  // modified key is not typing, so without this it fell through to the catch-all
  // below and was swallowed with preventDefault, which cancels the copy. Matched
  // by code, not key, so the Russian layout (where Ctrl+C reports "с") works too.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
      (e.code === "KeyC" || e.code === "KeyA" || e.code === "Insert")) {
    return false;
  }

  // Typing has to work while the full preview is open. Opening a preview must
  // never trap the user in it: the moment they start a new query, the panel
  // gets out of the way and the character reaches the search box.
  if (pvIsTypingKey(e)) {
    pvClose();
    return false;
  }

  if (e.altKey && !e.ctrlKey && e.key === "Enter") {
    pvClose();
    e.preventDefault();
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    pvRunAction("open");
    return true;
  }
  // Arrows scroll the preview only when it has somewhere to scroll. Otherwise
  // they keep doing what the user expects, which is move the selection -- and
  // the panel follows it.
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (pvCanScroll(e.key)) {
      pvScroll(e.key);
      e.preventDefault();
      return true;
    }
    return false;
  }
  if (e.key === "Tab") {
    const btn = pvActions.querySelector(".pv-btn");
    if (btn) {
      btn.focus();
      e.preventDefault();
      return true;
    }
    return false;
  }
  return true;
}

// A plain character with no Ctrl or Alt: the user has started typing again.
function pvIsTypingKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return typeof e.key === "string" && e.key.length === 1;
}

function pvScroll(key) {
  if (!pvBody) return;
  const step = 48;
  if (key === "ArrowDown") pvBody.scrollTop += step;
  else if (key === "ArrowUp") pvBody.scrollTop -= step;
  else if (key === "ArrowRight") pvBody.scrollLeft += step;
  else if (key === "ArrowLeft") pvBody.scrollLeft -= step;
  pvSyncScrollbar();
}

function pvToggleFull(item, anchor) {
  if (pvOpen && pvMode === "full") {
    pvClose();
    return;
  }
  pvOpenFor("full", item || null, anchor || null);
}

// Peek follows the keyboard when it moves, which is the whole point of holding
// a key and then arrowing through the list.
// While the peek is held the selection moves under the arrow keys, and swapping
// one picture for another with a hard cut reads as a glitch. The outgoing image
// stays where it is and fades out underneath the incoming one, so the two are
// briefly both on screen instead of one jumping into the other's place.
function pvSwapStill(oldEl, nextHtml) {
  const host = pvBody;
  if (!host || !oldEl) {
    host.innerHTML = nextHtml;
    return;
  }
  const layer = document.createElement("div");
  layer.className = "pv-still";
  layer.innerHTML = nextHtml;
  const incoming = layer.firstElementChild;
  host.appendChild(layer);
  if (incoming) {
    incoming.classList.add("pv-still-in");
    // Commit the swap once the fade is under way, so nothing jumps back.
    setTimeout(() => {
      if (oldEl.parentNode === host) oldEl.remove();
      layer.classList.remove("pv-still-in");
    }, 140);
  }
}

function pvFollowSelection() {
  if (!pvOpen || pvMode !== "peek") return;
  const item = pvSelected();
  if (!item || (pvItem && item.path === pvItem.path)) return;
  pvItem = item;
  pvRender(item, "peek");
}

document.addEventListener("keyup", (e) => {
  // Release on either half: Shift goes up before Space when the chord is typed
  // fastest, and Space alone always means the hold is over.
  if (e.key === " " || !e.shiftKey) pvPeekUp();
});
// Losing the window or focus mid-hold must not strand the panel.
window.addEventListener("blur", pvPeekUp);
document.addEventListener("visibilitychange", pvPeekUp);

function pvPeekUp() {
  if (!pvOpen || pvMode !== "peek") return;
  pvClose();
}

// ---- media ----
// Windows only decodes a subset of what it can play, and .webm and .mkv are
// outside it, so for those the Shell has no thumbnail to offer and the panel
// would have nothing to show. Chromium can play them, so media gets a real
// element instead of a still.
//
// The path is handed over through the asset protocol rather than as a file://
// URL, and that protocol is scoped to media extensions only in tauri.conf.json,
// so this cannot be turned into a way to read arbitrary files.

function pvAssetUrl(path) {
  try {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.convertFileSrc === "function") return core.convertFileSrc(path);
  } catch {}
  return "";
}

function pvDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return (h ? h + ":" + pad(m) : m) + ":" + pad(sec);
}

function pvIsMedia(kind) {
  return kind === "video" || kind === "audio";
}

// Frame 0 is usually black, a logo or a still that has nothing to do with the
// content, so a tenth of the way in is the representative moment.
function pvFrameFor(duration) {
  if (!isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(0.5, duration * 0.1), Math.max(0, duration - 0.2));
}

// The video element is the picture. Seeking it to a representative frame and
// leaving it paused shows real content for anything Chromium can open -- webm
// included, which the Shell never could -- without reading the file into a
// canvas, which would need the asset URL to be same-origin and it is not.
function pvPaintMedia(item, mode, p) {
  const url = pvAssetUrl(p.path);
  if (!url) {
    pvBody.innerHTML = '<div class="pv-note"></div>';
    pvBody.querySelector(".pv-note").textContent = t("pvMediaUnavailable");
    return;
  }
  const isAudio = p.kind === "audio";
  const tag = isAudio ? "audio" : "video";
  const controls = mode === "full" ? " controls" : "";
  pvBody.innerHTML = "<" + tag + ' class="pv-media" preload="auto" muted playsinline' + controls + "></" + tag + ">";
  const el = pvBody.querySelector("." + tag);
  el.src = url;

  el.addEventListener("error", () => {
    if (!pvOpen) return;
    // Nothing to fall back to: the Shell's answer for media is the icon, and an
    // icon of the file is not a preview of it.
    pvBody.innerHTML = '<div class="pv-note"></div>';
    pvBody.querySelector(".pv-note").textContent = t("pvMediaUnplayable");
  });

  el.addEventListener("loadedmetadata", () => {
    if (!pvOpen) return;
    const bits = [];
    if (!isAudio && el.videoWidth) bits.push(el.videoWidth + "×" + el.videoHeight);
    const d = pvDuration(el.duration);
    if (d) bits.push(d);
    pvMeta.textContent = [pvBytes(p.size_bytes), bits.join("  ·  ")].filter(Boolean).join("  ·  ");

    if (mode === "full" || isAudio) return;
    // A held glance does not need a player, only the frame.
    const seekTo = () => {
      if (!pvOpen || el.readyState < 2) return;
      el.currentTime = pvFrameFor(el.duration);
    };
    el.addEventListener("loadeddata", seekTo, { once: true });
    // Seating needs data past the target; if the first attempt lands short, the
    // second one usually does not.
    el.addEventListener("seeked", () => {
      if (el.currentTime < 0.05 && el.duration > 2) {
        el.currentTime = pvFrameFor(el.duration);
      }
    }, { once: true });
    el.load();
  });
}
// The app hides native scrollbars and draws its own, so the preview gets one
// too rather than a bare OS widget. Driven off .pv-body's own metrics, and
// rounded to whole pixels so the bar does not sit on a half pixel and shimmer.
function pvSyncScrollbar() {
  if (!pvOpen || !pvTrack || !pvThumb || !pvBody) return;
  const range = pvBody.scrollHeight - pvBody.clientHeight;
  if (range <= 1) {
    pvTrack.classList.add("pv-hidden");
    return;
  }
  pvTrack.classList.remove("pv-hidden");
  pvTrack.classList.add("is-active");
  const trackH = pvTrack.clientHeight;
  if (trackH <= 0) return;
  const thumbH = Math.max(28, Math.round(Math.min(trackH, (pvBody.clientHeight / pvBody.scrollHeight) * trackH)));
  const room = Math.max(0, trackH - thumbH);
  const top = Math.round((pvBody.scrollTop / range) * room);
  pvThumb.style.height = thumbH + "px";
  pvThumb.style.top = top + "px";
  clearTimeout(pvTrackFade);
  pvTrackFade = setTimeout(() => pvTrack && pvTrack.classList.remove("is-active"), 700);
}

function pvCanScroll(key) {
  if (!pvBody) return false;
  if (pvBody.scrollHeight - pvBody.clientHeight <= 1) return false;
  if (key === "ArrowLeft" || key === "ArrowRight") return pvBody.scrollWidth - pvBody.clientWidth > 1;
  return true;
}

// Owns its keys from the capture phase, so Escape and the two triggers work
// wherever focus happens to be -- after clicking into the panel, or straight
// after the mouse put the caret somewhere else. Anything it does not claim is
// left alone, and the search box still delegates here first, so this only ever
// sees keys nobody else wanted.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.defaultPrevented || hotkeyCapturing) return;
    if (!pvHandleKey(e)) return;
    // Stopping the event here matters as much as handling it: the search box
    // has its own Enter and Escape, and without this the same key would be
    // acted on twice -- opening the panel and closing it in the same tick, or
    // launching the file and then launching it again.
    e.preventDefault();
    e.stopPropagation();
  },
  true
);

function pvApplyStyle(style) {
  pvStyle = style === "popup" ? "popup" : "overlay";
  document.documentElement.dataset.preview = pvStyle;
  if (pvOpen) {
    pvPlace();
  }
  // Returned on purpose: the settings switch paints from the promise, and a
  // missing return left it with undefined, so no button ever lit up.
  return pvStyle;
}

function pvLoadStyle() {
  return invoke("get_preview_style")
    .then((s) => pvApplyStyle(s))
    .catch(() => pvApplyStyle("overlay"));
}

function pvBindSettings(seg) {
  if (!seg) return;
  pvSeg = seg;
  const paint = (style) => {
    const current = style === "popup" ? "popup" : "overlay";
    seg.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.preview === current);
    });
  };
  pvPaintSeg = paint;
  // Repainted on every opening: something else may have reset the row while it
  // was closed, and a switch with nothing lit reads as broken.
  pvLoadStyle().then((style) => {
    pvStyle = style;
    paint(style);
  });
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || !btn.dataset.preview) return;
    const style = btn.dataset.preview;
    paint(style);
    pvApplyStyle(style);
    invoke("set_preview_style", { style }).catch(() => {});
  });
}

document.addEventListener("DOMContentLoaded", () => {
  pvEnsure();
  pvBindSettings(document.getElementById("preview-style-seg"));
  // A held peek rides along with the pointer, and remembers where the pointer
  // was when it opened, so it can be placed before any move event arrives.
  document.addEventListener(
    "pointermove",
    (e) => {
      pvLastPointer = { x: e.clientX, y: e.clientY };
      if (!pvOpen) return;
      if (pvPanel.dataset.size !== "compact") return;
      pvFollowCursor(e.clientX, e.clientY);
    },
    true
  );
  document.addEventListener("pointerdown", (e) => {
    if (!pvOpen || !pvPanel) return;
    // This runs in the capture phase, before the panel's own handler that stops
    // the event, so the "is it inside" question has to be answered here.
    if (pvPanel.contains(e.target)) return;
    pvClose();
  }, true);
  window.addEventListener("resize", () => {
    if (pvOpen) pvPlace();
  });
});

window.UmbraPreview = {
  openFull: pvToggleFull,
  close: pvClose,
  isOpen: pvIsOpen,
  handleKey: pvHandleKey,
  applyStyle: pvApplyStyle,
  loadStyle: pvLoadStyle,
  bindSettings: pvBindSettings,
  refreshSettings: pvRefreshSettings,
  followSelection: pvFollowSelection,
  selected: pvSelected,
  hasContent: pvHasContent,
  cacheSize: () => pvCache.size,
};
