const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;
let currentPins = [];
let allResults = [];
let selectableItems = [];
let selectedIndex = -1;
let debounceTimer = null;
let lastQuery = "";
let currentSearchId = 0;
let contextTargetItem = null;
const searchInput = document.getElementById("search-input");
const ghostTyped = document.getElementById("ghost-typed");
const ghostRest = document.getElementById("ghost-rest");
const resultsList = document.getElementById("results-list");
const pinsList = document.getElementById("pins-list");
const resultsSection = document.getElementById("results-section");
const pinsSection = document.getElementById("pins-section");
const specialSection = document.getElementById("special-section");
const specialContent = document.getElementById("special-content");
const resultsContainer = document.getElementById("results-container");
const resultsWrapper = document.getElementById("results-wrapper");
const emptyState = document.getElementById("empty-state");
let scrollFadeTimer = null;
function syncScrollFade() {
  const isScrolled = resultsContainer.scrollTop > 1;
  resultsContainer.classList.toggle("scrolled", isScrolled);
  resultsWrapper.classList.toggle("is-scrolled", isScrolled);
  resultsContainer.classList.add("scrolling");
  clearTimeout(scrollFadeTimer);
  scrollFadeTimer = setTimeout(() => {
    resultsContainer.classList.remove("scrolling");
  }, 450);
  updateCustomScrollbar();
}
resultsContainer.addEventListener("scroll", syncScrollFade, { passive: true });
function WHEEL_STEP() { return wheelStepPx(); } 
let wheelTarget = null;
let wheelRaf = null;
function clampScroll(v) {
  const max = resultsContainer.scrollHeight - resultsContainer.clientHeight;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(v, max));
}
function wheelTick() {
  if (wheelTarget === null || Number.isNaN(wheelTarget)) { wheelTarget = null; wheelRaf = null; return; }
  const cur = resultsContainer.scrollTop;
  const diff = wheelTarget - cur;

  if (Math.abs(diff) < 1.5) {
    resultsContainer.scrollTop = wheelTarget;
    wheelTarget = null;
    wheelRaf = null;
    return;
  }
  // Movement off means the list lands where the wheel stopped, with no easing.
  if (document.documentElement.dataset.animMove === "off") {
    resultsContainer.scrollTop = wheelTarget;
    wheelTarget = null;
    wheelRaf = null;
    return;
  }
  resultsContainer.scrollTop = cur + diff * 0.28;
  wheelRaf = requestAnimationFrame(wheelTick);
}
resultsContainer.addEventListener("wheel", (e) => {

  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  if (e.deltaY === 0) return;
  e.preventDefault();
  let delta = e.deltaY;

  if (e.deltaMode === 1) delta *= WHEEL_STEP();        
  else if (e.deltaMode === 2) delta *= window.innerHeight; 
  const abs = Math.abs(delta);
  let step;
  if (abs < 55) {

    step = delta;
  } else {
    const notches = Math.max(1, Math.round(abs / 90));
    step = Math.sign(delta) * notches * WHEEL_STEP();
  }
  if (wheelTarget === null) wheelTarget = resultsContainer.scrollTop;

  if (Math.abs(wheelTarget - resultsContainer.scrollTop) > 200) {
    wheelTarget = resultsContainer.scrollTop;
  }
  wheelTarget = clampScroll(wheelTarget + step);
  if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelTick);
  syncScrollFade();
}, { passive: false });
resultsContainer.addEventListener("pointerdown", () => {
  wheelTarget = null;
  if (wheelRaf) { cancelAnimationFrame(wheelRaf); wheelRaf = null; }
});
const customScrollbar = document.getElementById("custom-scrollbar");
const customThumb = document.getElementById("custom-thumb");
let customScrollHideTimer = null;
// Sizes and places the thumb without showing it; returns false when nothing scrolls.
function layoutCustomScrollbar() {
  if (!customScrollbar || !customThumb) return false;
  const el = resultsContainer;
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 4) {
    customScrollbar.classList.add("hidden");
    return false;
  }
  customScrollbar.classList.remove("hidden");
  const trackH = customScrollbar.clientHeight;
  if (trackH <= 0) return false;
  const thumbH = Math.max(24, Math.min(42, (el.clientHeight / el.scrollHeight) * trackH));
  const maxTop = Math.max(0, trackH - thumbH);
  const ratio = maxScroll > 0 ? el.scrollTop / maxScroll : 0;
  const top = Math.max(0, Math.min(maxTop, ratio * maxTop));
  customThumb.style.height = thumbH + "px";
  customThumb.style.transform = `translateY(${top}px)`;
  return true;
}
// Layout plus a brief flash of the bar: for scrolling and dragging only. Re-renders and
// icon loads just re-lay it out; flashing on every DOM change made it blink while typing.
function updateCustomScrollbar() {
  if (!layoutCustomScrollbar()) return;
  customScrollbar.classList.add("visible");
  clearTimeout(customScrollHideTimer);
  customScrollHideTimer = setTimeout(() => customScrollbar.classList.remove("visible"), 700);
}
let scrollbarLayoutRaf = 0;
function scheduleScrollbarLayout() {
  if (scrollbarLayoutRaf) return;
  scrollbarLayoutRaf = requestAnimationFrame(() => {
    scrollbarLayoutRaf = 0;
    layoutCustomScrollbar();
  });
}
if (customScrollbar) {
  try {
    const ro = new ResizeObserver(scheduleScrollbarLayout);
    ro.observe(resultsContainer);
  } catch {}
  const mo = new MutationObserver(scheduleScrollbarLayout);
  mo.observe(resultsContainer, { childList: true, subtree: true });
  window.addEventListener("resize", scheduleScrollbarLayout);
  requestAnimationFrame(() => setTimeout(layoutCustomScrollbar, 50));
}
if (customThumb && customScrollbar) {
  let isDraggingThumb = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;
  let dragThumbH = 0;
  customThumb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingThumb = true;
    dragStartY = e.clientY;
    dragStartScrollTop = resultsContainer.scrollTop;
    dragThumbH = customThumb.offsetHeight;
    customScrollbar.classList.add("dragging");
    wheelTarget = null;
    if (wheelRaf) { cancelAnimationFrame(wheelRaf); wheelRaf = null; }
    try { customThumb.setPointerCapture(e.pointerId); } catch {}
  });
  customThumb.addEventListener("pointermove", (e) => {
    if (!isDraggingThumb) return;
    const deltaY = e.clientY - dragStartY;
    const trackH = customScrollbar.clientHeight;
    const maxThumbTop = Math.max(1, trackH - dragThumbH);
    const maxScroll = Math.max(1, resultsContainer.scrollHeight - resultsContainer.clientHeight);
    const scrollDelta = (deltaY / maxThumbTop) * maxScroll;
    resultsContainer.scrollTop = Math.max(0, Math.min(maxScroll, dragStartScrollTop + scrollDelta));
  });
  const endDrag = (e) => {
    if (!isDraggingThumb) return;
    isDraggingThumb = false;
    customScrollbar.classList.remove("dragging");
    try { customThumb.releasePointerCapture(e.pointerId); } catch {}
    updateCustomScrollbar();
  };
  customThumb.addEventListener("pointerup", endDrag);
  customThumb.addEventListener("pointercancel", endDrag);
  customScrollbar.addEventListener("pointerdown", (e) => {
    if (e.target === customThumb) return;
    const rect = customScrollbar.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const thumbH = customThumb.offsetHeight;
    const trackH = rect.height;
    const maxScroll = resultsContainer.scrollHeight - resultsContainer.clientHeight;
    if (maxScroll <= 0) return;
    const ratio = (clickY - thumbH / 2) / Math.max(1, trackH - thumbH);
    const target = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
    wheelTarget = target;
    if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelTick);
  });
}
const appContainer = document.getElementById("app-container");
const dragBar = document.getElementById("drag-bar");
const sizePill = document.getElementById("size-pill");
const clearBtn = document.getElementById("clear-btn");
const contextMenu = document.getElementById("context-menu");
const settingsBtn = document.getElementById("settings-btn");
const settingsSection = document.getElementById("settings-section");
const hint = document.getElementById("hint");
const settingHotkeyRow = document.getElementById("setting-hotkey-row");
const settingHotkeyValue = document.getElementById("setting-hotkey-value");
const settingZoomMinus = document.getElementById("setting-zoom-minus");
const settingZoomPlus = document.getElementById("setting-zoom-plus");
const settingZoomVal = document.getElementById("setting-zoom-val");
const settingAutostartRow = document.getElementById("setting-autostart-row");
const settingAutostart = document.getElementById("setting-autostart");
const settingReindex = document.getElementById("setting-reindex");
const settingIndexed = document.getElementById("setting-indexed");
const settingsStatus = document.getElementById("settings-status");
let currentHotkey = "";
let hotkeyCapturing = false;
function setSettingsStatus(msg, isError) {
  settingsStatus.textContent = msg || "";
  settingsStatus.classList.toggle("error", !!isError);
}
const languageSeg = document.getElementById("language-seg");
function updateLanguageButtons(currentLang) {
  if (!languageSeg) return;
  languageSeg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === currentLang);
  });
}
if (languageSeg) {
  languageSeg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lang = btn.dataset.lang;
      if (window.i18n) {
        window.i18n.setLanguage(lang);
      }
      try {
        await invoke("set_language", { lang });
      } catch (err) {
        console.warn("language save failed:", err);
      }
      updateLanguageButtons(lang);
      refreshSettingsValues();
    });
  });
}
async function refreshSettingsValues() {
  if (theme) applyTheme();
  loadPlacement();
  loadAppVersion();
  try {
    const [hk, zoom, as, indexed, kinds, lang] = await Promise.all([
      invoke("get_hotkey"),
      invoke("get_zoom"),
      invoke("get_autostart"),
      invoke("get_index_status"),
      invoke("get_disabled_kinds"),
      invoke("get_language"),
    ]);
    const currentLang = lang || "en";
    if (window.i18n) {
      window.i18n.setLanguage(currentLang);
    }
    updateLanguageButtons(currentLang);
    currentHotkey = hk || "Alt+Space";
    paintHotkeyIdle();
    settingZoomVal.textContent = Number(zoom || 1).toFixed(2);
    settingAutostart.classList.toggle("on", !!as);
    const itemStr = window.i18n ? window.i18n.t("itemsCount") : "items";
    const indexingStr = window.i18n ? window.i18n.t("stillIndexing") : "still indexing";
    settingIndexed.textContent = indexed > 0
      ? indexed.toLocaleString() + " " + itemStr
      : indexingStr;
    disabledKinds = kinds || [];
    renderExcludeCount();
    indexOpts = await invoke("get_index_options");
    renderContentGroups();
  } catch (e) {
    console.warn("settings load failed:", e);
  }
}
const appVersionEl = document.getElementById("app-version");
async function loadAppVersion() {
  if (!appVersionEl) return;
  try {
    appVersionEl.textContent = await invoke("get_app_version");
  } catch (e) {
    console.warn("version load failed:", e);
  }
}
// The hotkey is drawn as keycaps. While one is being recorded the row shows what is held at that
// moment, so a press is seen before the combination is complete.
function hotkeyKeysHtml(keys, live) {
  return keys
    .map((k) => '<kbd class="su-key' + (live ? " live" : "") + '">' + escapeHtml(k) + "</kbd>")
    .join('<span class="su-plus">+</span>');
}
function paintHotkey(html) {
  settingHotkeyValue.innerHTML = html;
}
function paintHotkeyIdle() {
  paintHotkey(hotkeyKeysHtml(String(currentHotkey || "").split("+").filter(Boolean)));
}
function paintHotkeyHint(text, bad) {
  paintHotkey('<span class="hk-hint' + (bad ? " bad" : "") + '">' + escapeHtml(text) + "</span>");
}
function paintHotkeyHeld(e) {
  const held = [];
  if (e.ctrlKey) held.push("Ctrl");
  if (e.altKey) held.push("Alt");
  if (e.shiftKey) held.push("Shift");
  if (e.metaKey) held.push("Super");
  if (!held.length) {
    paintHotkeyHint(window.i18n.t("pressKeys"));
    return;
  }
  paintHotkey(hotkeyKeysHtml(held, true) + '<span class="su-plus">+</span><kbd class="su-key su-key-wait">…</kbd>');
}
function endHotkeyCapture() {
  hotkeyCapturing = false;
  settingHotkeyRow.classList.remove("capturing");
  paintHotkeyIdle();
}
function toggleSettings() {
  const opening = settingsSection.classList.contains("hidden");
  settingsBtn.classList.toggle("open", opening);
  settingsSection.classList.toggle("hidden", !opening);
  setSettingsStatus("");
  if (opening) {

          if (hotkeyCapturing) endHotkeyCapture();
            closeContentMenu();
            closeAnimMenu();
            pinsSection.classList.add("hidden");
            resultsSection.classList.add("hidden");
            specialSection.classList.add("hidden");
            emptyState.classList.add("hidden");
            refreshSettingsValues();
            // The filter from last time is still hiding rows, and some of them
            // may be the only way to reach a setting.
            filterSettings(searchInput.value);
            searchInput.blur();
    } else {
      // The rows the filter hid stay hidden otherwise, and the next time the
      // settings open they are simply not there.
      document.querySelectorAll("#settings-section .settings-row, #theme-card .settings-row").forEach((r) => { r.style.display = ""; });
      settingsSection.querySelectorAll(".settings-card").forEach((c) => c.classList.remove("filtered-out"));
      performSearch(searchInput.value);
    }
  }
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
function comboFromEvent(e) {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return { pending: true };
  const code = e.code || "";
  let base = null;
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) base = m[1];
  else if ((m = code.match(/^Digit([0-9])$/))) base = m[1];
  else if (/^F([1-9]|1[0-2])$/.test(code)) base = code;
  else if (code === "Space") base = "Space";
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) base = code;
  if (!base) return { error: t("hotkeyUnsupported") };
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (mods.length === 0) return { error: t("hotkeyNeedsModifier") };
  return { combo: [...mods, base].join("+") };
}
settingHotkeyRow.addEventListener("click", (e) => {
  e.stopPropagation();
  if (hotkeyCapturing) return;
  hotkeyCapturing = true;
  settingHotkeyRow.classList.add("capturing");
  paintHotkeyHint(window.i18n.t("pressKeys"));
  setSettingsStatus("");
});
document.addEventListener("pointerdown", (e) => {
  if (hotkeyCapturing && !(e.target instanceof Element && settingHotkeyRow.contains(e.target))) {
    endHotkeyCapture();
  }
}, true);
document.addEventListener("keydown", (e) => {
  if (!hotkeyCapturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { endHotkeyCapture(); return; }
  const { pending, error, combo } = comboFromEvent(e);
  if (pending) {
    paintHotkeyHeld(e);
    return;
  }
  if (error) {
    setSettingsStatus(error, true);
    paintHotkeyHint(error, true);
    setTimeout(() => { if (hotkeyCapturing) paintHotkeyHint(window.i18n.t("pressKeys")); }, 1800);
    return;
  }
  applyHotkey(combo);
}, true);
function applyHotkey(combo) {
  const previous = currentHotkey;
  endHotkeyCapture();
  // Shown as the new combination at once; it goes back only if the system refuses it.
  currentHotkey = combo;
  paintHotkeyIdle();
  settingHotkeyValue.classList.remove("applied");
  void settingHotkeyValue.offsetWidth;
  settingHotkeyValue.classList.add("applied");
  invoke("set_hotkey", { key: combo })
    .then(res => {
      setSettingsStatus("");
      showToast(window.i18n.t("hotkeyApplied"));
    })
    .catch(err => {
      console.warn("set_hotkey refused:", err);
      currentHotkey = previous;
      paintHotkeyIdle();
      setSettingsStatus(t("hotkeyUnsupported"), true);
    });
}
document.addEventListener("keyup", (e) => {
  if (hotkeyCapturing && ["Control", "Alt", "Shift", "Meta"].includes(e.key)) paintHotkeyHeld(e);
}, true);
function applyZoom(z, save) {
  z = Math.max(0.5, Math.min(2, Math.round(z * 100) / 100));
  document.documentElement.style.zoom = z;
  document.body.style.zoom = z;
  setVal(settingZoomVal, z.toFixed(2));
  if (typeof refreshThemePanelRoom === "function") refreshThemePanelRoom();
  if (save) {
    invoke("set_zoom", { zoom: z }).catch(err => console.warn("zoom save failed:", err));
  }
}
settingZoomMinus.addEventListener("click", () => {
  applyZoom(parseFloat(settingZoomVal.textContent) - 0.05, true);
  settingZoomMinus.blur();
});
settingZoomPlus.addEventListener("click", () => {
  applyZoom(parseFloat(settingZoomVal.textContent) + 0.05, true);
  settingZoomPlus.blur();
});
settingAutostartRow.addEventListener("click", async () => {
  const want = !settingAutostart.classList.contains("on");
  setSettingsStatus("");
  try {
    const now = await invoke("set_autostart", { enable: want });
    settingAutostart.classList.toggle("on", !!now);
    showToast(t(now ? "autostartOn" : "autostartOff"));
  } catch (err) {
    showToast(window.i18n.t("autostartFailed"), true, String(err).replace("Error:", "").trim());
  }
});
settingReindex.addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    showIndexingStarted();
    await invoke("reindex");
    toggleSettings();
    showNotify(t("reindexStarted"), { type: "info", detail: t("reindexStartedDetail") });
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
});
// The two index switches sit in the content menu with the categories and drives. They rebuild the
// index, which the Rust side starts; this shows the progress.
let indexOpts = { hidden: false, appdata: false };
const INDEX_OPTION_NAMES = ["hidden", "appdata"];
// The spinner and the "indexing…" count, for the settings that rebuild the index.
function showIndexingStarted() {
  indexingActive = true;
  indexRan = true;
  indexSpinner.classList.add("visible");
  if (settingIndexed) settingIndexed.textContent = window.i18n.t("indexingDots");
}
async function setIndexOption(name, on) {
  if (!!indexOpts[name] === on) return;
  showIndexingStarted();
  indexOpts = await invoke("set_index_option", { name, on });
}
async function toggleIndexOption(name) {
  try {
    await setIndexOption(name, !indexOpts[name]);
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  renderContentGroups();
}
const excludeRow = document.getElementById("setting-exclude-row");
const contentMenu = document.getElementById("content-menu");
const contentGroups = document.getElementById("content-groups");
const contentHead = document.getElementById("content-head");
const excludeCount = document.getElementById("setting-exclude-count");
let disabledKinds = [];
let contentMenuOpen = false;
let contentMenuLoading = false;
const CONTENT_GROUPS = [
  { id: "folders", label: "Folders", kinds: [2] },
  { id: "programs", label: "Programs", kinds: [0, 1] },
  { id: "media", label: "Media", kinds: [4, 5, 6] },
  { id: "files", label: "Files", kinds: [3, 7, 8, 9] },
  { id: "system", label: "System & Libraries", kinds: [10] },
];
function getGroupLabel(g) {
  if (!window.i18n) return g.label;
  if (g.id === "folders") return window.i18n.t("groupFolders");
  if (g.id === "programs") return window.i18n.t("groupPrograms");
  if (g.id === "media") return window.i18n.t("groupMedia");
  if (g.id === "files") return window.i18n.t("groupFiles");
  if (g.id === "system") return window.i18n.t("groupSystem");
  return g.label;
}
const MS_TICK_SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12l5 5L20 7"/></svg>';
function msItem(labelText, on, onToggle) {
  const item = document.createElement("div");
  item.className = "ms-item" + (on ? " checked" : "");
  const label = document.createElement("span");
  label.className = "ms-label";
  label.textContent = labelText;
  const tick = document.createElement("span");
  tick.className = "ms-tick";
  tick.innerHTML = MS_TICK_SVG;
  item.appendChild(label);
  item.appendChild(tick);
  item.addEventListener("click", onToggle);
  return item;
}
// What each menu remembers: whether "Select All" has folded its list away, and
// what was chosen before it did, so unfolding brings that choice back instead of
// starting over. Browser storage is only a convenience -- without it the menu
// starts from the settings as they are.
function menuStateRead(id) {
  try {
    const v = JSON.parse(localStorage.getItem("umbra.menu." + id) || "null");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function menuStateWrite(id, state) {
  try { localStorage.setItem("umbra.menu." + id, JSON.stringify(state)); } catch {}
}
// Keeps a menu's rows in step with `entries` ({key, label, on, master, onToggle})
// without rebuilding the ones that stay: a rebuilt row cannot animate. Handlers
// are set once, so they must read current state when called rather than capture it.
function syncMenuItems(container, entries) {
  const have = new Map([...container.children].map((el) => [el.dataset.key, el]));
  entries.forEach((entry, i) => {
    let el = have.get(entry.key);
    if (!el) {
      el = msItem(entry.label, entry.on, entry.onToggle);
      el.dataset.key = entry.key;
      if (!entry.master) el.classList.add("ms-fold");
    }
    if (entry.tip !== undefined) el.dataset.tip = entry.tip;
    have.delete(entry.key);
    el.classList.toggle("checked", entry.on);
    const label = el.querySelector(".ms-label");
    if (label.textContent !== entry.label) label.textContent = entry.label;
    // Moving a node restarts its transitions, so only move one that is out of place.
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
  for (const stale of have.values()) stale.remove();
}
// Folds or unfolds the list. `instant` is for a menu that is being drawn for the
// first time, which should open already in its state rather than play the fold.
function setMenuFolded(container, folded, instant) {
  if (instant) container.classList.add("ms-instant");
  container.classList.toggle("ms-folded", folded);
  if (instant) {
    void container.offsetWidth;
    container.classList.remove("ms-instant");
  }
}
const groupOn = (g) => g.kinds.every((k) => !disabledKinds.includes(k));
function renderExcludeCount() {
  const off = CONTENT_GROUPS.filter((g) => !groupOn(g)).map((g) => getGroupLabel(g).toLowerCase());
  const offDrives = disabledDrives.filter((d) => availableDrives.includes(d)).map((d) => d.replace(/:$/, ""));
  const tr = (k, f) => (window.i18n ? window.i18n.t(k) : f);
  const offIndex = [
    ["hidden", "lblHiddenFolders", "Hidden folders (.xxx)"],
    ["appdata", "lblAppData", "AppData"],
  ].filter(([name]) => !indexOpts[name]).map(([, key, fallback]) => tr(key, fallback).toLowerCase());
  const totalOff = off.concat(offDrives, offIndex);
  const total = CONTENT_GROUPS.length + availableDrives.length + INDEX_OPTION_NAMES.length;
  const on = total - totalOff.length;
  excludeCount.textContent = on + "/" + total;
  excludeRow.dataset.tip = totalOff.length === 0
    ? tr("everythingShown", "everything is shown")
    : tr("hiddenKinds", "Hidden") + ": " + totalOff.join(", ");
}
// True while "Select All" is on and the per-item list is folded away.
let contentFolded = false;
function renderContentGroups(instant) {
  const onKinds = CONTENT_GROUPS.length - CONTENT_GROUPS.filter((g) => !groupOn(g)).length;
  const onDrives = availableDrives.filter((d) => !disabledDrives.includes(d)).length;
  const onIndex = INDEX_OPTION_NAMES.filter((n) => indexOpts[n]).length;
  const totalOn = onKinds + onDrives + onIndex;
  const total = CONTENT_GROUPS.length + availableDrives.length + INDEX_OPTION_NAMES.length;
  const tr = (k, f) => (window.i18n ? window.i18n.t(k) : f);
  contentHead.textContent = tr("currentCount", "Current") + ": " + totalOn + "/" + total;
  syncMenuItems(contentGroups, [
    { key: "all", master: true, label: tr("selectAll", "Select All"), on: contentFolded, onToggle: toggleAll },
    ...CONTENT_GROUPS.map((g) => ({ key: "g:" + g.id, label: getGroupLabel(g), on: groupOn(g), onToggle: () => toggleGroup(g) })),
    ...availableDrives.map((d) => ({ key: "d:" + d, label: d, on: !disabledDrives.includes(d), onToggle: () => toggleDrive(d) })),
    { key: "i:hidden", label: tr("lblHiddenFolders", "Hidden folders (.xxx)"), tip: tr("indexHiddenTip", ""), on: !!indexOpts.hidden, onToggle: () => toggleIndexOption("hidden") },
    { key: "i:appdata", label: tr("lblAppData", "AppData"), tip: tr("indexAppDataTip", ""), on: !!indexOpts.appdata, onToggle: () => toggleIndexOption("appdata") },
  ]);
  setMenuFolded(contentGroups, contentFolded, instant);
  renderExcludeCount();
}
async function toggleGroup(g) {
  const enable = !groupOn(g);
  try {
    let cur = disabledKinds;
    for (const k of g.kinds) {
      cur = await invoke("set_kind_enabled", { kind: k, enabled: enable });
    }
    disabledKinds = cur;
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  renderContentGroups();
}
async function toggleDrive(d) {
  const enable = disabledDrives.includes(d);
  // The backend rebuilds the index so the drive's files come or go now.
  showIndexingStarted();
  try {
    disabledDrives = await invoke("set_drive_enabled", { drive: d, enabled: enable });
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  renderContentGroups();
}
// "Select All": on, everything is shown and the list folds away after noting
// what was chosen; off, the list unfolds and that choice comes back.
async function toggleAll() {
  const state = menuStateRead("content");
  try {
    if (contentFolded) {
      let kinds = disabledKinds;
      for (const k of (state.savedKinds || []).filter(Number.isInteger)) {
        kinds = await invoke("set_kind_enabled", { kind: k, enabled: false });
      }
      disabledKinds = kinds;
      for (const d of (state.savedDrives || []).map(driveKey).filter((x) => availableDrives.includes(x))) {
        disabledDrives = await invoke("set_drive_enabled", { drive: d, enabled: false });
      }
      for (const name of INDEX_OPTION_NAMES) {
        if (state.savedIndex && state.savedIndex[name] === false) await setIndexOption(name, false);
      }
      contentFolded = false;
    } else {
      state.savedKinds = disabledKinds.slice();
      state.savedDrives = disabledDrives.slice();
      state.savedIndex = { hidden: !!indexOpts.hidden, appdata: !!indexOpts.appdata };
      let kinds = disabledKinds;
      for (const k of disabledKinds.slice()) {
        kinds = await invoke("set_kind_enabled", { kind: k, enabled: true });
      }
      disabledKinds = kinds;
      for (const d of disabledDrives.slice()) {
        disabledDrives = await invoke("set_drive_enabled", { drive: d, enabled: true });
      }
      for (const name of INDEX_OPTION_NAMES) await setIndexOption(name, true);
      contentFolded = true;
    }
    state.folded = contentFolded;
    menuStateWrite("content", state);
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  renderContentGroups();
}
// Drives are kept as "D:" everywhere, the form the config stores them in; the drive list from
// Windows says "D:\", and comparing the two never matched.
let availableDrives = [];
let disabledDrives = [];
const driveKey = (d) => String(d || "").trim().replace(/\\+$/, "").toUpperCase();
async function contentMenuLoad() {
  try {
    disabledKinds = await invoke("get_disabled_kinds");
    availableDrives = (await invoke("get_available_drives")).map(driveKey);
    disabledDrives = await invoke("get_disabled_drives");
    indexOpts = await invoke("get_index_options");
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  // Folded only while it is true: with everything shown (and the menu not left
  // unfolded last time), there is nothing per item to pick yet.
  const everythingOn = disabledKinds.length === 0 && !disabledDrives.some((d) => availableDrives.includes(d))
    && INDEX_OPTION_NAMES.every((n) => indexOpts[n]);
  contentFolded = everythingOn && menuStateRead("content").folded !== false;
}
function positionContentMenu() {
  const h = contentMenu.offsetHeight;
  contentMenu.style.top = Math.max(6, excludeRow.offsetTop - h - 6) + "px";
}
// The menu hangs above its row; as its list folds and unfolds its height
// changes, so it is hung again on every size change.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => { if (contentMenuOpen) positionContentMenu(); }).observe(contentMenu);
}
function openContentMenu() {
  if (contentMenuLoading) return;
  contentMenuLoading = true;
  contentMenuLoad().then(() => {
    contentMenuLoading = false;
    renderContentGroups(true);
    positionContentMenu();
    contentMenu.classList.add("visible");
    excludeRow.classList.add("open");
    contentMenuOpen = true;
  });
}
function closeContentMenu() {
  if (!contentMenuOpen) return;
  contentMenuOpen = false;
  contentMenu.classList.remove("visible");
  excludeRow.classList.remove("open");
}
excludeRow.addEventListener("click", (e) => {
  e.stopPropagation();
  if (contentMenuOpen) closeContentMenu();
  else openContentMenu();
});
document.addEventListener("pointerdown", (e) => {
  if (!contentMenuOpen) return;
  if (e.target instanceof Element && (contentMenu.contains(e.target) || excludeRow.contains(e.target))) return;
  closeContentMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (contentMenuOpen && e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeContentMenu();
  }
}, true);
contentMenuLoad().then(renderExcludeCount);

/* Animations: which kinds of motion are switched off.
   Every duration in the stylesheet is written as var(--t-<kind>, <original>),
   so defining the variable is all it takes to drop that kind and removing it
   puts the original timings back. Keyframe animations have their duration in
   the `animation` shorthand instead, so those are dropped by an attribute.
   The looping animations (icon placeholders, indexing spinner, eyedropper
   loupe) are not on this list at all: they say "still working", so they stay. */
const ANIM_LABELS = {
  blur: ["animBlur", "Blur"],
  fade: ["animFade", "Fade"],
  move: ["animMove", "Movement"],
  size: ["animSize", "Size"],
  color: ["animColor", "Colour"],
  glow: ["animGlow", "Glow"],
};
const animRow = document.getElementById("setting-anim-row");
const animMenu = document.getElementById("anim-menu");
const animHead = document.getElementById("anim-head");
const animGroups = document.getElementById("anim-groups");
const animCount = document.getElementById("setting-anim-count");
let animOff = [];
let animMenuOpen = false;

function applyAnimSettings() {
  const root = document.documentElement;
  for (const kind of Object.keys(ANIM_LABELS)) {
    const attr = "anim" + kind[0].toUpperCase() + kind.slice(1);
    if (animOff.includes(kind)) {
      root.style.setProperty("--t-" + kind, "0s");
      root.dataset[attr] = "off";
    } else {
      root.style.removeProperty("--t-" + kind);
      delete root.dataset[attr];
    }
  }
  applySortableMotion();
}
// data-anim-<Kind> drives the keyframe animations the stylesheet cannot zero
// through a duration; the variables drive the transitions.
function applySortableMotion() {
  const ms = animOff.includes("move") ? 0 : 250;
  pinsSortable.option("animation", ms);
  if (typeof applyDockSortableMotion === "function") applyDockSortableMotion(animOff.includes("move") ? 0 : 200);
}
const animLabel = (kind) => {
  const [key, fallback] = ANIM_LABELS[kind] || [kind, kind];
  return window.i18n ? window.i18n.t(key) || fallback : fallback;
};
async function animMenuLoad() {
  try {
    // A config written before Looping was removed can still name it; drop
    // anything the list no longer has so the count stays honest.
    animOff = (await invoke("get_anim_off")).filter((k) => k in ANIM_LABELS);
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  // Folded only while everything is on, and unless it was left unfolded last time.
  animFolded = animOff.length === 0 && menuStateRead("anim").folded !== false;
  applyAnimSettings();
}
function renderAnimCount() {
  const total = Object.keys(ANIM_LABELS).length;
  const on = total - animOff.length;
  animCount.textContent = on + "/" + total;
  const tr = (k, f) => (window.i18n ? window.i18n.t(k) : f);
  animRow.dataset.tip = animOff.length === 0
    ? tr("animAllOn", "everything animates")
    : tr("animStill", "Still") + ": " + animOff.map(animLabel).join(", ").toLowerCase();
}
// True while "Select All" is on and the per-kind list is folded away: with
// everything on there is nothing per kind to change yet.
let animFolded = false;
function renderAnimGroups(instant) {
  const kinds = Object.keys(ANIM_LABELS);
  const totalOn = kinds.length - animOff.length;
  const tr = (k, f) => (window.i18n ? window.i18n.t(k) : f);
  animHead.textContent = tr("currentCount", "Current") + ": " + totalOn + "/" + kinds.length;
  syncMenuItems(animGroups, [
    { key: "all", master: true, label: tr("selectAll", "Select All"), on: animFolded, onToggle: toggleAnimAll },
    ...kinds.map((kind) => ({ key: kind, label: animLabel(kind), on: !animOff.includes(kind), onToggle: () => toggleAnimKind(kind) })),
  ]);
  setMenuFolded(animGroups, animFolded, instant);
  renderAnimCount();
}
async function toggleAnimKind(kind) {
  const off = !animOff.includes(kind);
  try {
    animOff = await invoke("set_anim_off", { kind, off });
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  applyAnimSettings();
  renderAnimGroups();
}
// Same idea as the content menu's: on, everything animates and the list folds
// away after noting what was off; off, the list unfolds and that comes back.
async function toggleAnimAll() {
  const state = menuStateRead("anim");
  try {
    let cur = animOff;
    if (animFolded) {
      for (const kind of (state.saved || []).filter((k) => k in ANIM_LABELS)) {
        cur = await invoke("set_anim_off", { kind, off: true });
      }
      animFolded = false;
    } else {
      state.saved = animOff.slice();
      for (const kind of animOff.slice()) {
        cur = await invoke("set_anim_off", { kind, off: false });
      }
      animFolded = true;
    }
    animOff = cur;
    state.folded = animFolded;
    menuStateWrite("anim", state);
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  applyAnimSettings();
  renderAnimGroups();
}
function positionAnimMenu() {
  const h = animMenu.offsetHeight;
  animMenu.style.top = Math.max(6, animRow.offsetTop - h - 6) + "px";
}
// Hung above its row, so it is hung again whenever the fold changes its height.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => { if (animMenuOpen) positionAnimMenu(); }).observe(animMenu);
}
function openAnimMenu() {
  animMenuLoad().then(() => {
    renderAnimGroups(true);
    positionAnimMenu();
    animMenu.classList.add("visible");
    animRow.classList.add("open");
    animMenuOpen = true;
  });
}
function closeAnimMenu() {
  if (!animMenuOpen) return;
  animMenuOpen = false;
  animMenu.classList.remove("visible");
  animRow.classList.remove("open");
}
if (animRow) {
  animRow.addEventListener("click", (e) => {
    e.stopPropagation();
    if (animMenuOpen) closeAnimMenu();
    else openAnimMenu();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!animMenuOpen) return;
    if (e.target instanceof Element && (animMenu.contains(e.target) || animRow.contains(e.target))) return;
    closeAnimMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (animMenuOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAnimMenu();
    }
  }, true);
  animMenuLoad().then(renderAnimCount);
}

const authorLink = document.getElementById("author-link");
if (authorLink) {
  authorLink.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("launch_item", { path: "https://github.com/spectrvm1337/Umbra" }).catch(console.error);
  });
}
const checkUpdateBtn = document.getElementById("check-update-btn");
const updatePanel = document.getElementById("update-panel");
const updateTitle = document.getElementById("update-title");
const updateNotes = document.getElementById("update-notes");
const updateMeta = document.getElementById("update-meta");
const updateAction = document.getElementById("update-action");
const updateBtn = document.getElementById("update-btn");
const updateStatus = document.getElementById("update-status");
let updateState = { phase: "idle", info: null, downloaded: null };
let updatePct = 0;
// The search bar's side of the update: a download ring in the indexing spinner's
// slot (it wins over the spinner while it runs), and a blue button once there is
// something to click: the downloaded installer, or a retry after an error.
function renderUpdateIndicator() {
  const { phase, info } = updateState;
  const version = info ? info.latest : "";
  const downloading = phase === "downloading";
  updateStatus.classList.toggle("visible", downloading);
  indexSpinner.classList.toggle("suppressed", downloading);
  updateStatus.querySelector(".ring-fill").style.strokeDasharray = `${(updatePct / 100) * 59.7} 60`;
  updateStatus.dataset.tip = t("updateDownloadingTip", { version, pct: updatePct });
  const button = phase === "available" || phase === "ready" || phase === "error";
  updateBtn.classList.toggle("visible", button);
  if (phase === "available") updateBtn.dataset.tip = t("updateAvailableTip", { version });
  else if (phase === "ready") updateBtn.dataset.tip = t("updateReadyTip", { version });
  else if (phase === "error") updateBtn.dataset.tip = t("updateErrorTip", { error: updateState.error || "?" });
}
function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function renderUpdatePanel() {
  renderUpdateIndicator();
  if (!updatePanel) return;
  const { phase, info, downloaded } = updateState;
  const show = phase !== "idle";
  updatePanel.classList.toggle("hidden", !show);
  if (!show || !info) return;
  updateNotes.classList.toggle("hidden", !info.notes);
  updateNotes.textContent = info.notes || "";
  switch (phase) {
    case "available":
      updateTitle.textContent = window.i18n.t("updAvailable", { v: info.latest });
      updateMeta.textContent = `${window.i18n.t("updYouHave", { v: info.current })}${info.asset_size ? " · " + formatBytes(info.asset_size) : ""}`;
      updateAction.textContent = window.i18n.t("updDownload");
      updateAction.classList.remove("hidden");
      break;
    case "downloading":
      updateTitle.textContent = window.i18n.t("updDownloadingTitle");
      updateMeta.textContent = info.asset_size ? formatBytes(info.asset_size) : "";
      updateAction.textContent = window.i18n.t("updDownloading");
      updateAction.classList.add("hidden");
      break;
    case "ready":
      updateTitle.textContent = window.i18n.t("updDownloaded", { v: info.latest });
      updateMeta.textContent = downloaded ? `${downloaded.file_name} · ${formatBytes(downloaded.size)}` : "";
      updateAction.textContent = window.i18n.t("updInstall");
      updateAction.classList.remove("hidden");
      break;
    case "error":
      updateTitle.textContent = window.i18n.t("updFailed");
      updateMeta.textContent = updateState.error || window.i18n.t("updNoGithub");
      updateAction.textContent = window.i18n.t("updRetry");
      updateAction.classList.remove("hidden");
      break;
  }
}
function setUpdatePhase(phase, extra) {
  updateState = { ...updateState, phase, ...(extra || {}) };
  renderUpdatePanel();
}
async function checkForUpdates(manual) {
  if (updateState.phase === "downloading") return;
  if (manual) {
    checkUpdateBtn.disabled = true;
    checkUpdateBtn.textContent = window.i18n.t("updChecking");
  }
  try {
    const info = await invoke("check_for_updates");
    // A download that already finished stays offered; checking again changes nothing.
    if (updateState.phase === "ready" && updateState.info && updateState.info.latest === info.latest) return;
    updateState = { phase: "idle", info, downloaded: null, error: null };
    if (!info.update_available) {
      renderUpdatePanel();
      if (manual) showToast(window.i18n.t("updUpToDate"));
    } else {
      updateState.phase = "available";
      renderUpdatePanel();
      if (manual) showToast(window.i18n.t("updFound"), false, window.i18n.t("updFoundDetail"));
      startUpdateDownload(info);
    }
  } catch (err) {
    const error = String(err).replace("Error:", "").trim();
    if (manual) {
      updateState = { phase: "error", info: updateState.info, downloaded: null, error };
      renderUpdatePanel();
      showToast(window.i18n.t("updCheckFailed"), true, error);
    } else {
      console.warn("background update check failed:", error);
    }
  } finally {
    if (checkUpdateBtn) {
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = window.i18n.t("updCheck");
    }
  }
}
async function startUpdateDownload(info) {
  if (!info.asset_url || !info.asset_name) {
    updateState = { ...updateState, phase: "error", error: t("updNoAsset") };
    renderUpdatePanel();
    return;
  }
    updateState = { phase: "downloading", info, downloaded: null, error: null };
    updatePct = 0;
    renderUpdatePanel();
  try {
    await invoke("download_update", {
      url: info.asset_url,
      fileName: info.asset_name,
      size: info.asset_size,
    });
  } catch (err) {
    updateState = { phase: "error", info, downloaded: null, error: String(err).replace("Error:", "").trim() };
    renderUpdatePanel();
  }
}
if (checkUpdateBtn) {
  checkUpdateBtn.addEventListener("click", () => checkForUpdates(true));
}
async function runUpdateAction() {
  const { phase, info } = updateState;
  if (phase === "available" && info) return startUpdateDownload(info);
  if (phase === "ready") {
    try {
      // The Rust side quits Umbra once the installer has been handed off,
      // so we only need to say goodbye before the window disappears.
      updateAction.disabled = true;
      updateAction.textContent = window.i18n.t("updInstalling");
      updateState = { ...updateState, phase: "idle" };
      renderUpdateIndicator();
      await invoke("install_update");
    } catch (err) {
      updateAction.disabled = false;
      showToast(window.i18n.t("updInstallFailed"), true, String(err).replace("Error:", "").trim());
    }
    return;
  }
  if (phase === "error") {
    // Retry the download when we know what to fetch, otherwise check again.
    if (info && info.update_available) return startUpdateDownload(info);
    updateState = { ...updateState, phase: "idle" };
    renderUpdatePanel();
    return checkForUpdates(true);
  }
}
if (updateAction) updateAction.addEventListener("click", runUpdateAction);
updateBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  runUpdateAction();
});
// Look for a new release on our own: shortly after start, then every 6 hours.
setTimeout(() => checkForUpdates(false), 8000);
setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
listen("update-progress", (event) => {
  const p = event.payload || {};
  updatePct = Math.max(0, Math.min(100, Number(p.pct || 0)));
  if (updateState.phase === "downloading") renderUpdateIndicator();
  if (updateMeta && p.total) updateMeta.textContent = `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`;
});
listen("update-downloaded", (event) => {
  const done = event.payload || {};
  updateState = { ...updateState, phase: "ready", downloaded: done };
  renderUpdatePanel();
  showToast(window.i18n.t("updReady"), false, done.file_name);
});
listen("update-error", (event) => {
  updateState = {
    ...updateState,
    phase: "error",
    error: String(event.payload || "download failed"),
  };
  renderUpdatePanel();
  showToast(window.i18n.t("updFailed"), true, updateState.error);
});
const themePresetsEl = document.getElementById("theme-presets");
const accentSwatchesEl = document.getElementById("accent-swatches");
const bgSwatchesEl = document.getElementById("bg-swatches");
const accentCustom = document.getElementById("accent-custom");
const bgCustom = document.getElementById("bg-custom");
const radiusVal = document.getElementById("setting-radius-val");
const gapVal = document.getElementById("setting-gap-val");
const alphaVal = document.getElementById("setting-alpha-val");
const borderRow = document.getElementById("setting-border-row");
const borderToggle = document.getElementById("setting-border");
const borderWVal = document.getElementById("setting-borderw-val");
const borderPosSeg = document.getElementById("border-pos-seg");
const densitySeg = document.getElementById("density-seg");
const fontSeg = document.getElementById("font-seg");
const tallRow = document.getElementById("setting-tall-row");
const systemRow = document.getElementById("setting-system-row");
const systemToggle = document.getElementById("setting-system");
// Windows' light/dark mode and accent, for "Match Windows" (theme.followSystem).
let systemTheme = null;
async function refreshSystemTheme() {
  try {
    systemTheme = await invoke("get_system_theme");
  } catch {
    systemTheme = null;
  }
  if (theme && theme.followSystem) applyTheme();
}
// The colours actually drawn: the saved ones, or with "Match Windows" the
// Default / Paper palette for dark / light plus the Windows accent.
function effectiveColors() {
  if (!theme.followSystem || !systemTheme) {
    return { cardBg: theme.cardBg, text: theme.text, accent: theme.accent };
  }
  const base = THEME_PRESETS.find((p) => p.name === (systemTheme.dark ? "Default" : "Paper"));
  return { cardBg: base.cardBg, text: base.text, accent: systemTheme.accent || base.accent };
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshSystemTheme);
const tallToggle = document.getElementById("setting-tall");
const sidePreviewRow = document.getElementById("setting-sidepreview-row");
const sidePreviewToggle = document.getElementById("setting-sidepreview");
const glowToggle = document.getElementById("setting-glow");
const glowVal = document.getElementById("setting-glow-val");
const glowCustom = document.getElementById("glow-custom");
const borderCustom = document.getElementById("border-custom");
// Only two dark/light pairs of palettes: Default is the stock Umbra look,
// Flexoki and Paper are the Flexoki scheme (dark and light), with the Flexoki
// card red-tinted so it sits with the red accent instead of against it.
const THEME_PRESETS = [
  { name: "Default", cardBg: "#1e1e1e", accent: "#507090", alpha: 1, text: "#e3e3e3" },
  { name: "Paper",   cardBg: "#f2f0e5", accent: "#205ea6", alpha: 1, text: "#100f0f" },
  { name: "Flexoki", cardBg: "#1e1918", accent: "#d14d41", alpha: 1, text: "#cecdc3" },
  { name: "Cream",   cardBg: "#f5f0dc", accent: "#f0442e", alpha: 1, text: "#171717" },
];
// Flexoki accents: red, orange, blue, green, purple (yellow, cyan and magenta
// went away — the row was too long to scan). Light values are the 600 steps,
// dark ones the 400 steps, so each pair is the same colour on paper or ink.
const ACCENTS_DARK = ["#d14d41", "#da702c", "#4385be", "#879a39", "#8b7ec8"];
const ACCENTS_LIGHT = ["#af3029", "#bc5215", "#205ea6", "#66800b", "#5e409d"];
// Four dark, four light.
const BG_SWATCHES = ["#1e1e1e", "#1e1918", "#100f0f", "#282726", "#fffcf0", "#f2f0e5", "#e6e4d9", "#d9d6c9"];
function accentList() {

  const m = /^#?([0-9a-f]{6})$/i.exec(theme.text || "");
  if (!m) return ACCENTS_DARK;
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.5 ? ACCENTS_LIGHT : ACCENTS_DARK;
}
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
function textForBg(bgHex) {
  const bgLum = luminance(bgHex);
  const curLum = luminance(theme.text || "#e3e3e3");
  const contrastOk = Math.abs(bgLum - curLum) > 0.35;
  if (contrastOk) return theme.text;
  return bgLum > 0.55 ? "#100f0f" : "#e3e3e3";
}
let theme = null;
function hexWithAlpha(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16).padStart(2, "0");
  return hex + a;
}
// `inert` keeps a folded row out of the tab order and away from assistive tech
// as well; the stylesheet does the folding.
function setDepHidden(id, hidden) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("dep-hidden", hidden);
  el.inert = hidden;
}
function applyTheme() {
  if (!theme) return;
  const root = document.documentElement;
  const customStyleEl = document.getElementById("custom-theme-style");
  if (theme.customTheme && window.__customThemes) {
    const custom = window.__customThemes.find(t => t.name === theme.customTheme);
    if (custom) {
      customStyleEl.textContent = custom.css;
      document.body.classList.add("custom-theme-active");
    } else {
      customStyleEl.textContent = "";
      document.body.classList.remove("custom-theme-active");
    }
  } else {
    customStyleEl.textContent = "";
    document.body.classList.remove("custom-theme-active");
  }
  const colors = effectiveColors();
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--card-bg", hexWithAlpha(colors.cardBg, theme.cardAlpha));
  root.style.setProperty("--text", colors.text);
  systemToggle.classList.toggle("on", !!theme.followSystem);
  document.body.classList.toggle("follows-system", !!theme.followSystem);
  // Settings that another one makes pointless are not shown (see .dep-row in the
  // stylesheet): Windows decides the colours, and with no border there is no
  // width or style to pick.
  for (const id of ["row-presets", "row-accent", "row-bg"]) setDepHidden(id, !!theme.followSystem);
  setDepHidden("border-extras", !theme.borderOn);
  setDepHidden("glow-extras", !theme.glow);
  root.style.setProperty("--card-radius", theme.radius + "px");
  // Row/search/gap sizing comes from the [data-density] rules in the
  // stylesheet, so it stays overridable by custom themes.
  root.dataset.density = theme.density || "full";
  const font = theme.font || "wix";
  root.dataset.font = font.startsWith("sys:") ? "system" : font;
  // A font picked with !font: the name is validated on the Rust side, so it cannot leave the quotes.
  if (font.startsWith("sys:")) root.style.setProperty("--font-main", `'${font.slice(4)}', 'Noto Sans JP', 'Segoe UI', system-ui, sans-serif`);
  else root.style.removeProperty("--font-main");
  renderSystemFonts();
  // Inline, so a chosen spacing wins over the density preset it came from.
  root.style.setProperty("--gap", (theme.gap ?? 12) + "px");
  root.style.setProperty("--card-border-w", (theme.borderOn ? theme.borderW : 0) + "px");
  root.dataset.borderPos = theme.borderOn ? theme.borderPos : "center";
  root.style.setProperty("--glow-size", (theme.glow ? theme.glowStrength : 0) + "px");
  // An empty colour leaves the stylesheet's own (accent-based glow, theme border).
  if (theme.glowColor) root.style.setProperty("--glow-alpha", theme.glowColor);
  else root.style.removeProperty("--glow-alpha");
  if (theme.borderColor) root.style.setProperty("--card-border", theme.borderColor);
  else root.style.removeProperty("--card-border");
  if (typeof applyDock === "function") applyDock();
  setVal(radiusVal, theme.radius);
  setVal(gapVal, theme.gap ?? 12);
  setVal(alphaVal, Math.round(theme.cardAlpha * 100) + "%");
  setVal(borderWVal, theme.borderW);
  setVal(glowVal, theme.glow ? theme.glowStrength : window.i18n.t("glowOff"));
  borderToggle.classList.toggle("on", !!theme.borderOn);
  glowToggle.classList.toggle("on", !!theme.glow);
  borderPosSeg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.pos === theme.borderPos));
  densitySeg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.density === theme.density));
  fontSeg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.font === font));
  tallToggle.classList.toggle("on", !!theme.tallResults);
  sidePreviewToggle.classList.toggle("on", !!theme.sidePreview);
  root.dataset.sidePreview = theme.sidePreview ? "on" : "off";
  if (window.UmbraSidePreview) window.UmbraSidePreview.refresh();
  accentCustom.style.background = theme.accent;
  glowCustom.style.background = theme.glowColor || "var(--accent)";
  borderCustom.style.background = theme.borderColor || "var(--card-border)";
  bgCustom.style.background = theme.cardBg;
  renderAccentSwatches();
  markActiveSwatches();
}
function markActiveSwatches() {
  const isPreset = THEME_PRESETS.find(
    p => p.cardBg === theme.cardBg && p.accent === theme.accent && p.alpha === theme.cardAlpha
  );

  themePresetsEl.querySelectorAll(".swatch").forEach((el) => {
    let isActive = false;
    if (theme.customTheme) {
      if (el.dataset.tip === "Custom: " + theme.customTheme) isActive = true;
    } else {
      if (isPreset && el.dataset.tip === isPreset.name) isActive = true;
    }
    el.classList.toggle("active", isActive);
  });
  accentSwatchesEl.querySelectorAll(".swatch").forEach((el) =>
    el.classList.toggle("active", el.dataset.color === theme.accent));
  bgSwatchesEl.querySelectorAll(".swatch").forEach((el) =>
    el.classList.toggle("active", el.dataset.color === theme.cardBg));
}
// Two saves that overlap can come back in the other order, and the older
// answer would then roll the newer setting back. The counter says which
// answer is the one that counts.
let themeSaveId = 0;
async function saveTheme() {
  const myId = ++themeSaveId;
  try {
    const saved = await invoke("set_theme", { theme });
    if (myId !== themeSaveId) return;
    theme = saved;
    applyTheme();
  } catch (err) {
    if (myId === themeSaveId) setSettingsStatus(String(err), true);
  }
}
function buildSwatches(container, colors, onPick) {
  colors.forEach((c) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c;
    b.dataset.tip = c;
    b.dataset.color = c;
    b.addEventListener("click", () => { onPick(c); b.blur(); });
    container.appendChild(b);
  });
}
function renderAccentSwatches() {
  accentSwatchesEl.innerHTML = "";
  buildSwatches(accentSwatchesEl, accentList(), (c) => { theme = { ...theme, accent: c }; saveTheme(); });
}
buildSwatches(bgSwatchesEl, BG_SWATCHES, (c) => {
  theme = { ...theme, cardBg: c, text: textForBg(c) };
  applyTheme();
  saveTheme();
});
function renderThemePresets(customThemes) {
  themePresetsEl.innerHTML = "";
  THEME_PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = p.accent;
    b.dataset.tip = p.name;
    b.addEventListener("click", () => {
      theme = { ...theme, cardBg: p.cardBg, accent: p.accent, cardAlpha: p.alpha, text: p.text, customTheme: null };
      saveTheme();
      b.blur();
    });
    themePresetsEl.appendChild(b);
  });
  if (customThemes) {
    customThemes.forEach((t) => {
      const b = document.createElement("button");
      b.className = "swatch";
      b.style.background = "var(--text-dim)";
      b.dataset.tip = window.i18n.t("customTheme", { name: t.name });
      b.addEventListener("click", () => {
        theme = { ...theme, customTheme: t.name };
        saveTheme();
        b.blur();
      });
      themePresetsEl.appendChild(b);
    });
  }
  const addBtn = document.createElement("button");
  addBtn.className = "swatch";
  addBtn.style.background = "transparent";
  addBtn.style.border = "1px dashed var(--text-dim)";
  addBtn.style.color = "var(--text-dim)";
  addBtn.textContent = "+";
  addBtn.style.display = "flex";
  addBtn.style.alignItems = "center";
  addBtn.style.justifyContent = "center";
  addBtn.dataset.tip = window.i18n.t("openThemesFolder");
  addBtn.addEventListener("click", () => {
    invoke("open_themes_folder").catch(console.error);
    addBtn.blur();
  });
  themePresetsEl.appendChild(addBtn);
  markActiveSwatches();
}
let _lastCustomThemesStr = "";
async function loadThemes() {
  try {
    const customThemes = await invoke("get_custom_themes");
    customThemes.sort((a, b) => a.name.localeCompare(b.name));

    const currentStr = JSON.stringify(customThemes);
    if (currentStr !== _lastCustomThemesStr) {
      _lastCustomThemesStr = currentStr;
      window.__customThemes = customThemes;
      renderThemePresets(customThemes);
      applyTheme();
    }
  } catch (e) {
    console.error("Failed to fetch custom themes", e);
  }
}
// loadThemes interval moved to loadTheme()
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    const val = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(val * 255).toString(16).padStart(2, "0");
  };
  return "#" + f(5) + f(3) + f(1);
}
function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
const picker = document.createElement("div");
picker.id = "color-picker";
picker.className = "cp-hidden";
picker.innerHTML = `
  <div class="cp-sv" id="cp-sv"><div class="cp-knob" id="cp-sv-knob"></div></div>
  <div class="cp-hue" id="cp-hue"><div class="cp-knob" id="cp-hue-knob"></div></div>
  <div class="cp-alpha" id="cp-alpha"><div class="cp-alpha-fill" id="cp-alpha-fill"></div><div class="cp-knob" id="cp-alpha-knob"></div></div>
  <div class="cp-row">
    <div class="cp-preview" id="cp-preview"></div>
    <input class="cp-hex" id="cp-hex" maxlength="9" spellcheck="false" autocomplete="off">
  </div>
`;
document.body.appendChild(picker);
const cpSv = picker.querySelector("#cp-sv");
const cpSvKnob = picker.querySelector("#cp-sv-knob");
const cpHue = picker.querySelector("#cp-hue");
const cpHueKnob = picker.querySelector("#cp-hue-knob");
const cpAlpha = picker.querySelector("#cp-alpha");
const cpAlphaFill = picker.querySelector("#cp-alpha-fill");
const cpAlphaKnob = picker.querySelector("#cp-alpha-knob");
const cpPreview = picker.querySelector("#cp-preview");
const cpHex = picker.querySelector("#cp-hex");
const pickerState = { h: 210, s: 0.5, v: 0.56, a: 1, aMin: 0, alpha: false, alphaInHex: false, onChange: null };
// #rrggbb, or #rrggbbaa when the colour carries its own opacity.
function composeColor(hex, a) {
  return a >= 0.995 ? hex : hex + Math.round(a * 255).toString(16).padStart(2, "0");
}
let pickerOpen = false;
let saveThemeTimer = null;
function saveThemeDebounced() {
  clearTimeout(saveThemeTimer);
  saveThemeTimer = setTimeout(saveTheme, 250);
}
function pickerRefresh(syncHex = true) {
  const hex = hsvToHex(pickerState.h, pickerState.s, pickerState.v);
  cpSv.style.background =
    `linear-gradient(to top, #000, rgba(0,0,0,0)), ` +
    `linear-gradient(to right, #fff, rgba(255,255,255,0)), ` +
    `hsl(${Math.round(pickerState.h)}, 100%, 50%)`;
  cpSvKnob.style.left = (pickerState.s * 100) + "%";
  cpSvKnob.style.top = ((1 - pickerState.v) * 100) + "%";
  cpHueKnob.style.left = (pickerState.h / 360) * 100 + "%";
  cpPreview.style.background = pickerState.alpha ? composeColor(hex, pickerState.a) : hex;
  cpAlphaFill.style.background = `linear-gradient(to right, transparent, ${hex})`;
  const span = 1 - pickerState.aMin || 1;
  cpAlphaKnob.style.left = ((pickerState.a - pickerState.aMin) / span) * 100 + "%";
  cpAlphaKnob.style.top = "50%";
  if (syncHex) cpHex.value = pickerState.alphaInHex ? composeColor(hex, pickerState.a) : hex;
  if (pickerState.onChange) pickerState.onChange(hex, pickerState.a);
}
function bindPickerDrag(el, onPoint) {
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    onPoint(e);
    const move = (ev) => onPoint(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}
bindPickerDrag(cpSv, (e) => {
  const r = cpSv.getBoundingClientRect();
  pickerState.s = clamp01((e.clientX - r.left) / r.width);
  pickerState.v = 1 - clamp01((e.clientY - r.top) / r.height);
  pickerRefresh();
});
bindPickerDrag(cpAlpha, (e) => {
  const r = cpAlpha.getBoundingClientRect();
  const p = clamp01((e.clientX - r.left) / r.width);
  pickerState.a = pickerState.aMin + p * (1 - pickerState.aMin);
  pickerRefresh();
});
bindPickerDrag(cpHue, (e) => {
  const r = cpHue.getBoundingClientRect();
  pickerState.h = clamp01((e.clientX - r.left) / r.width) * 360;
  pickerRefresh();
});
cpHex.addEventListener("input", () => {
  const m8 = /^#?([0-9a-f]{6})([0-9a-f]{2})$/i.exec(cpHex.value.trim());
  if (m8 && pickerState.alphaInHex) {
    pickerState.a = Math.max(pickerState.aMin, parseInt(m8[2], 16) / 255);
  }
  const hsv = hexToHsv(m8 ? m8[1] : cpHex.value);
  if (!hsv) return;
  pickerState.h = hsv.h;
  pickerState.s = hsv.s;
  pickerState.v = hsv.v;
  pickerRefresh(false);
});
function closePicker() {
  if (!pickerOpen) return;
  pickerOpen = false;
  picker.classList.add("cp-hidden");
  saveThemeDebounced(); 
  pickerState.onChange = null;
}
// opts.alpha adds an opacity slider; opts.alphaValue is where it starts, opts.alphaMin its floor,
// and opts.alphaInHex puts the opacity into the hex field as well (#rrggbbaa).
function openPicker(anchor, initialHex, onChange, opts = {}) {
  const m8 = /^#?([0-9a-f]{6})([0-9a-f]{2})$/i.exec(initialHex.trim());
  const hsv = hexToHsv(m8 ? m8[1] : initialHex) || { h: 210, s: 0.5, v: 0.56 };
  pickerState.alpha = !!opts.alpha;
  pickerState.alphaInHex = !!opts.alphaInHex;
  pickerState.aMin = opts.alphaMin || 0;
  pickerState.a = m8 && opts.alphaInHex ? parseInt(m8[2], 16) / 255 : (opts.alphaValue ?? 1);
  picker.classList.toggle("cp-alpha-on", pickerState.alpha);
  pickerState.h = hsv.h;
  pickerState.s = hsv.s;
  pickerState.v = hsv.v;
  pickerState.onChange = onChange;
  pickerRefresh();
  picker.classList.remove("cp-hidden");
  pickerOpen = true;
  const z = uiZoom();
  const r = anchor.getBoundingClientRect();
  const pw = picker.offsetWidth;
  const ph = picker.offsetHeight;
  const vw = window.innerWidth * z;
  const vh = window.innerHeight * z;
  let x = Math.max(8, Math.min(r.right - pw, vw - pw - 8));
  let y = r.bottom + 10;
  const above = y + ph > vh - 8;
  if (above) y = Math.max(8, r.top - ph - 10);
  picker.style.left = x / z + "px";
  picker.style.top = y / z + "px";
  picker.style.transformOrigin = `${(r.left + r.width / 2 - x) / z}px ${above ? "100%" : "0"}`;
}
accentCustom.addEventListener("click", () => {
  if (pickerOpen) { closePicker(); return; }
  openPicker(accentCustom, theme.accent, (hex) => {
    theme = { ...theme, accent: hex };
    applyTheme();
    saveThemeDebounced();
  });
});
bgCustom.addEventListener("click", () => {
  if (pickerOpen) { closePicker(); return; }
  openPicker(bgCustom, theme.cardBg, (hex, a) => {
    theme = { ...theme, cardBg: hex, cardAlpha: Math.max(0.4, Math.min(1, a)), text: textForBg(hex) };
    applyTheme();
    saveThemeDebounced();
  }, { alpha: true, alphaMin: 0.4, alphaValue: theme.cardAlpha });
});
glowCustom.addEventListener("click", () => {
  if (pickerOpen) { closePicker(); return; }
  openPicker(glowCustom, theme.glowColor || theme.accent, (hex, a) => {
    theme = { ...theme, glowColor: composeColor(hex, a), glow: true };
    applyTheme();
    saveThemeDebounced();
  }, { alpha: true, alphaInHex: true, alphaValue: theme.glowColor ? 1 : 0.4 });
});
borderCustom.addEventListener("click", () => {
  if (pickerOpen) { closePicker(); return; }
  openPicker(borderCustom, theme.borderColor || "#ffffff", (hex, a) => {
    theme = { ...theme, borderColor: composeColor(hex, a), borderOn: true };
    applyTheme();
    saveThemeDebounced();
  }, { alpha: true, alphaInHex: true, alphaValue: theme.borderColor ? 1 : 0.08 });
});
document.addEventListener("pointerdown", (e) => {
  if (!pickerOpen) return;
  if (e.target instanceof Element && (picker.contains(e.target) || e.target.closest("#accent-custom,#bg-custom,#glow-custom,#border-custom"))) return;
  closePicker();
}, true);
document.addEventListener("keydown", (e) => {
  if (pickerOpen && e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePicker();
  }
}, true);
picker.addEventListener("keydown", (e) => e.stopPropagation());
function bindStepper(minusId, plusId, get, set) {
  const minus = document.getElementById(minusId);
  const plus = document.getElementById(plusId);

  minus.addEventListener("click", () => { set(get() - 1); minus.blur(); });
  plus.addEventListener("click", () => { set(get() + 1); plus.blur(); });
}
function bindScrub(el, get, set, pxPerStep = 9) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    let startVal;
    try { startVal = get(); } catch { return; }
    if (startVal == null || Number.isNaN(startVal)) return;
    e.preventDefault();
    const startX = e.clientX;
    const mult = e.shiftKey ? 5 : 1;
    let lastSteps = 0;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const steps = Math.trunc((ev.clientX - startX) / pxPerStep) * mult;
      if (steps !== lastSteps) {
        lastSteps = steps;
        set(startVal + steps);
      }
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  });
}
bindStepper("setting-radius-minus", "setting-radius-plus",
  () => theme.radius, (v) => { theme = { ...theme, radius: Math.max(0, Math.min(24, v)) }; saveTheme(); });
bindStepper("setting-gap-minus", "setting-gap-plus",
  () => theme.gap ?? 12, (v) => { theme = { ...theme, gap: Math.max(0, Math.min(24, v)) }; saveTheme(); });
bindStepper("setting-alpha-minus", "setting-alpha-plus",
  () => Math.round(theme.cardAlpha * 100), (v) => {
    theme = { ...theme, cardAlpha: Math.max(0.4, Math.min(1, v / 100)) };
    saveTheme();
  });
bindStepper("setting-borderw-minus", "setting-borderw-plus",
  () => theme.borderW, (v) => {

    theme = { ...theme, borderW: Math.max(0, Math.min(8, v)), borderOn: true };
    saveTheme();
  });
bindStepper("setting-glow-minus", "setting-glow-plus",
  () => theme.glowStrength, (v) => {
    theme = { ...theme, glowStrength: Math.max(0, Math.min(40, v)), glow: true };
    saveTheme();
  });

/* Drag a number sideways to change it, like a design tool. bindScrub used to
   exist with a cursor already on .zoom-stepper span, but nothing ever called
   it, so the cursor promised a drag that could not happen. */
const clampStep = (min, max) => (v) => Math.max(min, Math.min(max, v));
bindScrub(settingZoomVal,
  () => parseFloat(settingZoomVal.textContent) || 1,
  (v) => applyZoom(v, true),
  3);
bindScrub(alphaVal,
  () => Math.round(theme.cardAlpha * 100),
  (v) => { theme = { ...theme, cardAlpha: clampStep(40, 100)(v) / 100 }; saveTheme(); });
bindScrub(radiusVal,
  () => theme.radius,
  (v) => { theme = { ...theme, radius: clampStep(0, 24)(Math.round(v)) }; saveTheme(); });
bindScrub(gapVal,
  () => theme.gap ?? 12,
  (v) => { theme = { ...theme, gap: clampStep(0, 24)(Math.round(v)) }; saveTheme(); });
bindScrub(borderWVal,
  () => theme.borderW,
  (v) => { theme = { ...theme, borderW: clampStep(0, 8)(v), borderOn: true }; saveTheme(); });
bindScrub(glowVal,
  () => theme.glowStrength,
  (v) => { theme = { ...theme, glowStrength: clampStep(0, 40)(Math.round(v)), glow: true }; saveTheme(); });
borderRow.addEventListener("click", (e) => {
  if (e.target.closest(".row-extras")) return;
  theme = { ...theme, borderOn: !theme.borderOn };
  saveTheme();
});
glowToggle.parentElement.addEventListener("click", (e) => {
  if (e.target.closest(".zoom-stepper, .swatch-custom")) return;
  theme = { ...theme, glow: !theme.glow };
  saveTheme();
});
borderPosSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  e.stopPropagation();
  theme = { ...theme, borderPos: btn.dataset.pos };
  saveTheme();
});
densitySeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  e.stopPropagation();
  theme = { ...theme, density: btn.dataset.density };
  saveTheme();
});
// The fonts picked with !font sit before the built-in choices; right-click one to drop it.
function renderSystemFonts() {
  const names = theme.systemFonts || [];
  const have = [...fontSeg.querySelectorAll(".seg-btn[data-sys]")].map((b) => b.dataset.font.slice(4));
  if (names.length !== have.length || !names.every((n, i) => n === have[i])) {
    fontSeg.querySelectorAll(".seg-btn[data-sys]").forEach((b) => b.remove());
    addSystemFonts(names);
  }
  // Four to a line at most, and no empty cell while there are fewer.
  fontSeg.style.setProperty("--font-cols", Math.min(4, fontSeg.children.length));
}
function addSystemFonts(names) {
  const firstBuiltIn = fontSeg.querySelector(".seg-btn:not([data-sys])");
  for (const name of names) {
    const b = document.createElement("button");
    b.className = "seg-btn";
    b.dataset.font = "sys:" + name;
    b.dataset.sys = "1";
    b.dataset.tip = name + " · " + window.i18n.t("fontRemoveTip");
    b.style.fontFamily = `'${name}', var(--font-main)`;
    b.textContent = name;
    fontSeg.insertBefore(b, firstBuiltIn);
  }
}
fontSeg.addEventListener("contextmenu", (e) => {
  const btn = e.target.closest(".seg-btn[data-sys]");
  if (!btn) return;
  e.preventDefault();
  const name = btn.dataset.font.slice(4);
  theme = {
    ...theme,
    systemFonts: (theme.systemFonts || []).filter((n) => n !== name),
    font: theme.font === btn.dataset.font ? "wix" : theme.font,
  };
  saveTheme();
});
fontSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  e.stopPropagation();
  theme = { ...theme, font: btn.dataset.font };
  saveTheme();
});
// The window itself is resized on the Rust side (set_theme refits it).
systemRow.addEventListener("click", async () => {
  theme = { ...theme, followSystem: !theme.followSystem };
  if (theme.followSystem) await refreshSystemTheme();
  saveTheme();
});
sidePreviewRow.addEventListener("click", () => {
  theme = { ...theme, sidePreview: !theme.sidePreview };
  saveTheme();
});
tallRow.addEventListener("click", () => {
  theme = { ...theme, tallResults: !theme.tallResults };
  saveTheme();
});
async function loadTheme() {
  if (theme) return;
  try {
    theme = await invoke("get_theme");
    if (theme.followSystem) systemTheme = await invoke("get_system_theme").catch(() => null);
    await loadThemes();
    applyTheme();
    applyAnimSettings();
  } catch (e) {
    console.warn("theme load failed:", e);
  }
}
// The Rust side watches the themes folder and pushes this event whenever a
// .css file appears, changes or disappears — no polling from the webview.
listen("themes-changed", () => { loadThemes(); });
const alignGridEl = document.getElementById("align-grid");
const monitorButtonsEl = document.getElementById("monitor-buttons");
const ALIGN_GRID = [
  ["tl", "tc", "tr"],
  ["cl", "cc", "cr"],
  ["bl", "bc", "br"],
];
const alignTip = (c) => window.i18n.t({ t: "alignTop", c: "alignCenter", b: "alignBottom", l: "alignLeft", r: "alignRight" }[c]);
let placement = { align: "cc", monitor: -1 };
let lastMonitors = [];
function pop(el) {
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}
function setVal(el, text) {
  if (el.textContent !== text) {
    el.textContent = text;
    pop(el);
  }
}
function renderAlignGrid() {
  alignGridEl.innerHTML = "";
  ALIGN_GRID.forEach((row) => {
    row.forEach((code) => {
      const b = document.createElement("button");
      b.className = "align-cell";
      b.dataset.code = code;
      b.dataset.tip = `${alignTip(code[0])} ${alignTip(code[1])}`;
      b.addEventListener("click", () => {
        placement.align = code;
        updatePlacementUI();
        savePlacement();
        b.blur();
      });
      alignGridEl.appendChild(b);
    });
  });
  updatePlacementUI();
}
function renderMonitorButtons(monitors) {
  lastMonitors = monitors;
  monitorButtonsEl.innerHTML = "";
  const mk = (label, monIndex, tip) => {
    const b = document.createElement("button");
    b.className = "seg-btn";
    b.dataset.monIndex = monIndex;
    b.textContent = label;
    if (tip) b.dataset.tip = tip;
    b.addEventListener("click", () => {
      placement.monitor = monIndex;
      updatePlacementUI();
      savePlacement();
      b.blur();
    });
    monitorButtonsEl.appendChild(b);
  };
  mk(t("monActive"), -1, t("monActiveTip"));
  monitors.forEach((m) => {
    mk(m.primary ? `${m.index + 1}*` : String(m.index + 1), m.index,
      `${m.width}×${m.height}${m.primary ? " · " + t("monPrimary") : ""}`);
  });
  updatePlacementUI();
}
function updatePlacementUI() {
  alignGridEl.querySelectorAll(".align-cell").forEach((b) => {
    b.classList.toggle("active", placement.align === b.dataset.code);
  });
  monitorButtonsEl.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", placement.monitor === parseInt(b.dataset.monIndex));
  });
}
async function loadPlacement() {
  try {
    const [p, monitors] = await Promise.all([
      invoke("get_placement"),
      invoke("list_monitors"),
    ]);
    placement = p;
    renderAlignGrid();
    renderMonitorButtons(monitors);
  } catch (e) {
    console.warn("placement load failed:", e);
  }
}
function savePlacement() {
  invoke("set_placement", { align: placement.align, monitor: placement.monitor })
    .then((p) => {
      placement = p;
      updatePlacementUI();
    })
    .catch((err) => setSettingsStatus(String(err), true));
}
function wheelStepPx() {
  // One scroll step is a full row pitch: card height plus the gap, both of
  // which the density mode changes.
  const cs = getComputedStyle(document.documentElement);
  const card = parseFloat(cs.getPropertyValue("--card-h")) || 52;
  const gap = parseFloat(cs.getPropertyValue("--gap")) || 12;
  return card + gap;
}
let isHiding = false;
let hideTimer = null;
// A long path keeps its end: the last two segments never shrink and the front gives way with an
// ellipsis, so "C:UsersFre…RoamingHelium" and not "C:UsersFreezxAppDataR…".
function pathHtml(path) {
  const parts = path.split("\\");
  if (parts.length < 4) return escapeHtml(path);
  const head = parts.slice(0, -2).join("\\");
  const tail = parts.slice(-2).join("\\");
  return `<span class="rp-head">${escapeHtml(head)}</span><span class="rp-tail">\\${escapeHtml(tail)}</span>`;
}
function hideWindow() {
  if (isHiding) return;
  isHiding = true;
  // An open colour picker must not still be there when the window comes back.
  closePicker();
  contextMenu.classList.remove("visible");
  appContainer.classList.remove("window-showing");
  appContainer.classList.add("window-hidden");
  // The timer is cleared but the variable was left pointing at a dead id, so
  // the next time the window opened the check below found it set and the
  // placeholder never started again -- the typing examples were gone for good
  // after the first close.
  clearTimeout(placeholderTimer);
  placeholderTimer = null;

  clearTimeout(hideTimer);
  hideTimer = setTimeout(async () => {
    // The theme panel goes with the window, so it is not there for a moment on the next summon.
    if (typeof resetThemePanelNow === "function") await resetThemePanelNow();
    invoke("hide_window");
    // Only now, with the window gone and its fade finished, take the list off
    // screen: the rows stay put while the app is still fading out, so nothing
    // vanishes early. On the next open the class is what keeps the finished
    // list from flashing before the staggered animation.
    appContainer.classList.add("content-stale");
    isHiding = false;
  }, 280);
}
// False while pins live in the side dock (dock.js) instead of under the empty search box.
function pinsInList() {
  const style = document.documentElement.dataset.pins;
  return style !== "left" && style !== "right";
}
function updateSelectableItems() {
  if (lastQuery.trim() || !pinsInList()) {
    selectableItems = [...allResults];
  } else {
    selectableItems = [...currentPins, ...allResults];
  }
}
const EXE_GLYPH = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8-4 4 4 4m10-8 4 4-4 4M14 4l-4 16"/></svg>`;
const FOLDER_GLYPH = `<svg class="ico tile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"/></svg>`;
const PHOTO_GLYPH = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="m3 16l5-5c.928-.893 2.072-.893 3 0l5 5"/><path d="m14 14l1-1c.928-.893 2.072-.893 3 0l3 3"/></svg>`;
const PIN_GLYPH = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path class="pin-fill" fill="currentColor" d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/></svg>`;
function getTypeIcon(kind) {
  const icons = {
    app: EXE_GLYPH,
    shortcut: EXE_GLYPH,
    code: EXE_GLYPH,
    file: EXE_GLYPH,
    folder: FOLDER_GLYPH,
    image: PHOTO_GLYPH,
    document: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2M9 9h1m-1 4h6m-6 4h6"/></svg>`,
    audio: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17a3 3 0 1 0 6 0a3 3 0 0 0-6 0m10 0a3 3 0 1 0 6 0a3 3 0 0 0-6 0"/><path d="M9 17V4h10v13M9 8h10"/></svg>`,
    video: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14zM3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
    archive: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20.735A2 2 0 0 1 5 19V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2h-1"/><path d="M11 17a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2m0-12h-1m3 2h-1m-1 2h-1m3 2h-1m-1 2h-1m3 2h-1"/></svg>`,
  };
  return icons[kind] || icons.file;
}
// Also used inside attribute values (data-path="…"), so quotes are escaped too:
// textContent -> innerHTML left " and ' as they were.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function highlightMatch(text, query) {
  const t = String(text);
  if (!query) return escapeHtml(t);
  const lower = t.toLowerCase();
  const ql = query.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      out += escapeHtml(t.slice(i));
      break;
    }
    out += escapeHtml(t.slice(i, idx)) + "<mark>" + escapeHtml(t.slice(idx, idx + ql.length)) + "</mark>";
    i = idx + ql.length;
  }
  return out;
}
function needsRealIcon(item) {
  if (!item.path) return false;
  const ext = item.path.split(".").pop().toLowerCase();
  return ext === "exe" || ext === "lnk" || ext === "ico" || ext === "url";
}
// The file type comes with each result from the index (kind_from_file in indexer.rs), which is the
// one list of extensions. This is only for items that arrive without one: a file dropped on the dock.
function getExtGroup(path) {
  if (!path) return "file";
  const ext = path.split(".").pop().toLowerCase();
  const groups = {
    document: ["txt","log","md","ini","cfg","csv","rtf","odt","ods","odp","epub","pdf","doc","docx","xls","xlsx","ppt","pptx"],
    image: ["jpg","jpeg","jfif","png","gif","bmp","webp","svg","ico","tif","tiff","heic","avif"],
    audio: ["mp3","wav","flac","ogg","oga","m4a","aac","wma","opus","mid"],
    video: ["mp4","avi","mkv","mov","wmv","webm","flv","m4v","3gp","mpg","mpeg","ogv"],
    archive: ["zip","rar","7z","tar","gz","bz2","xz","zst","iso"],
    code: ["js","mjs","cjs","ts","tsx","jsx","py","rs","c","cpp","h","hpp","java","go","cs","rb","php","lua","kt","swift","dart","sh","bat","cmd","ps1","sql","html","htm","css","scss","json","xml","yaml","yml","toml","vue","svelte"],
  };
  for (const [group, exts] of Object.entries(groups)) {
    if (exts.includes(ext)) return group;
  }
  return "file";
}
const INDEX_KINDS = new Set(["document", "image", "audio", "video", "archive", "code"]);
// path -> icon data URL, or null when the backend has none for that path. Kept across
// searches so typing does not re-request icons (and flash skeletons) for rows it already had.
const iconCache = new Map();
const ICON_CACHE_MAX = 1500;
function getVisualKind(item) {
  if (item.kind === "folder") return "folder";
  if (needsRealIcon(item)) return item.kind || "file";
  return INDEX_KINDS.has(item.kind) ? item.kind : getExtGroup(item.path);
}
function createResultItem(item, index, query) {
  const div = document.createElement("div");
  div.className = "result-item" + (index === selectedIndex ? " selected" : "");
  div.dataset.index = index;
  div.dataset.path = item.path;
  div.style.animationDelay = `${Math.min(index, 8) * 25}ms`;
  const iconSrc = item.icon_data || iconCache.get(item.path) || "";
  const visualKind = getVisualKind(item);
  const needsIcon = needsRealIcon(item) && !iconSrc && !iconCache.has(item.path);
  div.innerHTML = `
    <div class="result-num">${index < 9 ? index + 1 : ""}</div>
    <div class="result-icon${needsIcon ? " icon-skeleton" : ""}">
      ${iconSrc ? `<img src="${iconSrc}" alt="">` : ""}
      <div class="result-icon-fallback ${visualKind}" style="${iconSrc ? 'display:none' : ''}">${getTypeIcon(visualKind)}</div>
    </div>
    <div class="result-name">${highlightMatch(item.name, query)}</div>
    <div class="result-path">${pathHtml(item.path)}</div>
    <button class="result-pin ${item.pinned ? "pinned" : ""}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}" data-kind="${item.kind}">${PIN_GLYPH}</button>
   `;
  div.addEventListener("click", (e) => {
    if (rowDragging) return;
    // Letting go after selecting text in a card's preview is not a click on the row.
    if (e.target.closest(".sp-text") && String(window.getSelection()).length) return;
    // The player's own controls are not a click on the row.
    if (e.target.closest(".sp-body video, .sp-body iframe")) return;
    if (e.target.closest(".result-pin")) { togglePin(e.target.closest(".result-pin")); return; }
    launchItem(item.path);
  });
  div.addEventListener("mouseenter", () => {
    const idx = parseInt(div.dataset.index);
    if (idx !== selectedIndex && idx >= 0 && idx < selectableItems.length) {
      selectedIndex = idx;
      applySelection(false);
      updateGhost();
    }
  });
  return div;
}
// Set when the window opens, so that render animates every row again.
let animateAllRows = true;
function renderResults(results, query) {
  // Rows that were already on screen keep still; only new ones play the enter animation.
  const shown = animateAllRows || resultsSection.classList.contains("hidden")
    ? new Set()
    : new Set([...resultsList.children].map(el => el.dataset.path));
  animateAllRows = false;
  resultsList.innerHTML = "";
  const hasPins = currentPins.length > 0;
  const hasSpecial = !specialSection.classList.contains("hidden");
  const showEmpty = results.length === 0 && query.trim() && !hasPins && !hasSpecial;
  emptyState.classList.toggle("hidden", !showEmpty);
  // Rows are numbered after the pin list only when that list is shown above them.
  let globalIndex = query.trim() || !pinsInList() ? 0 : currentPins.length;
  for (const item of results) {
    const el = createResultItem(item, globalIndex, query);
    if (shown.has(item.path)) el.style.animation = "none";
    resultsList.appendChild(el);
    globalIndex++;
  }
}
function renderPins(pins) {
  // As in renderResults: rows already on screen are drawn again without playing
  // their enter animation. Without this every search that ended on the empty box
  // (clearing, closing settings) replayed the whole pin list.
  const shown = animateAllRows || pinsSection.classList.contains("hidden")
    ? new Set()
    : new Set([...pinsList.children].map(el => el.dataset.path));
  pinsList.innerHTML = "";
  currentPins = pins;
  updateSelectableItems();
  pins.forEach((pin, i) => {
    const el = createResultItem({ ...pin, pinned: true }, i, lastQuery);
    if (shown.has(pin.path)) el.style.animation = "none";
    pinsList.appendChild(el);
  });
  if (typeof renderDock === "function") renderDock();

}
// True while a row is being dragged and until the click that the drop's mouseup produces has
// passed: dropping a row where it was picked up must not launch it.
let rowDragging = false;
function endRowDrag() {
  setTimeout(() => { rowDragging = false; }, 0);
}
const pinsSortable = Sortable.create(pinsList, {
        animation: animOff.includes("move") ? 0 : 250,
        easing: "cubic-bezier(0.25, 1, 0.5, 1)",
        ghostClass: "sortable-ghost",
        dragClass: "sortable-drag",
  delay: 50,
  delayOnTouchOnly: true,
  // Tauri takes over drag-and-drop on Windows (for files dropped from Explorer), so native
  // HTML5 dragging never starts in the page; drag with mouse events instead, like the dock.
  forceFallback: true,
  fallbackOnBody: true,
  fallbackClass: "pin-drag-copy",
  fallbackTolerance: 4,
  // The pin button, and the text of an opened card (which is there to be selected, not dragged).
  filter: ".result-pin, .sp-text",
  preventOnFilter: false,
  onStart: function () {
    rowDragging = true;
    document.body.classList.add("is-dragging-pin");
  },
  onEnd: function (evt) {
    endRowDrag();
    document.body.classList.remove("is-dragging-pin");
    if (lastQuery.trim() !== "") return;

    const newOrder = Array.from(pinsList.children)
      .map(el => el.querySelector(".result-pin")?.dataset.path || el.dataset.path)
      .filter(Boolean);

    const map = new Map(currentPins.map(p => [p.path, p]));
    const reordered = newOrder.map(p => map.get(p)).filter(Boolean);
    if (reordered.length === currentPins.length) {
      currentPins = reordered;
      pinsList.querySelectorAll(".result-item").forEach((el, i) => { el.dataset.index = i; });
      updateSelectableItems();
      updateSelection();
      layoutCustomScrollbar();
      invoke("reorder_pins", { orderedPaths: newOrder }).then(ok => {
        // The new order is already on screen; only a failure is worth a toast.
        if (!ok) showToast(window.i18n.t("reorderSaveFailed"), true);
      }).catch(err => { console.warn("reorder failed", err); showToast(window.i18n.t("saveError"), true); });
    } else {
      showToast(window.i18n.t("reorderFailed"), true);
    }
  }
});
function cacheIcon(path, data) {
  iconCache.delete(path);
  if (iconCache.size >= ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value);
  iconCache.set(path, data);
}
// Rows are matched by path, not by index: with pins listed above the results the
// row numbers are offset from the positions in allResults.
function applyIconToRows(path, iconSrc) {
  for (const el of document.querySelectorAll(".result-item")) {
    if (el.dataset.path !== path) continue;
    const iconDiv = el.querySelector(".result-icon");
    if (!iconDiv) continue;
    iconDiv.classList.remove("icon-skeleton");
    if (!iconSrc || iconDiv.querySelector("img")) continue;
    const img = document.createElement("img");
    img.src = iconSrc;
    img.alt = "";
    iconDiv.appendChild(img);
    const fallback = iconDiv.querySelector(".result-icon-fallback");
    if (fallback) fallback.style.display = "none";
  }
}
function requestIconsForResults(results) {
  const pathsNeedingIcons = [...new Set(results
    .filter(r => !r.icon_data && needsRealIcon(r) && !iconCache.has(r.path))
    .map(r => r.path))];
  if (pathsNeedingIcons.length === 0) return;
  invoke("get_icons", { paths: pathsNeedingIcons })
    .then(iconMap => {
      for (const path of pathsNeedingIcons) {
        const iconData = iconMap[path] || null;
        cacheIcon(path, iconData);
        applyIconToRows(path, iconData);
        if (!iconData) continue;
        for (const r of allResults) if (r.path === path) r.icon_data = iconData;
        for (const p of currentPins) if (p.path === path) p.icon_data = iconData;
      }
    })
    .catch(err => console.error("Icon load failed:", err));
}
// The order the rows are laid out in, which is also the order the keyboard
// walks them: the pinned ones first when the box is empty, then the results.
function selectableContainers() {
  const containers = [];
  if (lastQuery.trim() || !pinsInList()) {
    containers.push(resultsList);
  } else {
    if (currentPins.length > 0) containers.push(pinsList);
    containers.push(resultsList);
  }
  return containers;
}
// Pinning or unpinning changes how many rows come before the results, so every
// row's index has to be laid out again. Without this the rows kept the indices
// they were built with and the pointer picked the wrong file.
function renumberRows() {
  let i = 0;
  for (const container of selectableContainers()) {
    container.querySelectorAll(".result-item").forEach((el) => {
      el.dataset.index = i;
      i++;
    });
  }
}
function applySelection(doScroll) {
  const containers = selectableContainers();
  let flatIndex = 0;
  for (const container of containers) {
    const items = container.querySelectorAll(".result-item");
    items.forEach((el) => {
      el.classList.toggle("selected", flatIndex === selectedIndex);
      if (doScroll && flatIndex === selectedIndex) {

        wheelTarget = null;
        if (wheelRaf) { cancelAnimationFrame(wheelRaf); wheelRaf = null; }

        const before = resultsContainer.scrollTop;
        el.scrollIntoView({ block: "nearest", behavior: "instant" });
        // Only an actual scroll should flash the scrollbar, not every new search.
        if (resultsContainer.scrollTop !== before) syncScrollFade();
      }
      flatIndex++;
    });
  }
}
// Hovering a row only borrows the highlight: moving off the rows (onto the search box, or
// out of the window) hands it back to the row the keyboard or the search had picked (none
// in the empty box, the first result while searching). null while nothing is borrowed.
let selectionBeforeHover = null;
function updateSelection() {
  selectionBeforeHover = null;
  applySelection(true);
}
function endHoverSelection() {
  if (selectionBeforeHover === null || document.body.classList.contains("is-dragging-pin")) return;
  selectedIndex = selectionBeforeHover;
  selectionBeforeHover = null;
  applySelection(false);
  updateGhost();
}
// Capture phase: runs before a row's own mouseenter moves the highlight onto it.
document.addEventListener("mouseover", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (el && el.closest(".result-item")) {
    if (selectionBeforeHover === null) selectionBeforeHover = selectedIndex;
    return;
  }
  if (el && el.closest("#pins-list, #results-list, #context-menu")) return;
  endHoverSelection();
}, true);
document.documentElement.addEventListener("mouseleave", endHoverSelection);
// Typing picks a new selection of its own.
searchInput.addEventListener("input", () => { selectionBeforeHover = null; });
function clearGhost() {
  ghostTyped.textContent = "";
  ghostRest.textContent = "";
}
function updateGhost() {
  const value = searchInput.value;
  // With a drive scope ("D:\ chr") the name is completed from the part after it.
  const scoped = parseDriveScope(value);
  const typed = scoped ? scoped.query : value;
  const top = selectableItems[0];
  const name = top && top.name ? top.name : "";
  if (
    typed &&
    name.length > typed.length &&
    name.slice(0, typed.length).toLowerCase() === typed.toLowerCase()
  ) {
    ghostTyped.textContent = value;
    ghostRest.textContent = name.slice(typed.length);
  } else {
    clearGhost();
  }
}
// Alt+Up / Alt+Down step through earlier queries: the ones that led to opening or
// copying something, newest first. Kept in this webview's localStorage, like the
// colour history.
const QUERY_HISTORY_KEY = "umbra.queryHistory";
const QUERY_HISTORY_MAX = 50;
let queryHistoryPos = -1; // -1: what the user was typing before stepping back
let queryHistoryDraft = "";
function readQueryHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(QUERY_HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list.filter((q) => typeof q === "string" && q) : [];
  } catch {
    return [];
  }
}
function rememberQuery() {
  const q = searchInput.value.trim();
  queryHistoryPos = -1;
  if (!q) return;
  try {
    const list = [q, ...readQueryHistory().filter((x) => x !== q)].slice(0, QUERY_HISTORY_MAX);
    localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(list));
  } catch {}
}
// dir 1 = older, -1 = newer.
function stepQueryHistory(dir) {
  const list = readQueryHistory();
  if (!list.length) return;
  if (queryHistoryPos === -1) queryHistoryDraft = searchInput.value;
  const next = Math.max(-1, Math.min(list.length - 1, queryHistoryPos + dir));
  if (next === queryHistoryPos) return;
  queryHistoryPos = next;
  searchInput.value = next === -1 ? queryHistoryDraft : list[next];
  clearBtn.classList.toggle("visible", !!searchInput.value);
  clearGhost();
  performSearch(searchInput.value);
  searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
}
// Typing leaves history browsing.
searchInput.addEventListener("input", () => { queryHistoryPos = -1; });
async function launchItem(path) {
  // Typed this, opened that: next time it comes first for this query (picks.rs).
  const typed = searchedText();
  if (typed) invoke("record_pick", { query: typed, path }).catch(() => {});
  rememberQuery();
  hideWindow(); 
  try {
    await invoke("launch_item", { path });
  } catch (e) {
    console.error("Launch error:", e);

    showToast(window.i18n.t("launchFailed"), true, String(e).replace("Error:", "").trim());
  }
}
async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    showToast(window.i18n.t("copied"));
  } catch (e) {
    console.error("Clipboard copy failed:", e);
    showToast(window.i18n.t("copyFailed"), true);
  }
}
const ntfShort = document.getElementById("ntf-short");
const ntfDetail = document.getElementById("ntf-detail");
let ntfTimer = null;
let ntfHover = false;
let ntfShownAt = 0;
// hint can tell whether it is still the current one.
function collapseNotify() {
  dragBar.classList.remove("expanded");
}
function hideNotify() {
  if (ntfHover && Date.now() - ntfShownAt <= 8000) {

    ntfTimer = setTimeout(hideNotify, 700);
    return;
  }
  clearTimeout(ntfTimer);
  // Taking `shown` away starts the fade out; the state is cleared straight
  // after so the next hint does not arrive on top of a half-faded one.
  collapseNotify();
  dragBar.classList.remove("shown", "notify", "tip", "success", "error", "warn", "info");
  ntfOnScreen = null;
  syncDragTip();
  ntfCurrent = null;
  ntfTag = null;

  if (ntfPending) {
    const p = ntfPending;
    ntfPending = null;
    if (Date.now() - p.at <= 5000) renderNotify(p.short, p.opts, p.type);
  }
}
function expandNotify() {
  dragBar.classList.add("expanded");
}
const NTF_PRIO = { error: 3, warn: 2, success: 1, info: 0 };
let ntfCurrent = null;
let ntfPending = null;
let ntfTag = null;
function showNotify(short, opts = {}) {
  const type = opts.type || "info";
  if (opts.tag && opts.tag === ntfTag && dragBar.classList.contains("shown")) {
    renderNotify(short, opts, type);
    return;
  }
  if (dragBar.classList.contains("shown")) {

    if (ntfPending && Date.now() - ntfPending.at > 5000) ntfPending = null;
    const cur = ntfCurrent == null ? 0 : (NTF_PRIO[ntfCurrent] ?? 0);

    if ((NTF_PRIO[type] ?? 0) >= cur) renderNotify(short, opts, type);
    else {

      const prio = NTF_PRIO[type] ?? 0;
      const pend = ntfPending ? (NTF_PRIO[ntfPending.type] ?? 0) : -1;
      if (prio >= pend) ntfPending = { short, opts, type, at: Date.now() };
    }
    return;
  }
  renderNotify(short, opts, type);
}
// The hint fades itself with a CSS transition. It used to be hidden with
// `visibility: hidden`, and an element in that state counts as not rendered --
// Chromium refuses to start a transition on one, so the hint appeared with no
// animation at all. It is hidden by opacity now, and the motion is plain CSS.
//
// The only thing JS has to do is make sure the browser has computed the hidden
// state before the shown one is applied. Both classes go on in the same turn of
// the event loop, so without a forced layout there would be one style pass and
// nothing to interpolate from.
let ntfOnScreen = null;

function ntfCancel(el) {
  if (!el) return;
  el.style.opacity = "";
  el.style.filter = "";
  el.style.transform = "";
}

// The hint has a hard width limit and a full path or a .NET exception message
// runs straight past it. Trim from the front, because the tail is the part that
// identifies a path or names the failure.
const NTF_DETAIL_MAX = 44;
function ntfTrim(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= NTF_DETAIL_MAX) return s;
  return "…" + s.slice(-(NTF_DETAIL_MAX - 1));
}
function renderNotify(short, { detail = "", duration = 0, tag = null } = {}, type = "info") {
  ntfCurrent = type;
  ntfTag = tag;
  const wasExp = ntfHover && dragBar.classList.contains("expanded");
  clearTimeout(ntfTimer);
  tipTarget = null;
  dragBar.classList.remove("expanded", "shown", "notify", "tip", "success", "error", "warn", "info");
  dragBar.classList.add("notify", type);
  dragBar.removeAttribute("data-tip");
  ntfShort.textContent = ntfTrim(short);
  ntfDetail.textContent = ntfTrim(detail || short);
  // The classes decide which line is on screen and that it is shown at all.
  // `expanded` first, because that is what says which of the two lines it is.
  if (wasExp) dragBar.classList.add("expanded");
  // The hidden state has to be computed before the shown one is applied, or
  // there is nothing for the transition to start from. Reading a box property
  // forces that style pass to happen right here.
  void ntfShort.offsetWidth;
  dragBar.classList.add("shown");
  ntfOnScreen = dragBar.classList.contains("expanded") ? ntfDetail : ntfShort;
  ntfHover = dragBar.matches(":hover");
  ntfShownAt = Date.now();
  const dur = duration || (type === "success" ? 1900 : 3400);
  ntfTimer = setTimeout(hideNotify, dur);
  // Clip only when the text really is longer than the hint allows. Doing it in
  // CSS alone means every hint pays for an ellipsis it does not need, and with
  // `overflow: hidden` the glow around the text is chopped off at the box.
  ntfShort.classList.remove("ntf-clip");
  ntfDetail.classList.remove("ntf-clip");
  if (ntfShort.scrollWidth > ntfShort.clientWidth + 1) ntfShort.classList.add("ntf-clip");
  if (ntfDetail.scrollWidth > ntfDetail.clientWidth + 1) ntfDetail.classList.add("ntf-clip");
}
dragBar.addEventListener("mouseenter", () => {
  ntfHover = true;
});
dragBar.addEventListener("mousemove", (e) => {
  if (!dragBar.classList.contains("shown")) return;
  const el = dragBar.classList.contains("expanded") ? ntfDetail : ntfShort;
  const r = el.getBoundingClientRect();
  const over = e.clientX >= r.left && e.clientX <= r.right &&
               e.clientY >= r.top && e.clientY <= r.bottom;
  const wasExpanded = dragBar.classList.contains("expanded");
  dragBar.classList.toggle("expanded", over);
  // Expanding swaps which of the two lines is on screen, so the other one has
  // to be brought in with its own little motion.
  if (wasExpanded !== over) {
    ntfOnScreen = over ? ntfDetail : ntfShort;
    void ntfShort.offsetWidth;
  }
});
dragBar.addEventListener("mouseleave", () => {
  ntfHover = false;
  collapseNotify();
});
function syncDragTip() {
  if (dragBar.classList.contains("notify")) return;
  dragBar.dataset.tip = dragBar.classList.contains("pinned") ? window.i18n.t("dragTipPinned") : window.i18n.t("dragTip");
}
let pinBusy = false;
dragBar.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (pinBusy) return;
  pinBusy = true;

  setTimeout(() => { pinBusy = false; }, 3000);
  const pinned = !dragBar.classList.contains("pinned");
  invoke("set_window_pin", { pinned })
          .then((ok) => {
      dragBar.classList.toggle("pinned", !!ok);
      if (ok) {
        showNotify(window.i18n.t("posPinned"), {
          type: "warn",
          tag: "pin",
          detail: window.i18n.t("posPinnedDetail"),
        });
      } else {
        showNotify(window.i18n.t("posUnpinned"), { type: "info", tag: "pin", detail: window.i18n.t("posUnpinnedDetail") });
      }
    })
    .catch((err) => showNotify(window.i18n.t("pinFailed"), { type: "error", detail: String(err) }))
    // The flag is released by the timer above, not by the promise: releasing it
    // as soon as the call came back left nothing between two quick right
    // clicks, and the window flipped pinned and unpinned in a row.
});
function showToast(message, isError, detail) {
  showNotify(message, {
    type: isError ? "error" : "success",
    detail,
  });
}
function uiZoom() {
  const inline = parseFloat(document.documentElement.style.zoom);
  if (inline && !isNaN(inline) && inline > 0) return inline;
  const bodyInline = parseFloat(document.body.style.zoom);
  if (bodyInline && !isNaN(bodyInline) && bodyInline > 0) return bodyInline;
  try {
    const cs = parseFloat(getComputedStyle(document.documentElement).zoom);
    if (cs && !isNaN(cs) && cs > 0) return cs;
  } catch {}
  const r = document.body.getBoundingClientRect();
  return r.width > 0 ? r.width / window.innerWidth : 1;
}
let tipTarget = null;
function showBarTip(target) {
  if (!(target instanceof Element)) return;
  const text = target.dataset.tip;
  if (!text) return;

  if (dragBar.classList.contains("shown")) return;
  tipTarget = target;
  ntfShort.textContent = text;
  ntfDetail.textContent = text;
  dragBar.classList.remove("success", "error", "warn", "info");
  dragBar.classList.add("notify", "tip");
  dragBar.removeAttribute("data-tip");
  dragBar.classList.add("shown");
}
function hideBarTip(target) {
  if (!tipTarget) return;
  if (target && tipTarget !== target) return;
  tipTarget = null;

  if (!dragBar.classList.contains("tip")) return;
  dragBar.classList.remove("shown", "notify", "tip");
  syncDragTip();
}
document.addEventListener("mouseover", (e) => {
  const t = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
  if (t !== tipTarget) {
    hideBarTip();
    if (t) showBarTip(t);
  }
});
document.addEventListener("mouseout", (e) => {
  const t = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
  const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest("[data-tip]") : null;
  if (t && t !== to) {
    hideBarTip(t);
  }
});
document.addEventListener("pointerdown", () => {
  hideBarTip();
}, true);
document.addEventListener("wheel", () => {
  hideBarTip();
}, { passive: true });
// The bounce for a pin that was just pinned. Taken off again when it ends, so
// the next time the row is drawn it is still.
function popPin(btn) {
  btn.classList.remove("pin-pop");
  void btn.offsetWidth;
  btn.classList.add("pin-pop");
  btn.addEventListener("animationend", () => btn.classList.remove("pin-pop"), { once: true });
}
function setPinnedButtons(path, pinned) {
  document
    .querySelectorAll('#results-list .result-pin[data-path="' + CSS.escape(path) + '"]')
    .forEach(b => {
      b.classList.toggle("pinned", pinned);
      if (pinned) popPin(b);
    });
}
// A row leaving the list shrinks to nothing, closing the gap behind it, instead of vanishing.
function collapseRow(card) {
  const root = document.documentElement;
  if (root.dataset.animMove === "off" || root.dataset.animSize === "off") return Promise.resolve();
  card.style.height = card.offsetHeight + "px";
  card.style.animation = "none";
  card.style.pointerEvents = "none";
  void card.offsetHeight;
  card.classList.add("row-collapsing");
  card.style.height = "0px";
  card.style.marginBottom = "calc(var(--gap) * -1)";
  return new Promise((resolve) => setTimeout(resolve, 300));
}
async function togglePin(btn) {
  const { path, name, kind } = btn.dataset;
  const isPinned = btn.classList.contains("pinned");
  try {
    if (isPinned) {
      await invoke("remove_pin", { path });
      currentPins = currentPins.filter(pr => pr.path !== path);
      const modelIdx = allResults.findIndex(r => r.path === path);
      if (modelIdx !== -1) allResults[modelIdx].pinned = false;

      const card = btn.closest(".result-item");
      setPinnedButtons(path, false);
      if (card && pinsList.contains(card)) {
        await collapseRow(card);
        card.remove();
      }
    } else {
      await invoke("add_pin", { name, path, kind });
      const pin = { name, path, kind, pinned: true };
      const idx = currentPins.length;
      currentPins.push(pin);
      const modelIdx = allResults.findIndex(r => r.path === path);
      if (modelIdx !== -1) allResults[modelIdx].pinned = true;

      const row = createResultItem({ ...pin }, idx, lastQuery);
      pinsList.appendChild(row);
      popPin(row.querySelector(".result-pin"));
      setPinnedButtons(path, true);
    }
    updateSelectableItems();
    renumberRows();
    updateGhost();
    pinsSection.classList.toggle("hidden", currentPins.length === 0 || !!lastQuery.trim());
    updateSelection();
    layoutCustomScrollbar();
    if (typeof renderDock === "function") renderDock();
  } catch (e) {
    showToast(window.i18n.t("pinFailed"), true, String(e).replace("Error:", "").trim());
  }
}
// The hints come from the language file as one "|"-separated string, and are shown in a random
// order: a different one each time, never the same one twice running.
function placeholderList() {
  const list = window.i18n.t("placeholderWords").split("|").filter(Boolean);
  return list.length ? list : ["type to search"];
}
let placeholderIndex = 0;
function nextPlaceholder(count) {
  if (count < 2) return 0;
  let next;
  do { next = Math.floor(Math.random() * count); } while (next === placeholderIndex);
  return next;
}
let placeholderCharIndex = 0;
let placeholderDeleting = false;
let placeholderTimer = null;
// There is at most one typing loop: every step and every (re)start goes through
// here, and each replaces whatever is pending instead of running beside it.
// A start that kept no handle (the one at load did) left a second loop going
// that nothing could clear.
function schedulePlaceholder(fn, ms) {
  clearTimeout(placeholderTimer);
  placeholderTimer = setTimeout(fn, ms);
}
function animatePlaceholder() {
  if (searchInput.value.length > 0 || appContainer.classList.contains("window-hidden")) {
    searchInput.placeholder = "";
    return;
  }
  const words = placeholderList();
  if (placeholderIndex >= words.length) placeholderIndex = 0;
  const currentWord = words[placeholderIndex];
  if (!placeholderDeleting) {
    searchInput.placeholder = currentWord.substring(0, placeholderCharIndex + 1);
    placeholderCharIndex++;
    if (placeholderCharIndex >= currentWord.length) {
      schedulePlaceholder(() => {
        placeholderDeleting = true;
        animatePlaceholder();
      }, 1500);
      return;
    }
    schedulePlaceholder(animatePlaceholder, 80);
  } else {
    searchInput.placeholder = currentWord.substring(0, placeholderCharIndex);
    placeholderCharIndex--;
    if (placeholderCharIndex < 0) {
      placeholderDeleting = false;
      placeholderCharIndex = 0;
      placeholderIndex = nextPlaceholder(words.length);
      schedulePlaceholder(animatePlaceholder, 400);
      return;
    }
    schedulePlaceholder(animatePlaceholder, 50);
  }
}
document.addEventListener("mousemove", (e) => {
  if (document.body.classList.contains("is-dragging-pin")) return;
  const item = e.target.closest(".result-item");
  if (item && !item.classList.contains("selected")) {
    if (selectionBeforeHover === null) selectionBeforeHover = selectedIndex;
    selectedIndex = parseInt(item.dataset.index, 10);
    applySelection(false);
  }
});
document.addEventListener("contextmenu", (e) => {
  const resultItem = e.target.closest(".result-item");
  if (!resultItem) {
    contextMenu.classList.remove("visible");
    return;
  }
  e.preventDefault();
  const index = parseInt(resultItem.dataset.index);
  const target = index >= 0 && index < selectableItems.length ? selectableItems[index] : null;
  openContextMenu(e, target);
});
// Shows the Open / Open as admin / Open directory / Copy path menu for `target`
// at the pointer; also used by the pinned-apps dock (dock.js).
function openContextMenu(e, target) {
  contextTargetItem = target && target.path ? target : null;
  const pinLabel = contextMenu.querySelector('[data-action="pin"] .ctx-item-label');
  pinLabel.dataset.i18n = contextTargetItem && isPinned(contextTargetItem.path) ? "ctxUnpin" : "ctxPin";
  pinLabel.textContent = t(pinLabel.dataset.i18n);
  const z = uiZoom();
  const menuW = contextMenu.offsetWidth;
  const menuH = contextMenu.offsetHeight;
  const vw = window.innerWidth * z;
  const vh = window.innerHeight * z;
  let x = e.clientX;
  let y = e.clientY;
  if (x + menuW > vw) x = vw - menuW - 8;
  if (y + menuH > vh) y = vh - menuH - 8;
  contextMenu.style.left = x / z + "px";
  contextMenu.style.top = y / z + "px";
  contextMenu.classList.add("visible");
}
document.addEventListener("click", (e) => {
  if (!contextMenu.classList.contains("visible")) return;
  if (contextMenu.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  contextMenu.classList.remove("visible");
}, true);
contextMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || !contextTargetItem) return;
  const action = item.dataset.action;
  const path = contextTargetItem.path;
  switch (action) {
    case "open":
      launchItem(path);
      break;
    case "admin":
      invoke("launch_admin", { path })
        .then(() => hideWindow())
        .catch(err => {
          console.warn("launch admin failed:", err);
          showToast(window.i18n.t("adminLaunchFailed"), true, String(err).replace("Error:", "").trim());
        });
      break;
    case "directory":
      // Explorer opens on the containing folder with this item selected.
      invoke("reveal_in_explorer", { path }).catch(err => console.warn("reveal failed:", err));
      hideWindow();
      break;
    case "copy":
      copyPath(path);
      break;
    case "pin":
      setItemPinned(contextTargetItem, !isPinned(path));
      break;
  }
  contextMenu.classList.remove("visible");
});
function isPinned(path) {
  return currentPins.some((p) => p.path === path);
}
// Pin or unpin from the context menu. A row's pin button on screen goes through
// togglePin so the list updates in place; otherwise (e.g. a dock tile that isn't in
// the current results) pin directly and refresh.
async function setItemPinned(item, pin) {
  const sel = '.result-pin[data-path="' + CSS.escape(item.path) + '"]';
  const btn = resultsList.querySelector(sel) || pinsList.querySelector(sel);
  if (btn) {
    if (btn.classList.contains("pinned") !== pin) await togglePin(btn);
    return;
  }
  try {
    if (pin) await invoke("add_pin", { name: item.name, path: item.path, kind: item.kind || "file" });
    else await invoke("remove_pin", { path: item.path });
  } catch (e) {
    showToast(window.i18n.t("pinFailed"), true, String(e).replace("Error:", "").trim());
    return;
  }
  performSearch(lastQuery);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && contextMenu.classList.contains("visible")) {
    contextMenu.classList.remove("visible");
  }
});
const indexSpinner = document.getElementById("index-spinner");
let indexingActive = false;
let indexRan = false;
let idxPct = 0;
function syncIndexTip(active) {
  indexSpinner.dataset.tip = active ? t("indexingPct", { pct: idxPct }) : t("indexReady");
}
listen("index-progress", (event) => {
  const p = event.payload;
  const done = typeof p === "number"
    ? p >= 100
    : !!(p && typeof p === "object" && (p.done === true || Number(p.pct ?? 0) >= 100));
  if (typeof p === "number") {
    idxPct = Math.max(0, Math.min(99, Math.round(p)));
  } else if (p && typeof p === "object") {
    idxPct = Math.max(0, Math.min(99, Math.round(Number(p.pct ?? 0))));
  }
  if (done) {
    const hadRun = indexRan;
    indexRan = false;
    indexingActive = false;
    indexSpinner.classList.remove("visible");
    syncIndexTip(false);

    if (hadRun) showNotify(window.i18n.t("indexReady"), { type: "success" });
  } else {
    indexingActive = true;
    indexRan = true;
    indexSpinner.classList.add("visible");
    indexSpinner.classList.toggle("suppressed", updateState.phase === "downloading");
    syncIndexTip(true);
  }
});
clearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  searchInput.value = "";
  clearBtn.classList.remove("visible");
  clearGhost();
  performSearch("");
  placeholderDeleting = false;
  placeholderCharIndex = 0;
  schedulePlaceholder(animatePlaceholder, 500);
  searchInput.focus();
});
function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
// "D:\ report" or "d: report" searches for "report" on that drive only. The space is what tells it
// from a path: "D:\Games" (no space) still offers to open the folder.
function parseDriveScope(query) {
  const m = /^\s*([a-z]):\\?\s+(\S.*)$/i.exec(query);
  return m ? { drive: m[1].toUpperCase() + ":", query: m[2] } : null;
}
// What is actually being searched for: the box's text without a drive scope in front of it.
function searchedText() {
  const scoped = parseDriveScope(searchInput.value);
  return scoped ? scoped.query.trim() : searchInput.value.trim();
}
async function performSearch(query) {
  lastQuery = query;
  if (query.trim()) pendingWelcome = null;
  const scoped = parseDriveScope(query);
  if (!scoped && handleSpecialCommand(query)) {
    // Drop any search still in flight (it would render its results under the
    // card) and clear what the last search left on screen.
    currentSearchId++;
    hint.classList.add("hidden");
    emptyState.classList.add("hidden");
    return;
  }
  specialSection.classList.add("hidden");

  settingsSection.classList.add("hidden");
  settingsBtn.classList.remove("open");
  closeContentMenu();
  currentSearchId++;
  const myId = currentSearchId;
  // The previous rows stay up until the new ones arrive; hiding them here made the
  // list blink on every keystroke.
  try {
    const response = await invoke("search_all", scoped ? { query: scoped.query, scope: scoped.drive } : { query });
    if (myId !== currentSearchId) return;
    if (!query.trim() && !pinsInList()) {
      // The pins live in the side dock, so the empty box lists recently opened items.
      response.results = await invoke("get_recent_items", { limit: 8 }).catch(() => []);
      if (myId !== currentSearchId) return;
    }
    allResults = response.results;
    renderPins(response.pins);
    updateSelectableItems();
    renderResults(allResults, scoped ? scoped.query : query);
    // A new search starts at the top (this used to happen as a side effect of hiding the list).
    resultsContainer.scrollTop = 0;
    // The first screenful's icons first: they are asked for together, so a long list must not hold them up.
    requestIconsForResults([...allResults.slice(0, 30), ...response.pins]);
    if (allResults.length > 30) requestIconsForResults(allResults.slice(30));
    const hasPins = response.pins.length > 0;
    const hasResults = response.results.length > 0;
    const isEmpty = !query.trim();
    if (!isEmpty && selectableItems.length > 0) {
      selectedIndex = 0;
    } else {
      selectedIndex = -1;
    }
    const indexingNow = indexingActive && response.indexed === 0;
    if (!isEmpty && !hasResults) {
      emptyState.querySelector("span").textContent = indexingNow
        ? window.i18n.t("indexingEmpty")
        : scoped
          ? window.i18n.t("noResultsOn", { drive: scoped.drive })
          : window.i18n.t("noResults");
    }

    hint.classList.toggle("hidden", !(isEmpty && !(hasPins && pinsInList())));
    updateSelection();
    updateGhost();
    pinsSection.classList.toggle("hidden", !hasPins || !isEmpty);
    resultsSection.classList.toggle("hidden", !hasResults);
    if (isEmpty && hasPins && pinsInList()) resultsSection.classList.add("hidden");
  } catch (err) {
    console.error("Search error:", err);
  }
}
// Runs a row as administrator, or shows it in Explorer. The keys for both are in Keybinds; a
// click with Ctrl (Ctrl+Shift for admin) does the same.
function activateItemAs(item, how) {
  if (how === "admin") {
    hideWindow();
    invoke("launch_admin", { path: item.path })
      .catch(() => console.error("Admin launch failed"));
  } else {
    invoke("reveal_in_explorer", { path: item.path }).catch((err) => console.warn("reveal failed:", err));
    hideWindow();
  }
}
// What Enter does on a row: launch it. Help rows fill the box and copy rows copy instead.
function activateItem(item, mods = {}) {
  if (item.kind !== "help") rememberQuery();
  if (item.kind === "help") {
    if (item.fill) {
      searchInput.value = item.fill;
      clearBtn.classList.add("visible");
      clearGhost();
      updateGhost();
      searchInput.focus();
    }
    return;
  }
  if (item.kind === "copy") {
    if (item.path) copyPath(item.path);
    return;
  }
  if (item.kind === "font") {
    item.run();
    return;
  }
  // The keyboard routes (Keybinds) are caught before Enter gets here; this is the mouse.
  if (mods.type === "click" && mods.ctrlKey && mods.shiftKey) {
    activateItemAs(item, "admin");
  } else if (mods.type === "click" && mods.ctrlKey && !/^https?:/i.test(item.path)) {
    activateItemAs(item, "reveal");
  } else {
    launchItem(item.path);
  }
}
// Rows on screen in the order Ctrl+1..9 counts them (data-index is the position in
// selectableItems; rows of a hidden section are skipped).
function shortcutRows() {
  return [...document.querySelectorAll("#pins-list .result-item, #results-list .result-item")]
    .filter((el) => el.offsetParent !== null && Number(el.dataset.index) < 9);
}
// Holding Ctrl for a moment slides each row's icon and name over and shows its
// number in the gap. The mark stays on the rows when Ctrl is let go, so the
// number can fade back out instead of vanishing with it.
let shortcutHintTimer = null;
function showRowShortcuts(on) {
  clearTimeout(shortcutHintTimer);
  if (on) {
    document.querySelectorAll(".result-item[data-shortcut]").forEach((el) => delete el.dataset.shortcut);
    shortcutRows().forEach((el) => { el.dataset.shortcut = Number(el.dataset.index) + 1; });
  }
  document.body.classList.toggle("show-shortcuts", on);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Control") {
    if (!e.repeat) shortcutHintTimer = setTimeout(() => showRowShortcuts(true), 250);
  } else if (!/^Digit[1-9]$/.test(e.code)) {
    // Ctrl+C, Ctrl+V, ... are not about rows; don't flash the numbers for them.
    showRowShortcuts(false);
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Control") showRowShortcuts(false);
});
window.addEventListener("blur", () => showRowShortcuts(false));
searchInput.addEventListener("keydown", (e) => {
  // Holding the expand keys is sidepreview.js's: it listens on the document in the capture phase,
  // which runs before this handler and stops the event when it claims it.
  if (kbMatches(e, "historyPrev") || kbMatches(e, "historyNext")) {
    e.preventDefault();
    stepQueryHistory(kbMatches(e, "historyPrev") ? 1 : -1);
    return;
  }
  // Ctrl+1..9 runs row N.
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && settingsSection.classList.contains("hidden")) {
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      const n = Number(digit[1]) - 1;
      const onScreen = shortcutRows().some((el) => Number(el.dataset.index) === n);
      showRowShortcuts(false);
      if (onScreen && selectableItems[n]) activateItem(selectableItems[n]);
      return;
    }
  }
  // Keeps WebView2's print dialog away even if Ctrl+P is no longer the pin key.
  if (e.ctrlKey && !e.altKey && e.code === "KeyP") e.preventDefault();
  if (settingsSection.classList.contains("hidden")) {
    const item = selectableItems[selectedIndex];
    const real = item && item.path && !["help", "copy", "open", "font"].includes(item.kind);
    if (kbMatches(e, "pin")) {
      e.preventDefault();
      if (real) setItemPinned(item, !isPinned(item.path));
      return;
    }
    const how = kbMatches(e, "admin") ? "admin" : kbMatches(e, "reveal") ? "reveal" : "";
    // A link has no folder to show, so it just opens.
    if (how && real && !(how === "reveal" && /^https?:/i.test(item.path))) {
      e.preventDefault();
      rememberQuery();
      activateItemAs(item, how);
      return;
    }
  }
  if (e.key === "Tab" && ghostRest.textContent) {
    e.preventDefault();
    searchInput.value = ghostTyped.textContent + ghostRest.textContent;
    clearBtn.classList.add("visible");
    clearGhost();
    updateGhost();
    performSearch(searchInput.value);
    return;
  }
  const containers = [];
  if (lastQuery.trim()) {
    containers.push(resultsList);
  } else {
    if (currentPins.length > 0) containers.push(pinsList);
    containers.push(resultsList);
  }
  let total = 0;
  for (const c of containers) {
    total += c.querySelectorAll(".result-item").length;
  }
  // Cards (calculator, an open-link card) have no rows but still act on Enter.
  if (total === 0 && e.key === "Enter" && selectedIndex >= 0 && selectableItems[selectedIndex]) {
    e.preventDefault();
    activateItem(selectableItems[selectedIndex], e);
    return;
  }
  if (total === 0) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (settingsBtn.classList.contains("open")) {
        toggleSettings();
      } else if (!clearQueryOnEscape()) {
        hideWindow();
      }
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, total - 1);
    updateSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, -1);
    updateSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedIndex >= 0 && selectedIndex < selectableItems.length) {
      activateItem(selectableItems[selectedIndex], e);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();

    if (!settingsSection.classList.contains("hidden")) {
  settingsSection.classList.add("hidden");
  settingsBtn.classList.remove("open");
  closeContentMenu();
  // The animation menu kept its open state when the settings closed, so the
  // next time it opened it was already showing a stale list and the first
  // click closed it instead of opening it.
  closeAnimMenu();
      performSearch(searchInput.value);
      searchInput.focus();
      return;
    }
    if (!clearQueryOnEscape()) hideWindow();
  }
});
// The first Esc clears a typed query (like the clear button); the next one hides
// the window. Returns true when it cleared something.
function clearQueryOnEscape() {
  if (!searchInput.value) return false;
  clearBtn.click();
  return true;
}
let pointerGuard = false;
function centerWindowAnimated() {
  invoke("recenter_window").catch((err) => console.warn("recenter failed:", err));
}
const DOUBLE_CLICK_MS = 350;
const DRAG_THRESHOLD_PX = 5;
let lastDragPress = 0;
let dragPressOrigin = null;
let nativeDragActive = false;
let downPos = null;
let justRecentered = 0;
dragBar.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || nativeDragActive) return;
  downPos = { x: e.clientX, y: e.clientY };
  const now = Date.now();
  if (now - lastDragPress < DOUBLE_CLICK_MS) {

    e.preventDefault();
    e.stopImmediatePropagation();
    lastDragPress = 0;
    dragPressOrigin = null;
    justRecentered = Date.now();
    collapseNotify(); 
    centerWindowAnimated();
    return;
  }
  lastDragPress = now;
  dragPressOrigin = { x: e.clientX, y: e.clientY };
});
window.addEventListener("mouseup", (e) => {
  if (!downPos) return;
  const dx = e.clientX - downPos.x;
  const dy = e.clientY - downPos.y;
  downPos = null;
  if (e.button !== 0) return;

  if (!(e.target instanceof Element) || !dragBar.contains(e.target)) return;
  if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
  if (nativeDragActive) return;
  if (Date.now() - justRecentered < 450) return; 
  if (!dragBar.classList.contains("shown")) return;

  expandNotify();
});
window.addEventListener("mousemove", (e) => {
  if (!dragPressOrigin || nativeDragActive) return;
  if (e.buttons === 0) { dragPressOrigin = null; return; }
  const dx = e.clientX - dragPressOrigin.x;
  const dy = e.clientY - dragPressOrigin.y;
  if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
  dragPressOrigin = null;
  nativeDragActive = true;
  appContainer.classList.add("dragging");
  getCurrentWindow().startDragging().then(() => {
    appContainer.classList.remove("dragging");
  }).catch(() => {
    appContainer.classList.remove("dragging");
  }).finally(() => {
    setTimeout(() => { nativeDragActive = false; }, 120);
  });
});
const MAIN_MIN_W = 480, MAIN_MAX_W = 920, MAIN_MIN_H = 400, MAIN_MAX_H = 900;
let mainLogicalW = 660, mainLogicalH = 560;
let resizeState = null;
let resizeRaf = null;
let pendingSize = null;
function setMainSize(w, h) {
  // The pinned-apps dock (dock.js) widens the window on its side; w/h stay the panel's size.
  const dockW = typeof dockExtraWidth === "function" ? dockExtraWidth() : 0;
  const panelW = typeof tpExtraWidth === "function" ? tpExtraWidth() : 0;
  const cw = Math.max(MAIN_MIN_W, Math.min(MAIN_MAX_W - (dockW - panelW), Math.round(w)));
  const ch = Math.max(MAIN_MIN_H, Math.min(MAIN_MAX_H, Math.round(h)));
  if (cw === mainLogicalW && ch === mainLogicalH) return;
  mainLogicalW = cw;
  mainLogicalH = ch;
  pendingSize = { width: cw + dockW, height: ch };
  if (!resizeRaf) resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    if (pendingSize) invoke("resize_main_window", pendingSize).catch(() => {});
  });
}
if (sizePill) {
  sizePill.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hideBarTip();
    resizeState = { x: e.clientX, y: e.clientY, w: mainLogicalW, h: mainLogicalH };
    sizePill.classList.add("active");
    const move = (ev) => {
      if (!resizeState) return;
      const z = uiZoom();
      const dx = (ev.clientX - resizeState.x) / z;
      const dy = (ev.clientY - resizeState.y) / z;
      setMainSize(resizeState.w + dx, resizeState.h + dy);
    };
    const up = () => {
      resizeState = null;
      sizePill.classList.remove("active");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}
document.addEventListener("pointerdown", (e) => {
  if (pointerGuard) return;

  if (contextMenu.classList.contains("visible")) {
    if (!contextMenu.contains(e.target)) {
      contextMenu.classList.remove("visible");
    }
    return;
  }
  // #pin-dock covers the whole dock column, so grabbing a tile to drag it, or
  // missing a tile by a few pixels, doesn't count as a click outside the window.
  const CARD_SEL = "#search-box, .result-item, .special-card, .settings-card, #context-menu, #content-menu, #anim-menu, #color-picker, .drag-bar, .side-pill, #pin-dock, #theme-panel, #cc-pill";
  const onCard = e.target instanceof Element && e.target.closest(CARD_SEL);
  if (!onCard && !pointOverCard(e.clientX, e.clientY, CARD_SEL)) {
    hideWindow();
  }
});
// While a button is mid-transform (the gear turning, a pin bouncing) the hit test
// can come back empty over the whole card for a few frames, so the click is
// checked against where the cards are, not only against what was reported.
function pointOverCard(x, y, selector) {
  for (const el of document.querySelectorAll(selector)) {
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
      && getComputedStyle(el).visibility !== "hidden") return true;
  }
  return false;
}
function filterSettings(query) {
  const q = query.toLowerCase().trim();
  const rows = document.querySelectorAll("#settings-section .settings-row, #theme-card .settings-row");
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    if (!q || text.includes(q)) {
      row.style.display = "";
    } else {
      row.style.display = "none";
    }
  });
  document.querySelectorAll("#settings-section .settings-card, #theme-card").forEach((card) => {
    const any = [...card.querySelectorAll(".settings-row")].some((r) => r.style.display !== "none");
    card.classList.toggle("filtered-out", !any);
  });
}
searchInput.addEventListener("input", () => {
  const hasText = searchInput.value.length > 0;
  clearBtn.classList.toggle("visible", hasText);
  clearGhost();
  updateGhost();
  clearTimeout(debounceTimer);

  if (!hasText) {
    placeholderDeleting = false;
    placeholderCharIndex = 0;
    schedulePlaceholder(animatePlaceholder, 500);
  } else {
    if (placeholderTimer) clearTimeout(placeholderTimer);
    placeholderTimer = null;
    searchInput.placeholder = "";
  }

  if (settingsBtn.classList.contains("open")) {
    filterSettings(searchInput.value);
  } else {
    debounceTimer = setTimeout(() => performSearch(searchInput.value), 100);
  }
});
document.addEventListener("DOMContentLoaded", () => {
  loadTheme();
  searchInput.focus();
  performSearch("");
  schedulePlaceholder(animatePlaceholder, 500);
});
// The saved UI language used to be applied only when settings were opened, so
// every start showed English until then. Load it right away.
const languageReady = invoke("get_language")
  .then((lang) => {
    if (window.i18n && lang) window.i18n.setLanguage(lang);
    updateLanguageButtons(lang || "en");
  })
  .catch(() => {});
// First run (or a hotkey hook that failed): a card with the hotkey, !help and the
// context menu, shown above the empty box until the user types something.
let pendingWelcome = null;
const WELCOME_ICONS = {
  warn: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m-1.637-9.409L2.257 17.125a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636-2.87L13.637 3.59a1.914 1.914 0 0 0-3.274 0M12 16h.01"/></svg>`,
  key: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm4 2v.01m4-.01v.01m4-.01v.01m4-.01v.01M6 14v.01M18 14v.01M10 14l4 .01"/></svg>`,
  help: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9 4v.01"/><path d="M12 13a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483"/></svg>`,
  menu: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7.904 17.563a1.2 1.2 0 0 0 2.228.308l2.09-3.093l4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047-1.047a1.067 1.067 0 0 0 0-1.509l-4.907-4.907l3.113-2.09a1.2 1.2 0 0 0-.309-2.228L4 4z"/></svg>`,
};
function showWelcomeCard() {
  const w = pendingWelcome;
  if (!w || !appContainer.classList.contains("window-showing")) return;
  const rows = [];
  if (!w.hook_ok) rows.push(["warn", t("welcomeHookFailed")]);
  else rows.push(["key", t("welcomeHotkey", { hotkey: w.hotkey })]);
  rows.push(["help", t("welcomeHelp")], ["menu", t("welcomeContext")]);
  specialContent.innerHTML = `<div class="special-card welcome-card">${rows
    .map(([icon, text]) => `<div class="special-action welcome-row${icon === "warn" ? " is-warning" : ""}">${WELCOME_ICONS[icon]}<span>${escapeHtml(text)}</span></div>`)
    .join("")}</div>`;
  specialSection.classList.remove("hidden");
  hint.classList.add("hidden");
}
// The page can load before setup has queued the card, so ask both on load and when
// the backend says it is ready; take_welcome hands it out only once.
function fetchWelcome() {
  languageReady.then(() => invoke("take_welcome")).then((w) => {
    if (!w) return;
    // A fresh install (or a setup left half done) gets the setup; the card is for a hotkey that failed.
    if (w.first_run && window.UmbraSetup) {
      window.UmbraSetup.open({ first: true, hookOk: w.hook_ok });
      return;
    }
    pendingWelcome = w;
    showWelcomeCard();
  }).catch(() => {});
}
listen("welcome-ready", fetchWelcome).then(fetchWelcome);
window.__TAURI__.event.listen("window-shown", async (event) => {

  if (!window._zoomLoaded) {
    window._zoomLoaded = true;
    try {
      const zoom = await invoke("get_zoom");
      document.documentElement.style.zoom = zoom;
      document.body.style.zoom = zoom;
    } catch (e) { console.warn("zoom load failed:", e); }
  }
  clearTimeout(hideTimer);
  isHiding = false;
  pointerGuard = true;
  searchInput.value = "";
  clearGhost();
  updateGhost();
  clearBtn.classList.remove("visible");
  lastQuery = "";
  selectedIndex = -1;
  allResults = [];
  currentPins = [];
  selectableItems = [];
  resultsContainer.scrollTop = 0;
  syncScrollFade();
  clearTimeout(ntfTimer);
  ntfHover = dragBar.matches(":hover");
  ntfPending = null;
  ntfCurrent = null;
  downPos = null;
  collapseNotify();
  dragBar.classList.remove("notify", "shown", "success", "error", "warn", "info");
  syncDragTip();
  invoke("get_window_pin").then((p) => {
    dragBar.classList.toggle("pinned", !!p);
    syncDragTip();
  }).catch(() => {});
  settingsSection.classList.add("hidden");
  settingsBtn.classList.remove("open");
  closeContentMenu();
  appContainer.classList.remove("window-hidden", "window-hiding");
  appContainer.classList.add("window-showing");
  animateAllRows = true;
  if (theme && theme.followSystem) refreshSystemTheme();
  performSearch("").finally(() => appContainer.classList.remove("content-stale"));
  // Tray > Settings shows the window straight on the settings panel.
  if (event.payload && event.payload.openSettings && settingsSection.classList.contains("hidden")) toggleSettings();
  showWelcomeCard();
  // Started unconditionally: the timer is cleared on hide, and relying on it
  // being unset meant the examples came back only after typing and deleting
  // something.
  schedulePlaceholder(animatePlaceholder, 600);
  setTimeout(() => {
    searchInput.focus();
    setTimeout(() => { pointerGuard = false; }, 50);
  }, 30);
});
// Alt+Space (with Ctrl / Shift) pressed inside the window: Windows keeps it from the page, so the
// backend reports it. While a hotkey is being recorded it is the new combination; otherwise, if it
// is the hotkey, it closes the window like the hotkey does anywhere else.
window.__TAURI__.event.listen("alt-space-key", (e) => {
  const { combo, hotkey } = e.payload || {};
  if (hotkeyCapturing) applyHotkey(combo);
  else if (hotkey && !(window.UmbraSetup && window.UmbraSetup.active())) hideWindow();
});
window.__TAURI__.event.listen("window-hide-requested", () => {
  if (hotkeyCapturing) return;
  // The first-run setup holds the window up until it is finished.
  if (window.UmbraSetup && window.UmbraSetup.active()) return;
  hideWindow();
});
document.getElementById("setting-setup-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!settingsSection.classList.contains("hidden")) toggleSettings();
  if (window.UmbraSetup) window.UmbraSetup.open({ first: false });
});
window.addEventListener("language-changed", () => {
  if (theme && !theme.glow) setVal(glowVal, window.i18n.t("glowOff"));
  if (!checkUpdateBtn.disabled && updateState.phase !== "checking") checkUpdateBtn.textContent = window.i18n.t("updCheck");
  syncDragTip();
  renderAlignGrid();
  updatePlacementUI();
  renderUpdatePanel();
  _lastCustomThemesStr = null;
  loadThemes();
});
