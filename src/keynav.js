// Keyboard navigation outside the results list (main.js already moves through the list with
// Up / Down and launches with Enter): the settings rows and their controls, the right-click
// menu, and the side dock of pins. Runs in the capture phase, ahead of the search box's
// own handler, and only takes the keys it uses.

const KN_CONTROLS = ".seg-btn, .swatch, .swatch-custom, .stepper-btn, .toggle, .align-cell, .settings-text-btn, .settings-link";

let knRow = -1; // settings row with the keyboard focus
let knCtrl = -1; // control inside that row, -1 when it has none
let knMenu = -1; // context menu item
let knDock = -1; // dock tile; -1 while the keys drive the list
let knMenuKeyAt = 0; // when the menu key / Shift+F10 last opened the context menu

function knVisible(el) {
  return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function knEditable(el) {
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function knClear(selector) {
  document.querySelectorAll(selector).forEach((el) => el.classList.remove("kbd-focus"));
}

function knReset() {
  knRow = knCtrl = knMenu = knDock = -1;
  knClear(".kbd-focus");
}

// ---- settings ----

function knRows() {
  return [...settingsSection.querySelectorAll(".settings-row")].filter((r) => !r.closest("#content-menu") && knVisible(r));
}

function knControls(row) {
  return row ? [...row.querySelectorAll(KN_CONTROLS)].filter((c) => !c.disabled && knVisible(c)) : [];
}

function knPaintSettings() {
  knClear("#settings-section .kbd-focus");
  const row = knRows()[knRow];
  if (!row) return;
  row.classList.add("kbd-focus");
  const ctrl = knControls(row)[knCtrl];
  if (ctrl) ctrl.classList.add("kbd-focus");
  row.scrollIntoView({ block: "nearest" });
}

function knFocusRow(index) {
  const rows = knRows();
  knRow = Math.max(0, Math.min(index, rows.length - 1));
  // Start on the control that is currently chosen (language, density, ...), else the first.
  const ctrls = knControls(rows[knRow]);
  knCtrl = ctrls.length ? Math.max(0, ctrls.findIndex((c) => c.classList.contains("active"))) : -1;
  knPaintSettings();
}

function knSettingsKey(e) {
  const rows = knRows();
  if (!rows.length) return false;
  switch (e.key) {
    case "ArrowDown":
      knFocusRow(knRow < 0 ? 0 : knRow + 1);
      return true;
    case "ArrowUp":
      knFocusRow(knRow < 0 ? 0 : knRow - 1);
      return true;
    case "ArrowLeft":
    case "ArrowRight": {
      if (knRow < 0) return false;
      const n = knControls(rows[knRow]).length;
      if (n) knCtrl = Math.max(0, Math.min(knCtrl + (e.key === "ArrowRight" ? 1 : -1), n - 1));
      knPaintSettings();
      return true;
    }
    case "Enter": {
      const row = rows[knRow];
      if (!row) return false;
      const ctrl = knControls(row)[knCtrl];
      if (ctrl) ctrl.click();
      else if (row.classList.contains("interactive")) row.click();
      // Some rows rebuild their buttons when clicked.
      requestAnimationFrame(() => { if (knRow >= 0) knPaintSettings(); });
      return true;
    }
    case "Escape":
      // Opening settings takes the focus off the search box, whose handler closes them.
      if (e.target === searchInput) return false;
      toggleSettings();
      searchInput.focus();
      return true;
  }
  return false;
}

// ---- context menu ----

function knMenuItems() {
  return [...contextMenu.querySelectorAll(".ctx-item")].filter(knVisible);
}

function knMenuKey(e) {
  const items = knMenuItems();
  if (!items.length) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const step = e.key === "ArrowDown" ? 1 : -1;
    knMenu = knMenu < 0 ? (step > 0 ? 0 : items.length - 1) : (knMenu + step + items.length) % items.length;
    knClear("#context-menu .kbd-focus");
    items[knMenu].classList.add("kbd-focus");
    return true;
  }
  if (e.key === "Enter") {
    // Nothing picked yet: Enter means Open, as the menu's shortcut column says.
    (items[knMenu] || contextMenu.querySelector('[data-action="open"]')).click();
    return true;
  }
  return e.key === "ArrowLeft" || e.key === "ArrowRight";
}

// The menu key / Shift+F10 opens the menu for the row (or dock tile) picked with the keyboard.
function knOpenMenuForSelection() {
  let el = null;
  let target = null;
  const tile = knDockTiles()[knDock];
  if (tile) {
    el = tile;
    target = currentPins.find((p) => p.path === tile.dataset.path) || null;
  } else if (selectedIndex >= 0 && selectedIndex < selectableItems.length) {
    // The pins list stays in the DOM (hidden) while pins live in the dock.
    el = [...document.querySelectorAll("#pins-list .result-item.selected, #results-list .result-item.selected")].find(knVisible);
    target = selectableItems[selectedIndex];
  }
  if (!el || !target || !target.path) return false;
  const r = el.getBoundingClientRect();
  openContextMenu({ clientX: r.left + Math.min(48, r.width / 2), clientY: r.bottom - 4 }, target);
  knMenuKeyAt = Date.now();
  return true;
}

// ---- side dock ----

function knDockSide() {
  const side = document.documentElement.dataset.pins;
  return side === "left" || side === "right" ? side : null;
}

function knDockTiles() {
  const dock = document.getElementById("pin-dock");
  return dock && !dock.hidden && knDockSide() ? [...dock.querySelectorAll(".dock-tile:not(.dock-empty)")] : [];
}

function knPaintDock() {
  knClear("#pin-dock .kbd-focus");
  const tile = knDockTiles()[knDock];
  if (tile) tile.classList.add("kbd-focus");
}

function knLeaveDock(selectFirstRow) {
  if (knDock < 0) return;
  knDock = -1;
  knPaintDock();
  if (selectFirstRow && selectableItems.length) {
    selectedIndex = 0;
    updateSelection();
  }
}

function knDockKey(e) {
  const side = knDockSide();
  const tiles = knDockTiles();
  if (!side || !tiles.length) {
    knDock = -1;
    return false;
  }
  const towardDock = side === "left" ? "ArrowLeft" : "ArrowRight";
  const awayFromDock = side === "left" ? "ArrowRight" : "ArrowLeft";
  if (knDock < 0) {
    // Into the dock only from the edge of the text, so the caret still moves inside a query.
    if (e.key !== towardDock || e.target !== searchInput) return false;
    const { selectionStart: start, selectionEnd: end, value } = searchInput;
    if (side === "left" ? start !== 0 || end !== 0 : start !== value.length) return false;
    knDock = 0;
    selectedIndex = -1;
    updateSelection();
    knPaintDock();
    return true;
  }
  knDock = Math.min(knDock, tiles.length - 1);
  switch (e.key) {
    case "ArrowDown":
      knDock = Math.min(knDock + 1, tiles.length - 1);
      knPaintDock();
      return true;
    case "ArrowUp":
      knDock = Math.max(knDock - 1, 0);
      knPaintDock();
      return true;
    case towardDock:
      return true;
    case awayFromDock:
      knLeaveDock(true);
      return true;
    case "Enter": {
      const path = tiles[knDock].dataset.path;
      if (e.ctrlKey && e.shiftKey) {
        hideWindow();
        invoke("launch_admin", { path }).catch(() => console.error("Admin launch failed"));
      } else if (e.shiftKey) {
        copyPath(path);
      } else {
        launchItem(path);
      }
      return true;
    }
  }
  return false;
}

// ---- wiring ----

function knInit() {
  document.addEventListener("keydown", (e) => {
    // Hotkey capture, the colour picker, the preview panel, the indexing menu
    // and the animations menu own the keyboard while open.
    if (e.defaultPrevented || hotkeyCapturing || pickerOpen || contentMenuOpen || animMenuOpen || e.altKey || e.metaKey) return;
    // The preview panel runs in overlay mode over the list, so there is no row
    // left for the arrow keys to move through.
    if (window.UmbraPreview && window.UmbraPreview.isOpen()) return;
    let handled = false;
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      handled = !contextMenu.classList.contains("visible") && settingsSection.classList.contains("hidden") && knOpenMenuForSelection();
    } else if (contextMenu.classList.contains("visible")) {
      handled = knMenuKey(e);
    } else if (!settingsSection.classList.contains("hidden")) {
      handled = knSettingsKey(e);
    } else {
      handled = knDockKey(e);
      if (!handled && e.target !== searchInput && !knEditable(e.target) && ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(e.key)) {
        // Focus left the search box (a button was clicked): the keys still drive the list.
        e.preventDefault();
        e.stopImmediatePropagation();
        searchInput.focus();
        searchInput.dispatchEvent(new KeyboardEvent("keydown", {
          key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, bubbles: true, cancelable: true,
        }));
        return;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // The menu key also makes the webview fire `contextmenu` at the search box, which would
  // close the menu that was just opened for the selected row.
  document.addEventListener("contextmenu", (e) => {
    if (Date.now() - knMenuKeyAt < 1000 && !e.target.closest(".result-item, .dock-tile")) {
      knMenuKeyAt = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // Fresh state whenever a menu opens / closes, settings open / close, or the query changes.
  new MutationObserver(() => {
    knMenu = -1;
    knClear("#context-menu .kbd-focus");
  }).observe(contextMenu, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => {
    knRow = knCtrl = -1;
    knClear("#settings-section .kbd-focus");
  }).observe(settingsSection, { attributes: true, attributeFilter: ["class"] });
  searchInput.addEventListener("input", () => knLeaveDock(false));
  // The mouse takes over: drop the keyboard highlight it would compete with.
  contextMenu.addEventListener("mousemove", () => {
    knMenu = -1;
    knClear("#context-menu .kbd-focus");
  });
  settingsSection.addEventListener("mousedown", () => {
    knRow = knCtrl = -1;
    knClear("#settings-section .kbd-focus");
  });
  window.__TAURI__.event.listen("window-shown", knReset);
}

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", knInit);
