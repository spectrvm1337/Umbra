// The appearance settings (colours, shape, font, motion) live in a card beside the window instead
// of the settings list. It opens from the Appearance row, on the side the pins dock is not on, and
// the window grows by TP_RESERVE on that side the way it does for the dock (dock.js).

// The card's width (--tp-w) plus the room the window's edge keeps for shadows, less the 8px it tucks
// towards the search panel. Matches --tp-reserve in styles.css.
const TP_RESERVE = 496;

const themePanel = document.getElementById("theme-panel");
const themeRow = document.getElementById("setting-theme-row");
const keysRow = document.getElementById("setting-keys-row");
// The card holds one of two views, Appearance or Keybinds; the window's room and animation are shared.
let tpView = "theme";
let tpSide = null; // "left" | "right" while the window is wide enough for the panel
let tpApplied = 0; // the room the window has been given for it, zoom included
let tpWanted = false;
let tpChain = Promise.resolve();

// The window is sized in logical px but the page is drawn at the zoom, so the room is scaled. The
// zoom is set on both <html> and <body> (applyZoom in main.js), so a CSS px is zoom squared on screen.
function tpScreenScale() {
  const z = (el) => parseFloat(el.style.zoom) || 1;
  return z(document.documentElement) * z(document.body);
}
const tpScaled = () => Math.round(TP_RESERVE * tpScreenScale());
function tpExtraWidth() {
  return tpSide ? tpApplied : 0;
}
function tpLeftExtra() {
  return tpSide === "left" ? tpApplied : 0;
}
// A zoom change scales the room the window needs for the open panel.
function refreshThemePanelRoom() {
  tpChain = tpChain.then(() => {
    if (!tpSide || tpScaled() === tpApplied) return;
    const before = sidesLeftExtra();
    tpApplied = tpScaled();
    return resizeWindowSides(before);
  }).catch((err) => console.warn("theme panel:", err));
}

const tpSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tpFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const tpAnimated = () => !motionOff() && appContainer.classList.contains("window-showing");

function setThemePanel(want) {
  tpWanted = want;
  return applyThemePanel();
}
// One change at a time, each starting from where the last one ended.
function applyThemePanel() {
  tpChain = tpChain.then(runThemePanel).catch((err) => console.warn("theme panel:", err));
  return tpChain;
}

function paintPanelRows() {
  themeRow.classList.toggle("open", tpWanted && tpView === "theme");
  keysRow.classList.toggle("open", tpWanted && tpView === "keys");
}

// A row opens its view; the same row again closes the panel, the other row swaps the view in place.
function togglePanelView(view) {
  if (tpWanted && tpView === view) return setThemePanel(false);
  tpView = view;
  themePanel.dataset.view = view;
  themePanel.setAttribute("aria-label", view === "keys" ? "Keybinds" : "Appearance");
  return setThemePanel(true);
}

async function runThemePanel() {
  paintPanelRows();
  const side = tpWanted ? (dockSide === "right" ? "left" : "right") : null;
  if (side === tpSide) return;
  if (tpSide) await closeThemePanel();
  if (side) await openThemePanel(side);
}

// The window and the layout cannot change in the same frame. On the right the card is pinned to its
// old width while the window grows under it, then the real layout takes over. On the left the window
// grows leftwards, which would move the card for a frame, so the card is hidden meanwhile.
async function openThemePanel(side) {
  const root = document.documentElement;
  const animated = tpAnimated();
  const masked = side === "left" && animated;
  if (masked) {
    appContainer.classList.add("dock-switching");
    await tpSleep(90);
  } else {
    appContainer.style.width = appContainer.offsetWidth + "px";
  }
  const before = sidesLeftExtra();
  tpSide = side;
  tpApplied = tpScaled();
  await resizeWindowSides(before);
  await waitForViewportWidth(mainLogicalW + dockExtraWidth());
  root.dataset.tp = side;
  appContainer.style.width = "";
  if (animated) await tpFrames();
  if (masked) appContainer.classList.remove("dock-switching");
  themePanel.classList.add("show");
}

async function closeThemePanel() {
  const root = document.documentElement;
  const side = tpSide;
  const animated = tpAnimated();
  themePanel.classList.remove("show");
  if (animated) await tpSleep(160);
  const before = sidesLeftExtra();
  if (side === "left" && animated) {
    // The window shrinks from the left, which moves the card; it is hidden meanwhile.
    appContainer.classList.add("dock-switching");
    await tpSleep(90);
  } else {
    // Without the panel's room the card keeps its place when the window shrinks on the right.
    appContainer.style.width = appContainer.offsetWidth - (side === "left" ? 0 : TP_RESERVE) + "px";
  }
  delete root.dataset.tp;
  tpSide = null;
  await resizeWindowSides(before);
  tpApplied = 0;
  await waitForViewportWidth(mainLogicalW + dockExtraWidth());
  appContainer.style.width = "";
  if (appContainer.classList.contains("dock-switching")) {
    await tpFrames();
    appContainer.classList.remove("dock-switching");
  }
}

// The window is about to hide: drop the panel at once, with no animation, whatever it is doing.
function resetThemePanelNow() {
  tpWanted = false;
  tpChain = tpChain.then(async () => {
    themeRow.classList.remove("open");
    keysRow.classList.remove("open");
    if (!tpSide) return;
    const before = sidesLeftExtra();
    themePanel.classList.remove("show");
    delete document.documentElement.dataset.tp;
    tpSide = null;
    appContainer.style.width = "";
    await resizeWindowSides(before);
    tpApplied = 0;
  }).catch((err) => console.warn("theme panel:", err));
  return tpChain;
}

themeRow.addEventListener("click", () => togglePanelView("theme"));
keysRow.addEventListener("click", () => togglePanelView("keys"));
// Whichever way the settings close (the gear, Esc, typing a search, the window hiding), the panel goes too.
new MutationObserver(() => {
  if (tpWanted && settingsSection.classList.contains("hidden")) setThemePanel(false);
}).observe(settingsSection, { attributes: true, attributeFilter: ["class"] });
