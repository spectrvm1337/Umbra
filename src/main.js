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
    settingHotkeyValue.textContent = currentHotkey;
    settingZoomVal.textContent = Number(zoom || 1).toFixed(2);
    settingAutostart.classList.toggle("on", !!as);
    const itemStr = window.i18n ? window.i18n.t("itemsCount") : "items";
    const indexingStr = window.i18n ? window.i18n.t("stillIndexing") : "still indexing";
    settingIndexed.textContent = indexed > 0
      ? indexed.toLocaleString() + " " + itemStr
      : indexingStr;
    disabledKinds = kinds || [];
    renderExcludeCount();
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
function endHotkeyCapture() {
  hotkeyCapturing = false;
  settingHotkeyRow.classList.remove("capturing");
  settingHotkeyValue.textContent = currentHotkey;
}
function toggleSettings() {
  const opening = settingsSection.classList.contains("hidden");
  settingsBtn.classList.toggle("open", opening);
  settingsSection.classList.toggle("hidden", !opening);
  setSettingsStatus("");
  if (opening) {

    if (hotkeyCapturing) endHotkeyCapture();
    closeContentMenu();
    pinsSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    specialSection.classList.add("hidden");
    emptyState.classList.add("hidden");
    refreshSettingsValues();
    searchInput.blur();
  } else {

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
  if (!base) return { error: "unsupported key — use a letter, digit, F1–F12, Space or arrow" };
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (mods.length === 0) return { error: "include a modifier — Ctrl, Alt or Shift" };
  return { combo: [...mods, base].join("+") };
}
settingHotkeyRow.addEventListener("click", (e) => {
  e.stopPropagation();
  if (hotkeyCapturing) return;
  hotkeyCapturing = true;
  settingHotkeyRow.classList.add("capturing");
  settingHotkeyValue.textContent = "press keys…";
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
  if (pending) return;
  if (error) {
    setSettingsStatus(error, true);
    return;
  }
  endHotkeyCapture();
  settingHotkeyValue.textContent = combo;
  invoke("set_hotkey", { key: combo })
    .then(res => {
      currentHotkey = combo;
      setSettingsStatus("");
      showToast("Hotkey applied", false, res);
    })
    .catch(err => {
      settingHotkeyValue.textContent = currentHotkey;
      setSettingsStatus(String(err), true);
    });
}, true);
function applyZoom(z, save) {
  z = Math.max(0.5, Math.min(2, Math.round(z * 100) / 100));
  document.documentElement.style.zoom = z;
  document.body.style.zoom = z;
  setVal(settingZoomVal, z.toFixed(2));
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
    showToast(now ? "Autostart on" : "Autostart off");
  } catch (err) {
    showToast("Autostart failed", true, String(err).replace("Error:", "").trim());
  }
});
settingReindex.addEventListener("click", async (e) => {
  e.stopPropagation();
  try {

    indexingActive = true;
    indexRan = true;
    indexSpinner.classList.add("visible");
    if (settingIndexed) settingIndexed.textContent = "indexing…";
    await invoke("reindex");
    toggleSettings();
    showNotify("Rebuilding index", { type: "info", detail: "search stays available while it runs" });
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
});
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
const MS_TICK_SVG = '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2 4.8 8.5 9.5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
const groupOn = (g) => g.kinds.every((k) => !disabledKinds.includes(k));
function renderExcludeCount() {
  const off = CONTENT_GROUPS.filter((g) => !groupOn(g)).map((g) => getGroupLabel(g).toLowerCase());
  const offDrives = disabledDrives.map((d) => d.replace(":\\", ""));
  const totalOff = off.concat(offDrives);
  const total = CONTENT_GROUPS.length + availableDrives.length;
  const on = total - totalOff.length;
  excludeCount.textContent = on + "/" + total;
  const tr = (k, f) => (window.i18n ? window.i18n.t(k) : f);
  excludeRow.dataset.tip = totalOff.length === 0
    ? tr("everythingShown", "everything is shown")
    : tr("hiddenKinds", "Hidden") + ": " + totalOff.join(", ");
}
function renderContentGroups() {
  const onKinds = CONTENT_GROUPS.length - CONTENT_GROUPS.filter((g) => !groupOn(g)).length;
  const onDrives = availableDrives.length - disabledDrives.length;
  const totalOn = onKinds + onDrives;
  const total = CONTENT_GROUPS.length + availableDrives.length;
  const tr = (k, f) => (window.i18n ? window.i18n.t(k) : f);
  contentHead.textContent = tr("currentCount", "Current") + ": " + totalOn + "/" + total;
  contentGroups.innerHTML = "";
  contentGroups.appendChild(msItem(tr("selectAll", "Select All"), totalOn === total, toggleAll));
  for (const g of CONTENT_GROUPS) {
    contentGroups.appendChild(msItem(getGroupLabel(g), groupOn(g), () => toggleGroup(g)));
  }
  for (const d of availableDrives) {
    const isEnabled = !disabledDrives.includes(d);
    contentGroups.appendChild(msItem(d, isEnabled, () => toggleDrive(d)));
  }
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
  try {
    disabledDrives = await invoke("set_drive_enabled", { drive: d, enabled: enable });
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  renderContentGroups();
}
async function toggleAll() {
  const allKindsOn = CONTENT_GROUPS.every(groupOn);
  const allDrivesOn = disabledDrives.length === 0;
  const enable = !(allKindsOn && allDrivesOn);
  try {
    let cur = disabledKinds;
    for (const g of CONTENT_GROUPS) {
      for (const k of g.kinds) {
        cur = await invoke("set_kind_enabled", { kind: k, enabled: enable });
      }
    }
    disabledKinds = cur;
    for (const d of availableDrives) {
      disabledDrives = await invoke("set_drive_enabled", { drive: d, enabled: enable });
    }
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
  renderContentGroups();
}
let availableDrives = [];
let disabledDrives = [];
async function contentMenuLoad() {
  try {
    disabledKinds = await invoke("get_disabled_kinds");
    availableDrives = await invoke("get_available_drives");
    disabledDrives = await invoke("get_disabled_drives");
  } catch (err) {
    setSettingsStatus(String(err), true);
  }
}
function positionContentMenu() {
  const h = contentMenu.offsetHeight;
  contentMenu.style.top = Math.max(6, excludeRow.offsetTop - h - 6) + "px";
}
function openContentMenu() {
  if (contentMenuLoading) return;
  contentMenuLoading = true;
  contentMenuLoad().then(() => {
    contentMenuLoading = false;
    renderContentGroups();
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
const authorLink = document.getElementById("author-link");
if (authorLink) {
  authorLink.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("launch_item", { path: "https://github.com/Spectrvm/umbra" }).catch(console.error);
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
      updateTitle.textContent = `Umbra ${info.latest} is available`;
      updateMeta.textContent = `You have ${info.current}${info.asset_size ? " · " + formatBytes(info.asset_size) : ""}`;
      updateAction.textContent = "Download";
      updateAction.classList.remove("hidden");
      break;
    case "downloading":
      updateTitle.textContent = "Downloading update…";
      updateMeta.textContent = info.asset_size ? formatBytes(info.asset_size) : "";
      updateAction.textContent = "Downloading…";
      updateAction.classList.add("hidden");
      break;
    case "ready":
      updateTitle.textContent = `Umbra ${info.latest} downloaded`;
      updateMeta.textContent = downloaded ? `${downloaded.file_name} · ${formatBytes(downloaded.size)}` : "";
      updateAction.textContent = "Install & restart";
      updateAction.classList.remove("hidden");
      break;
    case "error":
      updateTitle.textContent = "Update failed";
      updateMeta.textContent = updateState.error || "Could not reach GitHub";
      updateAction.textContent = "Try again";
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
    checkUpdateBtn.textContent = "Checking…";
  }
  try {
    const info = await invoke("check_for_updates");
    // A download that already finished stays offered; checking again changes nothing.
    if (updateState.phase === "ready" && updateState.info && updateState.info.latest === info.latest) return;
    updateState = { phase: "idle", info, downloaded: null, error: null };
    if (!info.update_available) {
      renderUpdatePanel();
      if (manual) showToast(`Umbra ${info.current} is the latest version`);
    } else {
      updateState.phase = "available";
      renderUpdatePanel();
      if (manual) showToast(`Umbra ${info.latest} is available`, false, "downloading in the background");
      startUpdateDownload(info);
    }
  } catch (err) {
    const error = String(err).replace("Error:", "").trim();
    if (manual) {
      updateState = { phase: "error", info: updateState.info, downloaded: null, error };
      renderUpdatePanel();
      showToast("Update check failed", true, error);
    } else {
      console.warn("background update check failed:", error);
    }
  } finally {
    if (checkUpdateBtn) {
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = "Check for updates";
    }
  }
}
async function startUpdateDownload(info) {
  if (!info.asset_url || !info.asset_name) {
    updateState = { ...updateState, phase: "error", error: "this release has no downloadable build" };
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
      updateAction.textContent = "Installing…";
      updateState = { ...updateState, phase: "idle" };
      renderUpdateIndicator();
      await invoke("install_update");
    } catch (err) {
      updateAction.disabled = false;
      showToast("Could not start installer", true, String(err).replace("Error:", "").trim());
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
  showToast("Update ready to install", false, done.file_name);
});
listen("update-error", (event) => {
  updateState = {
    ...updateState,
    phase: "error",
    error: String(event.payload || "download failed"),
  };
  renderUpdatePanel();
  showToast("Update failed", true, updateState.error);
});
const themePresetsEl = document.getElementById("theme-presets");
const accentSwatchesEl = document.getElementById("accent-swatches");
const bgSwatchesEl = document.getElementById("bg-swatches");
const accentCustom = document.getElementById("accent-custom");
const bgCustom = document.getElementById("bg-custom");
const radiusVal = document.getElementById("setting-radius-val");
const alphaVal = document.getElementById("setting-alpha-val");
const borderRow = document.getElementById("setting-border-row");
const borderToggle = document.getElementById("setting-border");
const borderWVal = document.getElementById("setting-borderw-val");
const borderPosSeg = document.getElementById("border-pos-seg");
const densitySeg = document.getElementById("density-seg");
const tallRow = document.getElementById("setting-tall-row");
const tallToggle = document.getElementById("setting-tall");
const glowToggle = document.getElementById("setting-glow");
const glowVal = document.getElementById("setting-glow-val");
// Only two dark/light pairs of palettes: Default is the stock Umbra look,
// Flexoki and Paper are the Flexoki scheme (dark and light), with the Flexoki
// card red-tinted so it sits with the red accent instead of against it.
const THEME_PRESETS = [
  { name: "Default", cardBg: "#1e1e1e", accent: "#507090", alpha: 1, text: "#e3e3e3" },
  { name: "Paper",   cardBg: "#f2f0e5", accent: "#205ea6", alpha: 1, text: "#100f0f" },
  { name: "Flexoki", cardBg: "#1e1918", accent: "#d14d41", alpha: 1, text: "#cecdc3" },
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
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--card-bg", hexWithAlpha(theme.cardBg, theme.cardAlpha));
  root.style.setProperty("--text", theme.text);
  root.style.setProperty("--card-radius", theme.radius + "px");
  // Row/search/gap sizing comes from the [data-density] rules in the
  // stylesheet, so it stays overridable by custom themes.
  root.dataset.density = theme.density || "full";
  root.style.setProperty("--card-border-w", (theme.borderOn ? theme.borderW : 0) + "px");
  root.dataset.borderPos = theme.borderOn ? theme.borderPos : "center";
  root.style.setProperty("--glow-size", (theme.glow ? theme.glowStrength : 0) + "px");
  if (typeof applyDock === "function") applyDock();
  setVal(radiusVal, theme.radius);
  setVal(alphaVal, Math.round(theme.cardAlpha * 100) + "%");
  setVal(borderWVal, theme.borderW);
  setVal(glowVal, theme.glow ? theme.glowStrength : "off");
  borderToggle.classList.toggle("on", !!theme.borderOn);
  glowToggle.classList.toggle("on", !!theme.glow);
  borderPosSeg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.pos === theme.borderPos));
  densitySeg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.density === theme.density));
  tallToggle.classList.toggle("on", !!theme.tallResults);
  accentCustom.style.background = theme.accent;
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
async function saveTheme() {
  try {
    theme = await invoke("set_theme", { theme });
    applyTheme();
  } catch (err) {
    setSettingsStatus(String(err), true);
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
      b.dataset.tip = "Custom: " + t.name;
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
  addBtn.dataset.tip = "Open themes folder";
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
  <div class="cp-row">
    <div class="cp-preview" id="cp-preview"></div>
    <input class="cp-hex" id="cp-hex" maxlength="7" spellcheck="false" autocomplete="off">
  </div>
`;
document.body.appendChild(picker);
const cpSv = picker.querySelector("#cp-sv");
const cpSvKnob = picker.querySelector("#cp-sv-knob");
const cpHue = picker.querySelector("#cp-hue");
const cpHueKnob = picker.querySelector("#cp-hue-knob");
const cpPreview = picker.querySelector("#cp-preview");
const cpHex = picker.querySelector("#cp-hex");
const pickerState = { h: 210, s: 0.5, v: 0.56, onChange: null };
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
  cpPreview.style.background = hex;
  if (syncHex) cpHex.value = hex;
  if (pickerState.onChange) pickerState.onChange(hex);
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
bindPickerDrag(cpHue, (e) => {
  const r = cpHue.getBoundingClientRect();
  pickerState.h = clamp01((e.clientX - r.left) / r.width) * 360;
  pickerRefresh();
});
cpHex.addEventListener("input", () => {
  const hsv = hexToHsv(cpHex.value);
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
function openPicker(anchor, initialHex, onChange) {
  const hsv = hexToHsv(initialHex) || { h: 210, s: 0.5, v: 0.56 };
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
  openPicker(bgCustom, theme.cardBg, (hex) => {
    theme = { ...theme, cardBg: hex, text: textForBg(hex) };
    applyTheme();
    saveThemeDebounced();
  });
});
document.addEventListener("pointerdown", (e) => {
  if (!pickerOpen) return;
  if (e.target instanceof Element && (picker.contains(e.target) || e.target.closest("#accent-custom,#bg-custom"))) return;
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
  () => theme.radius, (v) => { theme = { ...theme, radius: Math.max(4, Math.min(24, v)) }; saveTheme(); });
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
borderRow.addEventListener("click", () => {
  theme = { ...theme, borderOn: !theme.borderOn };
  saveTheme();
});
glowToggle.parentElement.addEventListener("click", (e) => {
  if (e.target.closest(".zoom-stepper")) return;
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
// The window itself is resized on the Rust side (set_theme refits it).
tallRow.addEventListener("click", () => {
  theme = { ...theme, tallResults: !theme.tallResults };
  saveTheme();
});
async function loadTheme() {
  if (theme) return;
  try {
    theme = await invoke("get_theme");
    await loadThemes();
    applyTheme();
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
const ALIGN_TIPS = { t: "top", c: "center", b: "bottom", l: "left", r: "right" };
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
      b.dataset.tip = `${ALIGN_TIPS[code[0]]} ${ALIGN_TIPS[code[1]]}`;
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
  mk("Active", -1, "the monitor the window is currently on");
  monitors.forEach((m) => {
    mk(m.primary ? `${m.index + 1}*` : String(m.index + 1), m.index,
      `${m.width}×${m.height}${m.primary ? " · primary" : ""}`);
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
function hideWindow() {
  if (isHiding) return;
  isHiding = true;
  contextMenu.classList.remove("visible");
  appContainer.classList.remove("window-showing");
  appContainer.classList.add("window-hidden");
  clearTimeout(placeholderTimer); 

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    invoke("hide_window");
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
const EXE_GLYPH = `<span class="glyph-text">&lt;&gt;</span>`;
const FOLDER_GLYPH = `<svg class="tile-glyph" viewBox="7.896 5.212 35 35" fill="none"><path d="M16.8961 19.3485C16.8961 18.2506 16.8961 17.7017 17.1098 17.2824C17.2977 16.9135 17.5976 16.6136 17.9665 16.4257C18.3858 16.212 18.9348 16.212 20.0327 16.212H23.4382C23.9177 16.212 24.1575 16.212 24.3831 16.2662C24.583 16.3142 24.7743 16.3934 24.9497 16.5009C25.1475 16.6221 25.3171 16.7916 25.6561 17.1307L25.779 17.2537C26.1181 17.5927 26.2876 17.7622 26.4854 17.8835C26.6609 17.9909 26.8521 18.0701 27.0521 18.1182C27.2777 18.1723 27.5174 18.1723 27.9969 18.1723H31.4025C32.5004 18.1723 33.0494 18.1723 33.4687 18.386C33.8375 18.5739 34.1374 18.8738 34.3253 19.2427C34.539 19.662 34.539 20.211 34.539 21.3088V26.7977C34.539 27.8956 34.539 28.4446 34.3253 28.8639C34.1374 29.2327 33.8375 29.5327 33.4687 29.7206C33.0494 29.9342 32.5004 29.9342 31.4025 29.9342H20.0327C18.9348 29.9342 18.3858 29.9342 17.9665 29.7206C17.5976 29.5327 17.2977 29.2327 17.1098 28.8639C16.8961 28.4446 16.8961 27.8956 16.8961 26.7977V19.3485Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PHOTO_GLYPH = `<svg viewBox="0 0 22 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9C8.10457 9 9 8.1046 9 7C9 5.89543 8.10457 5 7 5C5.89543 5 5 5.89543 5 7C5 8.1046 5.89543 9 7 9Z"/><path d="M6 20C11.4112 7.90548 15.9093 5.78644 21 13.6329"/><path d="M17 1H5C2.79086 1 1 2.89035 1 5.22222V15.7778C1 18.1096 2.79086 20 5 20H17C19.2091 20 21 18.1096 21 15.7778V5.22222C21 2.89035 19.2091 1 17 1Z"/></svg>`;
const PIN_GLYPH = `<svg viewBox="0 0 16.4641 16.4641" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.1087 0.659162C11.0853 -0.364249 9.3758 -0.169198 8.60922 1.05845L6.47534 4.47586C6.47534 4.47586 6.47422 4.47774 6.47022 4.48061C6.46533 4.48411 6.45489 4.49015 6.43738 4.49509C6.39911 4.50586 6.34913 4.50503 6.30448 4.48848C5.57617 4.21848 4.32599 3.92188 3.02779 4.41087C2.32836 4.67432 1.97934 5.28065 1.94131 5.89581C1.90502 6.48275 2.14207 7.08611 2.57806 7.52209L5.22968 10.1737L0.21967 15.1837C-0.0732232 15.4767 -0.0732232 15.9515 0.21967 16.2444C0.51256 16.5373 0.987437 16.5373 1.28033 16.2444L6.29035 11.2344L8.942 13.8861C9.37797 14.322 9.98135 14.5591 10.5683 14.5228C11.1834 14.4848 11.7898 14.1357 12.0532 13.4364C12.5422 12.1381 12.2456 10.8879 11.9757 10.1596C11.9591 10.115 11.9583 10.065 11.969 10.0267C11.9739 10.0092 11.98 9.99881 11.9835 9.99386C11.9864 9.98989 11.9882 9.98884 11.9882 9.98884L15.4056 7.85486C16.6333 7.08829 16.8284 5.37879 15.8049 4.35539L12.1087 0.659162ZM9.8816 1.85292C10.1371 1.44371 10.707 1.37869 11.0481 1.71983L14.7443 5.41604C15.0854 5.75718 15.0204 6.32702 14.6112 6.58253L11.1938 8.71646C10.4853 9.15889 10.3275 10.0293 10.5692 10.681C10.7835 11.2593 10.9545 12.0978 10.6495 12.9076C10.6287 12.9629 10.6055 12.9828 10.5912 12.9927C10.5731 13.0052 10.5373 13.0218 10.4757 13.0257C10.3426 13.0339 10.1525 12.9752 10.0026 12.8254L3.63872 6.46144C3.48891 6.31163 3.43022 6.12149 3.43845 5.98836C3.44225 5.92676 3.45895 5.89103 3.47148 5.87285C3.48128 5.85863 3.50124 5.83541 3.55652 5.81459C4.36639 5.50955 5.20483 5.68058 5.78309 5.89495C6.43488 6.13658 7.3052 5.97887 7.7477 5.27033L9.8816 1.85292Z"/></svg>`;
function getTypeIcon(kind) {
  const icons = {
    app: EXE_GLYPH,
    shortcut: EXE_GLYPH,
    code: EXE_GLYPH,
    file: EXE_GLYPH,
    folder: FOLDER_GLYPH,
    image: PHOTO_GLYPH,
    document: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
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
function getExtGroup(path) {
  if (!path) return "file";
  const ext = path.split(".").pop().toLowerCase();
  const groups = {
    document: ["txt","doc","docx","pdf","rtf","odt","md","log","csv","xls","xlsx","ppt","pptx","epub"],
    image: ["png","jpg","jpeg","gif","bmp","svg","webp","ico","tiff","tif","heic"],
    audio: ["mp3","wav","ogg","flac","aac","wma","m4a","opus"],
    video: ["mp4","mkv","avi","mov","wmv","flv","webm","m4v","3gp"],
    archive: ["zip","rar","7z","tar","gz","bz2","xz","zst","iso"],
    code: ["js","ts","py","rs","go","c","cpp","h","hpp","java","cs","rb","php","html","css","json","xml","yaml","yml","toml","sh","bat","ps1","lua","r","swift","kt","dart"],
  };
  for (const [group, exts] of Object.entries(groups)) {
    if (exts.includes(ext)) return group;
  }
  return "file";
}
// path -> icon data URL, or null when the backend has none for that path. Kept across
// searches so typing does not re-request icons (and flash skeletons) for rows it already had.
const iconCache = new Map();
const ICON_CACHE_MAX = 1500;
function getVisualKind(item) {
  if (item.kind === "folder") return "folder";
  return needsRealIcon(item) ? (item.kind || "file") : getExtGroup(item.path);
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
    <div class="result-icon${needsIcon ? " icon-skeleton" : ""}">
      ${iconSrc ? `<img src="${iconSrc}" alt="">` : ""}
      <div class="result-icon-fallback ${visualKind}" style="${iconSrc ? 'display:none' : ''}">${getTypeIcon(visualKind)}</div>
    </div>
    <div class="result-name">${highlightMatch(item.name, query)}</div>
    <div class="result-path">${escapeHtml(item.path)}</div>
    <button class="result-pin ${item.pinned ? "pinned" : ""}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}" data-kind="${item.kind}">${PIN_GLYPH}</button>
   `;
  div.addEventListener("click", (e) => {
    if (rowDragging) return;
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
  pinsList.innerHTML = "";
  currentPins = pins;
  updateSelectableItems();
  pins.forEach((pin, i) => {
    const el = createResultItem({ ...pin, pinned: true }, i, lastQuery);
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
Sortable.create(pinsList, {
  animation: 250,
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
  filter: ".result-pin",
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
        if (!ok) showToast("Couldn't save order", true);
      }).catch(err => { console.warn("reorder failed", err); showToast("Save error", true); });
    } else {
      showToast("Reorder failed", true);
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
function applySelection(doScroll) {
  const containers = [];
  if (lastQuery.trim() || !pinsInList()) {
    containers.push(resultsList);
  } else {
    if (currentPins.length > 0) containers.push(pinsList);
    containers.push(resultsList);
  }
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
  const top = selectableItems[0];
  const name = top && top.name ? top.name : "";
  if (
    value &&
    name.length > value.length &&
    name.slice(0, value.length).toLowerCase() === value.toLowerCase()
  ) {
    ghostTyped.textContent = value;
    ghostRest.textContent = name.slice(value.length);
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
  rememberQuery();
  hideWindow(); 
  try {
    await invoke("launch_item", { path });
  } catch (e) {
    console.error("Launch error:", e);

    showToast("Launch failed", true, String(e).replace("Error:", "").trim());
  }
}
async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    showToast("Copied", false, path);
  } catch (e) {
    console.error("Clipboard copy failed:", e);
    showToast("Copy failed", true);
  }
}
const ntfShort = document.getElementById("ntf-short");
const ntfDetail = document.getElementById("ntf-detail");
let ntfTimer = null;
let ntfHover = false;
let ntfShownAt = 0;
function collapseNotify() {
  dragBar.classList.remove("expanded");
}
function hideNotify() {
  if (ntfHover && Date.now() - ntfShownAt <= 8000) {

    ntfTimer = setTimeout(hideNotify, 700);
    return;
  }
  clearTimeout(ntfTimer);

  collapseNotify();
  dragBar.classList.remove("shown", "notify", "tip", "success", "error", "warn", "info");
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
function renderNotify(short, { detail = "", duration = 0, tag = null } = {}, type = "info") {
  ntfCurrent = type;
  ntfTag = tag;
  const wasExp = ntfHover && dragBar.classList.contains("expanded");
  clearTimeout(ntfTimer);
  tipTarget = null; 
  dragBar.classList.remove("expanded", "shown", "notify", "tip", "success", "error", "warn", "info");
  dragBar.classList.add("notify", type);
  dragBar.removeAttribute("data-tip"); 
  ntfShort.textContent = short;
  ntfDetail.textContent = detail || short;
  dragBar.classList.add("shown");
  if (wasExp) dragBar.classList.add("expanded");

  ntfHover = dragBar.matches(":hover");
  ntfShownAt = Date.now();
  const dur = duration || (type === "success" ? 1900 : 3400);
  ntfTimer = setTimeout(hideNotify, dur);
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
  dragBar.classList.toggle("expanded", over);
});
dragBar.addEventListener("mouseleave", () => {
  ntfHover = false;
  collapseNotify();
});
const DRAG_TIP_IDLE = "Drag to move · Double-click to center · Right-click to pin";
const DRAG_TIP_PINNED = "Position pinned — right-click to unpin";
function syncDragTip() {
  if (dragBar.classList.contains("notify")) return;
  dragBar.dataset.tip = dragBar.classList.contains("pinned") ? DRAG_TIP_PINNED : DRAG_TIP_IDLE;
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
        showNotify("Position pinned", {
          type: "warn",
          tag: "pin",
          detail: "window stays here on next summons — right-click to unpin",
        });
      } else {
        showNotify("Position unpinned", { type: "info", tag: "pin", detail: "window recenters on next summons" });
      }
    })
    .catch((err) => showNotify("Pin failed", { type: "error", detail: String(err) }))
    .finally(() => { pinBusy = false; });
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
function setPinnedButtons(path, pinned) {
  document
    .querySelectorAll('#results-list .result-pin[data-path="' + CSS.escape(path) + '"]')
    .forEach(b => b.classList.toggle("pinned", pinned));
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
      if (card && pinsList.contains(card)) card.remove();
      pinsList.querySelectorAll(".result-item").forEach((el, i) => { el.dataset.index = i; });
      setPinnedButtons(path, false);
    } else {
      await invoke("add_pin", { name, path, kind });
      const pin = { name, path, kind, pinned: true };
      const idx = currentPins.length;
      currentPins.push(pin);
      const modelIdx = allResults.findIndex(r => r.path === path);
      if (modelIdx !== -1) allResults[modelIdx].pinned = true;

      pinsList.appendChild(createResultItem({ ...pin }, idx, lastQuery));
      setPinnedButtons(path, true);
    }
    updateSelectableItems();
    updateGhost();
    pinsSection.classList.toggle("hidden", currentPins.length === 0 || !!lastQuery.trim());
    updateSelection();
    layoutCustomScrollbar();
    if (typeof renderDock === "function") renderDock();
  } catch (e) {
    showToast("Pin failed", true, String(e).replace("Error:", "").trim());
  }
}
const placeholderWords = [];
const fixedWords = [
  "type to search",
  "!help — all commands",
  "tab — autocomplete",
  "right-click for actions",
  "shift+enter — copy path",
  "ctrl+shift+enter — run as admin",
  "#ff0000 — color picker",
  "100 usd to eur",
  "right-click the bar to pin position",
];
let placeholderIndex = 0;
let placeholderCharIndex = 0;
let placeholderDeleting = false;
let placeholderTimer = null;
function animatePlaceholder() {
  if (searchInput.value.length > 0 || appContainer.classList.contains("window-hidden")) {
    searchInput.placeholder = "";
    return;
  }
  const words = placeholderWords.length > 0 ? placeholderWords : fixedWords;
  const currentWord = words[placeholderIndex % words.length];
  if (!placeholderDeleting) {
    searchInput.placeholder = currentWord.substring(0, placeholderCharIndex + 1);
    placeholderCharIndex++;
    if (placeholderCharIndex >= currentWord.length) {
      placeholderTimer = setTimeout(() => {
        placeholderDeleting = true;
        animatePlaceholder();
      }, 1500);
      return;
    }
    placeholderTimer = setTimeout(animatePlaceholder, 80);
  } else {
    searchInput.placeholder = currentWord.substring(0, placeholderCharIndex);
    placeholderCharIndex--;
    if (placeholderCharIndex < 0) {
      placeholderDeleting = false;
      placeholderCharIndex = 0;
      placeholderIndex++;
      placeholderTimer = setTimeout(animatePlaceholder, 400);
      return;
    }
    placeholderTimer = setTimeout(animatePlaceholder, 50);
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
          showToast("Admin launch failed", true, String(err).replace("Error:", "").trim());
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
    showToast("Pin failed", true, String(e).replace("Error:", "").trim());
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
  indexSpinner.dataset.tip = active ? `Indexing… ${idxPct}%` : "Index ready";
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

    if (hadRun) showNotify("Index ready", { type: "success" });
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
  if (placeholderTimer) clearTimeout(placeholderTimer);
  placeholderDeleting = false;
  placeholderCharIndex = 0;
  placeholderTimer = setTimeout(animatePlaceholder, 500);
  searchInput.focus();
});
function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
async function performSearch(query) {
  lastQuery = query;
  if (query.trim()) pendingWelcome = null;
  if (handleSpecialCommand(query)) {
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
    const response = await invoke("search_all", { query });
    if (myId !== currentSearchId) return;
    if (!query.trim() && !pinsInList()) {
      // The pins live in the side dock, so the empty box lists recently opened items.
      response.results = await invoke("get_recent_items", { limit: 8 }).catch(() => []);
      if (myId !== currentSearchId) return;
    }
    allResults = response.results;
    renderPins(response.pins);
    updateSelectableItems();
    renderResults(allResults, query);
    // A new search starts at the top (this used to happen as a side effect of hiding the list).
    resultsContainer.scrollTop = 0;
    requestIconsForResults([...allResults, ...response.pins]);
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
        ? "Indexing files — search will be ready in a moment"
        : "No results found";
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
// What Enter does on a row: launch it; Ctrl+Shift runs it as admin, Shift copies the
// path, Ctrl shows it in Explorer. Help rows fill the box and copy rows copy instead.
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
  if (mods.ctrlKey && mods.shiftKey) {
    hideWindow();
    invoke("launch_admin", { path: item.path })
      .catch(() => console.error("Admin launch failed"));
  } else if (mods.ctrlKey && !/^https?:/i.test(item.path)) {
    invoke("reveal_in_explorer", { path: item.path }).catch((err) => console.warn("reveal failed:", err));
    hideWindow();
  } else if (mods.shiftKey) {
    copyPath(item.path);
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
// Holding Ctrl for a moment shows each row's number in place of its pin button.
let shortcutHintTimer = null;
function showRowShortcuts(on) {
  clearTimeout(shortcutHintTimer);
  document.body.classList.toggle("show-shortcuts", on);
  document.querySelectorAll(".result-item[data-shortcut]").forEach((el) => delete el.dataset.shortcut);
  if (on) shortcutRows().forEach((el) => { el.dataset.shortcut = Number(el.dataset.index) + 1; });
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
  if (e.altKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    stepQueryHistory(e.key === "ArrowUp" ? 1 : -1);
    return;
  }
  // Ctrl+1..9 runs row N; Ctrl+P pins or unpins the selected row (and keeps
  // WebView2's print dialog away).
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
    if (e.code === "KeyP") {
      e.preventDefault();
      const item = selectableItems[selectedIndex];
      if (item && item.path && !["help", "copy", "open"].includes(item.kind)) setItemPinned(item, !isPinned(item.path));
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
  const cw = Math.max(MAIN_MIN_W, Math.min(MAIN_MAX_W - dockW, Math.round(w)));
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
  const onCard =
    e.target instanceof Element &&
    // #pin-dock covers the whole dock column, so grabbing a tile to drag it, or
    // missing a tile by a few pixels, doesn't count as a click outside the window.
    e.target.closest("#search-box, .result-item, .special-card, .settings-card, #context-menu, #content-menu, #color-picker, .drag-bar, .side-pill, #pin-dock");
  if (!onCard) {
    hideWindow();
  }
});
function filterSettings(query) {
  const q = query.toLowerCase().trim();
  const rows = settingsSection.querySelectorAll(".settings-row");
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    if (!q || text.includes(q)) {
      row.style.display = "";
    } else {
      row.style.display = "none";
    }
  });
}
searchInput.addEventListener("input", () => {
  const hasText = searchInput.value.length > 0;
  clearBtn.classList.toggle("visible", hasText);
  clearGhost();
  updateGhost();
  clearTimeout(debounceTimer);

  if (!hasText) {
    if (placeholderTimer) clearTimeout(placeholderTimer);
    placeholderDeleting = false;
    placeholderCharIndex = 0;
    placeholderTimer = setTimeout(animatePlaceholder, 500);
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
  setTimeout(animatePlaceholder, 500);
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
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>`,
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
  performSearch("");
  // Tray > Settings shows the window straight on the settings panel.
  if (event.payload && event.payload.openSettings && settingsSection.classList.contains("hidden")) toggleSettings();
  showWelcomeCard();
  if (!placeholderTimer) placeholderTimer = setTimeout(animatePlaceholder, 600);
  setTimeout(() => {
    searchInput.focus();
    setTimeout(() => { pointerGuard = false; }, 50);
  }, 30);
});
window.__TAURI__.event.listen("window-hide-requested", () => {
  hideWindow();
});
