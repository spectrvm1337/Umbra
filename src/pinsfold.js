// "Fold favorites" (theme.pinsAutoHide; the folding itself is setPinsOpen in main.js). This file has
// the arrow under the favourites and the layout that goes with the setting: while nothing is under
// the search box, the box waits in the middle of the screen; once something is (results, a card,
// the settings, the opened favourites), that is centred and the box sits on top of it. This is done
// by moving the whole column (--lift), so the page layout never changes and the stylesheet animates it.

const pinsToggle = document.getElementById("pins-toggle");
const pfSearchBox = document.getElementById("search-box");
const pfWrapper = document.getElementById("results-wrapper");

// Only with the favourites in the list: a side dock hangs down the window and would be pushed off it.
const pfOn = () => !!(theme && theme.pinsAutoHide) && pinsInList();

// How tall what is shown under the box is (0 for nothing), from the layout, so the move and the
// enter animations of the rows do not change it. The arrow does not count.
function pfContentHeight() {
  let bottom = 0;
  for (const el of resultsContainer.children) {
    if (el !== pinsToggle && el.offsetHeight > 0) bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
  }
  return bottom;
}

// The middle of the screen's work area, in the column's px. The window is centred on the whole
// monitor, taskbar included, and may have been dragged anywhere.
// shortcut: screenY and the screen are in the primary monitor's scale; off on a second monitor with another scale.
function pfScreenMid() {
  const zs = typeof tpScreenScale === "function" ? tpScreenScale() : 1;
  const mid = (screen.availTop + screen.availHeight / 2 - window.screenY) / zs;
  return Number.isFinite(mid) ? mid : appContainer.clientHeight / 2;
}

function syncPinsFold() {
  const on = pfOn();
  document.documentElement.toggleAttribute("data-pins-fold", on);
  pinsToggle.classList.toggle("available", on && !lastQuery.trim() && currentPins.length > 0 &&
    settingsSection.classList.contains("hidden") && specialSection.classList.contains("hidden"));
  pinsToggle.classList.toggle("open", pinsOpen);
  if (!on) {
    appContainer.style.removeProperty("--lift");
    if (typeof blurLift === "function") blurLift(0);
    return;
  }
  // The eyedropper has moved the window to put the bar at the top of the screen; it stays there.
  if (appContainer.classList.contains("color-compact")) return;
  // Folding rows still take their room while they fade, but the box already heads for the middle.
  const h = pinsSection.classList.contains("pins-closing") ? 0 : pfContentHeight();
  const H = appContainer.clientHeight;
  const mid = pfScreenMid();
  let lift, room;
  if (h > 0) {
    lift = mid - (pfWrapper.offsetTop + h / 2);
    room = H - (pfWrapper.offsetTop + h);
  } else {
    const box = pfSearchBox.offsetTop + pfSearchBox.offsetHeight;
    // Alone, the box sits a little above the middle (6% of the screen's height), where the eye expects it.
    const zs = typeof tpScreenScale === "function" ? tpScreenScale() : 1;
    lift = mid - (screen.availHeight * 0.06) / zs - (pfSearchBox.offsetTop + pfSearchBox.offsetHeight / 2);
    room = H - box - 40; // the arrow under the box stays in the window
  }
  // A list taller than the room left keeps the box at the top, where it always was; nothing is
  // pushed out of the bottom of the window either.
  lift = Math.max(0, Math.min(lift, room));
  // The theme panel hangs from the top of the column down to the bottom of the window, which grows
  // to fit it (themepanel.js); moved down it would be cut off.
  if (document.documentElement.dataset.tp) lift = 0;
  appContainer.style.setProperty("--lift", Math.round(lift) + "px");
  // The blur under the cards makes the same move (blur.js).
  if (typeof blurLift === "function") blurLift(Math.round(lift));
}

let pfQueued = false;
function pfQueue() {
  if (pfQueued) return;
  pfQueued = true;
  requestAnimationFrame(() => {
    pfQueued = false;
    syncPinsFold();
  });
}
// Every section coming, going or changing height, and the window being resized.
const pfObserver = new ResizeObserver(pfQueue);
for (const el of resultsContainer.children) pfObserver.observe(el);
pfObserver.observe(appContainer);
searchInput.addEventListener("input", pfQueue);
// The window glides into place on a summon; the middle is measured again once it has stopped.
let pfMoveTimer = null;
window.__TAURI__.window.getCurrentWindow().onMoved(() => {
  clearTimeout(pfMoveTimer);
  pfMoveTimer = setTimeout(pfQueue, 120);
});

// The arrow is in the list's flow, under the favourites; when they open or fold it would jump, so
// it is moved back to where it was and glides from there (the stylesheet animates `translate`).
function pfMoveArrow(change) {
  const before = pinsToggle.offsetTop;
  change();
  const after = pinsToggle.offsetTop;
  if (before === after || !pinsToggle.offsetHeight || motionOff()) return;
  pinsToggle.style.transition = "none";
  pinsToggle.style.translate = `0 ${before - after}px`;
  void pinsToggle.offsetWidth;
  pinsToggle.style.transition = "";
  pinsToggle.style.translate = "";
}

// The press must not take the focus off the search box.
pinsToggle.addEventListener("mousedown", (e) => e.preventDefault());
pinsToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setPinsOpen(!pinsOpen);
  searchInput.focus();
});

// A summon starts with the box in the middle at once rather than gliding there from where the last
// one ended.
// shortcut: the move is instant for the first 250ms after a summon, which covers the empty search; typing that fast would jump too.
window.__TAURI__.event.listen("window-shown", () => {
  appContainer.classList.add("lift-instant");
  syncPinsFold();
  setTimeout(() => appContainer.classList.remove("lift-instant"), 250);
});

if (typeof theme !== "undefined" && theme) syncPinsFold();
