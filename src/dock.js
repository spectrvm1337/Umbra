// Pinned apps dock (Settings -> Pinned apps -> Left / Right): a column of tiles beside the
// window that stays visible while searching. "List" keeps pins under the empty search box.
// Drag a result row onto the dock to pin it, drag tiles to reorder, drag one out to unpin,
// or drop an exe/shortcut from Explorer onto it.

// Width added to the window on the dock side: the tile plus room for the hover label.
const DOCK_RESERVE = 168;

// Settings > Animations > Movement, read from the same attribute the CSS uses,
// so the dock and the results list agree without sharing any state.
const motionOff = () => document.documentElement.dataset.animMove === "off";

let dockSide; // "left" | "right" | null (list mode); undefined until the theme first loads
let dockEl = null;
let dockDragging = false;
let resultsDragSortable = null;

// What the window is wider than the search panel: the dock, plus the theme panel while it is open
// (themepanel.js).
function dockExtraWidth() {
  const panel = typeof tpExtraWidth === "function" ? tpExtraWidth() : 0;
  return (dockSide ? DOCK_RESERVE : 0) + panel;
}
function sidesLeftExtra() {
  const panel = typeof tpLeftExtra === "function" ? tpLeftExtra() : 0;
  return (dockSide === "left" ? DOCK_RESERVE : 0) + panel;
}

function dockNameFromPath(path) {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  return base.replace(/\.(exe|lnk|url)$/i, "");
}

function dockKindFromPath(path) {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  if (ext === "exe" || ext === "msi") return "app";
  if (ext === "lnk" || ext === "url") return "shortcut";
  return ext ? "file" : "folder";
}

function dockTile(pin) {
  const el = document.createElement("div");
  el.className = "dock-tile";
  el.dataset.path = pin.path;
  const icon = iconCache.get(pin.path) || pin.icon_data; // iconCache lives in main.js
  const kind = getVisualKind(pin);
  el.innerHTML = `
    <span class="dock-label">${escapeHtml(pin.name)}</span>
    <div class="result-icon">${icon
      ? `<img src="${icon}" alt="">`
      : `<div class="result-icon-fallback ${kind}">${getTypeIcon(kind)}</div>`}</div>`;
  return el;
}

function renderDock() {
  if (!dockEl) return;
  dockEl.hidden = !dockSide;
  if (!dockSide || dockDragging) return;
  dockEl.innerHTML = "";
  currentPins.forEach((pin, i) => {
    const tile = dockTile(pin);
    tile.style.setProperty("--i", Math.min(i, 8));
    dockEl.appendChild(tile);
  });
  // Drop slot; CSS only shows it while something is being dragged towards the dock.
  const empty = document.createElement("div");
  empty.className = "dock-tile dock-empty";
  empty.innerHTML = `<div class="result-icon">+</div>`;
  dockEl.appendChild(empty);
  loadDockIcons();
}

function loadDockIcons() {
  const paths = currentPins
    .filter((p) => needsRealIcon(p) && !p.icon_data && !iconCache.has(p.path))
    .map((p) => p.path);
  if (paths.length === 0) return;
  invoke("get_icons", { paths })
    .then((map) => {
      for (const path of paths) {
        const data = map[path] || null;
        cacheIcon(path, data);
        if (!data) continue;
        const tile = [...dockEl.children].find((t) => t.dataset.path === path);
        const box = tile && tile.querySelector(".result-icon");
        if (box) box.innerHTML = `<img src="${data}" alt="">`;
      }
    })
    .catch((err) => console.error("Dock icon load failed:", err));
}

async function saveDockOrder(paths) {
  const map = new Map(currentPins.map((p) => [p.path, p]));
  currentPins = paths.map((p) => map.get(p)).filter(Boolean);
  updateSelectableItems();
  try {
    await invoke("reorder_pins", { orderedPaths: currentPins.map((p) => p.path) });
  } catch (e) {
    console.error("Dock reorder failed:", e);
  }
}

async function pinToDock(name, path, kind, index) {
  if (!currentPins.some((p) => p.path === path)) {
    try {
      await invoke("add_pin", { name, path, kind });
    } catch (err) {
      console.warn("could not pin:", err);
      return;
    }
    const result = allResults.find((r) => r.path === path);
    if (result) result.pinned = true;
    currentPins.push({ name, path, kind, pinned: true, icon_data: result ? result.icon_data : null });
    setPinnedButtons(path, true);
  }
  const order = currentPins.map((p) => p.path).filter((p) => p !== path);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, path);
  await saveDockOrder(order);
}

async function unpinFromDock(path) {
  try {
    await invoke("remove_pin", { path });
  } catch (e) {
    console.error("Unpin failed:", e);
    return;
  }
  currentPins = currentPins.filter((p) => p.path !== path);
  const result = allResults.find((r) => r.path === path);
  if (result) result.pinned = false;
  setPinnedButtons(path, false);
  updateSelectableItems();
  showToast(window.i18n.t("unpinned"));
}

function ensureDock() {
  if (dockEl) return;
  dockEl = document.createElement("div");
  dockEl.id = "pin-dock";
  dockEl.hidden = true;
  appContainer.appendChild(dockEl);

  dockEl.addEventListener("click", (e) => {
    const tile = e.target.closest(".dock-tile");
    if (!tile || dockDragging || !tile.dataset.path) return;
    launchItem(tile.dataset.path);
  });
  dockEl.addEventListener("contextmenu", (e) => {
    const tile = e.target.closest(".dock-tile");
    const pin = tile && currentPins.find((p) => p.path === tile.dataset.path);
    if (!pin) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, pin);
  });

  // Pointer-driven drags (forceFallback): Tauri's file-drop handling disables HTML5 DnD on Windows.
  const dockSortable = Sortable.create(dockEl, {
    group: { name: "umbra-dock", pull: true, put: ["umbra-results"] },
    animation: motionOff() ? 0 : 200,
    easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    forceFallback: true,
    fallbackTolerance: 4,
    filter: ".dock-empty",
    removeOnSpill: true,
    onStart() {
      dockDragging = true;
    },
    onEnd(evt) {
      setTimeout(() => { dockDragging = false; }, 0);
      if (evt.from === evt.to && evt.oldIndex !== evt.newIndex) {
        saveDockOrder([...dockEl.children].map((t) => t.dataset.path).filter(Boolean)).then(renderDock);
      }
    },
    onSpill(evt) {
      const path = evt.item.dataset.path;
      if (path) unpinFromDock(path).then(renderDock);
    },
    async onAdd(evt) {
      const btn = evt.item.querySelector(".result-pin");
      const index = evt.newIndex;
      evt.item.remove();
      if (btn) await pinToDock(btn.dataset.name, btn.dataset.path, btn.dataset.kind, index);
      dockDragging = false;
      renderDock();
    },
  });

  // Called from main.js when the Movement toggle changes: Sortable writes its
  // own inline `transition: transform 200ms`, so the option is the only handle.
  window.applyDockSortableMotion = (ms) => dockSortable.option("animation", ms);

  // Result rows can be dragged onto the dock (only while the dock is shown).
  resultsDragSortable = Sortable.create(resultsList, {
    group: { name: "umbra-results", pull: "clone", put: false },
    sort: false,
    forceFallback: true,
    // The copy under the cursor lives on <body> so the results list's overflow can't clip it.
    fallbackOnBody: true,
    fallbackTolerance: 6,
    filter: ".result-pin",
    preventOnFilter: false,
    revertOnSpill: true,
    disabled: true,
    onStart: () => {
      rowDragging = true;
      dockEl.classList.add("drag-active");
    },
    onEnd: () => {
      endRowDrag();
      dockEl.classList.remove("drag-active");
    },
  });

  // Files dragged in from Explorer.
  const pointOverDock = (pos) => {
    if (!dockSide || !pos) return false;
    const r = dockEl.getBoundingClientRect();
    const x = pos.x / window.devicePixelRatio;
    const y = pos.y / window.devicePixelRatio;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const events = window.__TAURI__.event;
  events.listen("tauri://drag-enter", () => dockEl.classList.toggle("drag-active", !!dockSide));
  events.listen("tauri://drag-over", (e) => dockEl.classList.toggle("drop-target", pointOverDock(e.payload.position)));
  events.listen("tauri://drag-leave", () => dockEl.classList.remove("drop-target", "drag-active"));
  events.listen("tauri://drag-drop", async (e) => {
    dockEl.classList.remove("drop-target", "drag-active");
    if (!pointOverDock(e.payload.position)) return;
    for (const path of e.payload.paths || []) {
      await pinToDock(dockNameFromPath(path), path, dockKindFromPath(path), currentPins.length);
    }
    renderDock();
  });

  document.getElementById("pins-style-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    e.stopPropagation();
    theme = { ...theme, pinsStyle: btn.dataset.pins };
    saveTheme();
  });
}

// Grow or shrink the window by the dock's width, keeping the search panel where it is on screen.
// Size and position go to Rust in one call (a dock on the left grows the window leftwards), so
// there is no frame with the new width and the old position.
function resizeWindowSides(leftBefore) {
  const shiftX = leftBefore === undefined ? 0 : sidesLeftExtra() - leftBefore;
  const panel = typeof tpExtraWidth === "function" ? tpExtraWidth() : 0;
  return invoke("resize_main_window", {
    width: mainLogicalW + dockExtraWidth(),
    height: mainLogicalH,
    shiftX,
    panelWidth: panel,
    panelLeft: typeof tpSide !== "undefined" && tpSide === "left",
  }).catch(() => {});
}
function resizeForDock(before) {
  const panelLeft = typeof tpLeftExtra === "function" ? tpLeftExtra() : 0;
  return resizeWindowSides(before === undefined ? undefined : (before === "left" ? DOCK_RESERVE : 0) + panelLeft);
}

// Resolves once the webview has actually taken the new width (or after a moment): the layout
// must not move to the dock's arrangement while the viewport is still the old size.
function waitForViewportWidth(target) {
  return new Promise((resolve) => {
    if (Math.abs(window.innerWidth - target) < 1) return resolve();
    const done = () => {
      window.removeEventListener("resize", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (Math.abs(window.innerWidth - target) < 1) done(); };
    window.addEventListener("resize", check);
    const timer = setTimeout(done, 180);
  });
}

let dockApplyId = 0;
let dockPending = false; // a switch is waiting for the window; later calls must not jump ahead of it
let pinsAppearTimer = null;

// Tiles slide in from the outside edge, or the list's rows come back, one after another.
function playPinsAppear(side) {
  if (motionOff()) return;
  clearTimeout(pinsAppearTimer);
  if (side) {
    dockEl.classList.add("dock-appear");
    pinsAppearTimer = setTimeout(() => dockEl.classList.remove("dock-appear"), 700);
  } else if (typeof renderPins === "function" && typeof animateAllRows !== "undefined") {
    animateAllRows = true;
    renderPins(currentPins);
    animateAllRows = false;
  }
}

// Called from applyTheme() whenever the theme loads or changes.
function applyDock() {
  ensureDock();
  const style = theme && theme.pinsStyle;
  const side = style === "left" || style === "right" ? style : null;
  document.querySelectorAll("#pins-style-seg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.pins === (side || "list")));
  resultsDragSortable.option("disabled", !side);
  const commit = () => {
    document.documentElement.dataset.pins = side || "list";
    renderDock();
  };
  if (side === dockSide) return dockPending ? undefined : commit();
  const before = dockSide;
  dockSide = side;
  if (before === undefined) {
    // First load: nothing is on screen yet to jump.
    resizeForDock(before);
    return commit();
  }
  const myId = ++dockApplyId;
  dockPending = true;
  // The window and the layout cannot change in the same frame, so for those few
  // frames the card is faded out and then back in rather than shown jumping.
  const mask = !motionOff() && appContainer.classList.contains("window-showing");
  if (mask) appContainer.classList.add("dock-switching");
  setTimeout(() => {
    resizeForDock(before)
      .then(() => waitForViewportWidth(mainLogicalW + dockExtraWidth()))
      .then(() => {
        if (myId !== dockApplyId) return;
        dockPending = false;
        commit();
        // The panel sits on the side the dock is not on.
        if (typeof applyThemePanel === "function") applyThemePanel();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          appContainer.classList.remove("dock-switching");
          playPinsAppear(side);
        }));
      });
  }, mask ? 90 : 0);
}
