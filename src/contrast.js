// The drag bar and the favourites arrow sit on the wallpaper, not on a card, so each takes its colour
// from what is behind it: dark over a light background, white over a dark one (.on-light in the
// stylesheet). The brightness map comes with "window-shown" (backdrop.rs), taken while the window
// was still hidden; it stays right while the window glides into place or is dragged, as long as the
// wallpaper behind it does not change.

const ctBar = document.getElementById("drag-bar");
const ctPill = ctBar.querySelector(".db-rect");
const ctArrow = document.getElementById("pins-toggle");
let ctMap = null; // { x, y, w, h, cols, rows, bytes }

// Average brightness (0..1) of the screen under `el` and a few px around it, or null if unknown.
// shortcut: screenX/Y and devicePixelRatio of the window's monitor; off on a second monitor with another scale.
function ctBrightness(el) {
  const r = el.getBoundingClientRect();
  if (!ctMap || !r.width || !r.height) return null;
  const d = window.devicePixelRatio || 1;
  const pad = 8;
  const cw = ctMap.w / ctMap.cols, ch = ctMap.h / ctMap.rows;
  const cell = (v, size, n) => Math.max(0, Math.min(n - 1, Math.floor(v / size)));
  const c0 = cell((window.screenX + r.left - pad) * d - ctMap.x, cw, ctMap.cols);
  const c1 = cell((window.screenX + r.right + pad) * d - ctMap.x, cw, ctMap.cols);
  const r0 = cell((window.screenY + r.top - pad) * d - ctMap.y, ch, ctMap.rows);
  const r1 = cell((window.screenY + r.bottom + pad) * d - ctMap.y, ch, ctMap.rows);
  let sum = 0, n = 0;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      sum += ctMap.bytes[row * ctMap.cols + col];
      n++;
    }
  }
  return n ? sum / n / 255 : null;
}

// A little hysteresis, so a background right at the edge does not make it flicker.
function ctPaint(el, host) {
  const b = ctBrightness(el);
  if (b === null) return;
  if (b > 0.62) host.classList.add("on-light");
  else if (b < 0.55) host.classList.remove("on-light");
}

function ctUpdate() {
  ctPaint(ctPill, ctBar);
  ctPaint(ctArrow, ctArrow);
}

window.__TAURI__.event.listen("window-shown", (event) => {
  const map = event.payload && event.payload.backdrop;
  if (!map) return;
  const raw = atob(map.luma);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  ctMap = { ...map, bytes };
  ctUpdate();
});
// The column glides, the window slides into place or is dragged, the arrow moves under the
// favourites: looked at again a few times a second while the window is up (a handful of reads).
setInterval(() => {
  if (ctMap && appContainer.classList.contains("window-showing")) ctUpdate();
}, 200);
