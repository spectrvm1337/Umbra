// Colour widget: "#c83939" or "rgb(200, 57, 57)" -> swatch with shades, RGB / HSL,
// recent colours, and a screen eyedropper whose loupe shows the pixels under the cursor
// (the capture runs in Rust, src-tauri/src/color_pick.rs).

const COLOR_HISTORY_KEY = "umbra.color.history";
const COLOR_HISTORY_MAX = 7;
const COLOR_REMEMBER_MS = 1000;
// The capture is COLOR_GRID pixels square (color_pick.rs); the loupe shows the middle of it at
// one of COLOR_ZOOMS cells across, so the same capture can be zoomed in and out.
const COLOR_GRID = 45;
const COLOR_VIEW = 15; // cells across the empty placeholder
const COLOR_ZOOMS = [45, 31, 21, 15, 9, 5];
const COLOR_ZOOM_KEY = "umbra.color.zoom.v2";

function parseColorQuery(query) {
  const q = query.trim();
  const hex = q.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const rgb = q.match(/^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/i);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number);
    if (r <= 255 && g <= 255 && b <= 255) return { r, g, b };
  }
  return null;
}

function colorToHex(c) {
  return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function colorToRgb(c) {
  return `${c.r}, ${c.g}, ${c.b}`;
}

function colorToHsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return `${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
}

// Text colour that reads on top of c: near-black on light colours, white on dark ones.
function colorInk(c) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  return lum > 0.4 ? "#171717" : "#ffffff";
}

// amount > 0 mixes towards white, < 0 towards black.
function colorShade(c, amount) {
  const target = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  const mix = (v) => Math.round(v + (target - v) * a);
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b) };
}

// ---- history ----

function colorReadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(COLOR_HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list.filter((h) => /^#[0-9A-F]{6}$/.test(h)) : [];
  } catch {
    return [];
  }
}

function colorRemember(hex) {
  try {
    const list = [hex, ...colorReadHistory().filter((h) => h !== hex)].slice(0, COLOR_HISTORY_MAX);
    localStorage.setItem(COLOR_HISTORY_KEY, JSON.stringify(list));
  } catch {}
}

// ---- card ----

function colorReadZoom() {
  try {
    const i = parseInt(localStorage.getItem(COLOR_ZOOM_KEY), 10);
    if (i >= 0 && i < COLOR_ZOOMS.length) return i;
  } catch {}
  return 3;
}
let colorZoom = colorReadZoom(); // index into COLOR_ZOOMS

let colorShown = null; // the parsed colour currently on the card
// The shade strip keeps showing the colour it was built from while one of its shades is
// picked, instead of shading the shade again.
let colorShadeBase = null;
let colorShadePicked = null; // hex of the shade last clicked in the strip
let colorPicking = false;
let colorLoupe = null; // last captured pixels, kept so the loupe isn't empty next time
let colorRememberTimer = null;

const COLOR_PIN_SVG = `<svg class="cc-pin" width="34" height="43" viewBox="0 0 34 43" aria-hidden="true"><path d="M17 0C7.6 0 0 7.4 0 16.6 0 28.6 17 43 17 43s17-14.4 17-26.4C34 7.4 26.4 0 17 0Z" fill="#fff"/><circle class="cc-pin-dot" cx="17" cy="16.5" r="8"/></svg>`;

const COLOR_DROPPER_SVG = `<svg width="17" height="18" viewBox="0 0 17 18" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.40525 13.7128C5.07988 14.2677 2.78716 15.8468 2.38647 15.4225C2.12682 15.1475 2.66162 14.0314 3.21288 12.8979H7.17495C7.00391 13.079 6.74734 13.3507 6.40525 13.7128Z" fill="currentColor"/><path d="M13.4328 4.99912C13.7647 4.64765 14.303 4.64765 14.6349 4.99912C14.9668 5.35059 14.9668 5.92044 14.6349 6.27191L7.00629 14.3492C6.92408 14.4363 6.82588 14.5046 6.71776 14.5499C6.38088 14.6908 6.03818 14.8685 5.22789 15.3105C4.82739 15.529 4.65054 15.6244 4.43417 15.7372C2.94828 16.5124 2.38983 16.6988 1.78543 16.0589C1.18217 15.4201 1.35767 14.8281 2.08449 13.2644C2.19218 13.0326 2.28338 12.8432 2.49221 12.4139C2.90957 11.5559 3.07743 11.193 3.21062 10.8364C3.25337 10.7219 3.31784 10.6179 3.40004 10.5309L11.0287 2.45354C11.3606 2.10207 11.8988 2.10207 12.2307 2.45354C12.5627 2.805 12.5627 3.37486 12.2307 3.72632L4.7234 11.6753C4.57529 12.0486 4.38902 12.4457 4.0035 13.2381C3.79954 13.6574 3.7113 13.8407 3.60979 14.0592C3.58865 14.1046 3.56827 14.1489 3.54867 14.1919C3.59205 14.1697 3.63676 14.1466 3.68284 14.1225C3.88696 14.0161 4.05814 13.9237 4.44945 13.7103C5.1979 13.3021 5.57289 13.1049 5.92548 12.948L13.4328 4.99912Z" fill="currentColor"/><path d="M12.2307 3.72635C11.8988 4.07783 11.3606 4.07783 11.0287 3.72635C10.6967 3.37488 10.6967 2.80503 11.0287 2.45356C12.0244 1.39915 13.639 1.39915 14.6349 2.45356C15.6307 3.50797 15.6307 5.21752 14.6349 6.27194C14.3029 6.62341 13.7647 6.62341 13.4328 6.27194C13.1009 5.92047 13.1009 5.35062 13.4328 4.99915C13.7647 4.64767 13.7647 4.07783 13.4328 3.72635C13.1009 3.37488 12.5627 3.37488 12.2307 3.72635Z" fill="currentColor"/><path d="M8.0217 4.36087C7.68976 4.0094 7.68976 3.43955 8.0217 3.08808C8.35366 2.7366 8.89185 2.7366 9.22377 3.08808L14.0321 8.17925C14.3641 8.53072 14.3641 9.10053 14.0321 9.45207C13.7001 9.80352 13.162 9.80352 12.8301 9.45207L8.0217 4.36087Z" fill="currentColor"/></svg>`;

// Text comes from the language chosen in settings (i18n.js); the English strings are the fallback.
function colorT(key, fallback, params) {
  return window.i18n ? window.i18n.t(key, params) : fallback;
}

function colorCardHtml(c, base = c) {
  const hex = colorToHex(c);
  const history = colorReadHistory()
    .map((h) => `<button class="cc-chip" data-hex="${h}" style="background:${h}" title="${h}"></button>`)
    .join("");
  return `
    <div class="cc-preview">
      <div class="cc-shades">${[0.25, 0, -0.25].map((k) => {
        const shade = colorToHex(colorShade(base, k));
        return `<button class="cc-shade${k !== 0 && shade === hex ? " active" : ""}" data-hex="${shade}" style="background:${shade}" title="${shade}"></button>`;
      }).join("")}</div>
      <div class="cc-swatch" style="background:${hex};--cc-ink:${colorInk(c)}" data-copy="${hex}" title="${escapeHtml(colorT("colorCopyHex", "Click or press Enter to copy {hex}", { hex }))}"><span class="cc-hex">${hex}</span></div>
    </div>
    <div class="cc-info">
      <div class="cc-field" data-copy="${colorToRgb(c)}" title="${colorT("colorCopy", "Copy")}"><div class="cc-label">RGB</div><div class="cc-value">${colorToRgb(c)}</div></div>
      <div class="cc-field" data-copy="hsl(${colorToHsl(c)})" title="${colorT("colorCopy", "Copy")}"><div class="cc-label">HSL</div><div class="cc-value">${colorToHsl(c)}</div></div>
      <div class="cc-field"><div class="cc-label">${colorT("colorHistory", "History")}</div><div class="cc-history">${history}</div></div>
    </div>
    <div class="cc-loupe">
      <canvas class="cc-pixels" width="${COLOR_GRID}" height="${COLOR_GRID}" style="transform:scale(${COLOR_GRID / COLOR_ZOOMS[colorZoom]})"></canvas>
      <canvas class="cc-skeleton"></canvas>
      ${COLOR_PIN_SVG}
      <div class="cc-tools">
        <button class="cc-tool cc-zoom-out" title="${escapeHtml(colorT("colorZoomOut", "Zoom out"))}"${colorZoom === 0 ? " disabled" : ""}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        <button class="cc-tool cc-zoom-in" title="${escapeHtml(colorT("colorZoomIn", "Zoom in"))}"${colorZoom === COLOR_ZOOMS.length - 1 ? " disabled" : ""}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7M5 1.5v7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
      <button class="cc-tool cc-clear" title="${escapeHtml(colorT("colorClearShot", "Remove the screenshot"))}"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      <button class="cc-dropper" title="${escapeHtml(colorT("colorPickTip", "Pick a colour from the screen (Esc or right-click cancels)"))}">${COLOR_DROPPER_SVG}</button>
    </div>`;
}

// Eyedropper frames arrive ~30 times a second: change the values in place instead of
// rebuilding the card (and its loupe canvas) on every frame. False if the card has not
// been built yet.
function colorUpdateCard(card, c, base = c) {
  const swatch = card.querySelector(".cc-swatch");
  const shades = card.querySelectorAll(".cc-shade");
  const [rgb, hsl] = card.querySelectorAll(".cc-info .cc-field[data-copy]");
  if (!swatch || shades.length !== 3 || !rgb || !hsl) return false;
  const hex = colorToHex(c);
  swatch.style.background = hex;
  swatch.style.setProperty("--cc-ink", colorInk(c));
  const hexLabel = swatch.querySelector(".cc-hex");
  if (hexLabel) hexLabel.textContent = hex;
  swatch.dataset.copy = hex;
  swatch.title = colorT("colorCopyHex", "Click or press Enter to copy {hex}", { hex });
  [0.25, 0, -0.25].forEach((k, i) => {
    const shade = colorToHex(colorShade(base, k));
    shades[i].style.background = shade;
    shades[i].dataset.hex = shade;
    shades[i].title = shade;
    shades[i].classList.toggle("active", k !== 0 && shade === hex);
  });
  rgb.dataset.copy = colorToRgb(c);
  rgb.querySelector(".cc-value").textContent = colorToRgb(c);
  hsl.dataset.copy = `hsl(${colorToHsl(c)})`;
  hsl.querySelector(".cc-value").textContent = colorToHsl(c);
  return true;
}

// The history chips are changed one by one, so a new colour appears and the others
// ease over to their new place instead of the row being drawn again.
function colorUpdateHistory(card) {
  const wrap = card.querySelector(".cc-history");
  if (!wrap) return;
  const list = colorReadHistory();
  const kids = [...wrap.children];
  list.forEach((h, i) => {
    let b = kids[i];
    if (!b) {
      b = document.createElement("button");
      b.className = "cc-chip cc-new";
      wrap.appendChild(b);
      b.style.background = h;
    }
    if (b.dataset.hex !== h) {
      b.dataset.hex = h;
      b.style.background = h;
      b.title = h;
    }
  });
  kids.slice(list.length).forEach((b) => b.remove());
}

function colorDrawLoupe(card, pixels) {
  const canvas = card.querySelector(".cc-loupe .cc-pixels");
  const has = pixels && pixels.length === COLOR_GRID * COLOR_GRID;
  card.querySelector(".cc-loupe").classList.toggle("has-capture", !!has);
  if (!has) return;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(COLOR_GRID, COLOR_GRID);
  pixels.forEach((hex, i) => {
    img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
    img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[i * 4 + 3] = 255;
  });
  ctx.putImageData(img, 0, 0);
  card.querySelector(".cc-pin-dot").setAttribute("fill", pixels[pixels.length >> 1]);
}

// Placeholder for the empty loupe: the same COLOR_GRID x COLOR_GRID grid as the
// captured pixels, with two slow blobs of lighter dots drifting
// across. Runs only while the loupe is empty and on screen.
const colorReduceMotion = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };
function colorStartSkeleton(card) {
  const loupe = card.querySelector(".cc-loupe");
  const canvas = card.querySelector(".cc-skeleton");
  if (!loupe || !canvas || canvas.dataset.running) return;
  canvas.dataset.running = "1";
  const dpr = window.devicePixelRatio || 1;
  const w = loupe.clientWidth || 168;
  const h = loupe.clientHeight || 165;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  // The dots and the drifting blobs are the loupe's own background lightened, so the
  // placeholder is a lighter shade of its surface in every theme. Re-read now and then
  // because the card stays on screen across theme changes.
  let accent = "#ffffff";
  let frames = 0;
  const readTones = () => {
    const m = getComputedStyle(loupe).backgroundColor.match(/[\d.]+/g);
    if (!m || m.length < 3) return;
    const mix = (k) => `rgb(${[0, 1, 2].map((i) => Math.round(+m[i] + (255 - +m[i]) * k)).join(",")})`;
    accent = mix(0.65);
  };
  const step = Math.min(w, h) / COLOR_VIEW;
  const blob = (t, a, b, phase) => [0.5 + 0.38 * Math.sin(t * a + phase), 0.5 + 0.38 * Math.cos(t * b + phase * 1.7)];
  const start = performance.now();
  const frame = (now) => {
    if (!canvas.isConnected || loupe.classList.contains("has-capture")) {
      delete canvas.dataset.running;
      return;
    }
    // Looping is permanent, so the only thing that stills this is the system
    // asking for reduced motion.
    if (frames++ % 30 === 0) readTones();
    const t = colorReduceMotion.matches ? 2 : (now - start) / 1000;
    const blobs = [blob(t, 0.55, 0.42, 0), blob(t, 0.37, 0.61, 2.4)];
    ctx.clearRect(0, 0, w, h);
    for (let row = 0; row < COLOR_VIEW; row++) {
      for (let col = 0; col < COLOR_VIEW; col++) {
        const u = (col + 0.5) / COLOR_VIEW;
        const v = (row + 0.5) / COLOR_VIEW;
        let glow = 0;
        for (const [bx, by] of blobs) glow = Math.max(glow, Math.exp(-((u - bx) ** 2 + (v - by) ** 2) / 0.06));
        const x = (col + 0.5) * step + (w - step * COLOR_VIEW) / 2;
        const y = (row + 0.5) * step + (h - step * COLOR_VIEW) / 2;
        if (glow > 0.04) {
          ctx.globalAlpha = Math.min(1, glow * 1.2);
          ctx.fillStyle = accent;
          ctx.beginPath();
          ctx.arc(x, y, 0.9 + 1.5 * glow, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    if (colorReduceMotion.matches) {
      delete canvas.dataset.running;
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- zoom, removing the screenshot ----

function colorApplyZoom(card) {
  const canvas = card.querySelector(".cc-pixels");
  if (canvas) canvas.style.transform = `scale(${COLOR_GRID / COLOR_ZOOMS[colorZoom]})`;
  const out = card.querySelector(".cc-zoom-out");
  const inn = card.querySelector(".cc-zoom-in");
  if (out) out.disabled = colorZoom === 0;
  if (inn) inn.disabled = colorZoom === COLOR_ZOOMS.length - 1;
}

function colorStepZoom(card, dir) {
  const next = Math.max(0, Math.min(COLOR_ZOOMS.length - 1, colorZoom + dir));
  if (next === colorZoom) return;
  colorZoom = next;
  try { localStorage.setItem(COLOR_ZOOM_KEY, String(colorZoom)); } catch {}
  colorApplyZoom(card);
}

function colorClearShot(card) {
  colorLoupe = null;
  colorDrawLoupe(card, null);
  colorStartSkeleton(card);
}

// ---- the collapsed picker bar ----
// While the eyedropper runs the card folds up into a small bar: a live loupe of the pixels
// under the cursor, the colour's hex and RGB, a cancel button and a chevron to bring the
// full card back. The bar's own buttons must stay clickable although the picker swallows
// every other click, so its screen rectangle is handed to the Rust hook.

const COLOR_X_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.8 1.8l8.4 8.4M10.2 1.8l-8.4 8.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const COLOR_CHEVRON_SVG = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 5l4.5 4.5L11.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function colorEnsurePill() {
  let pill = document.getElementById("cc-pill");
  if (pill) return pill;
  pill = document.createElement("div");
  pill.id = "cc-pill";
  pill.innerHTML = `
    <div class="ccp-swatch"></div>
    <div class="ccp-text"><div class="ccp-hex"></div><div class="ccp-sub"></div></div>
    <button class="ccp-btn ccp-cancel">${COLOR_X_SVG}</button>
    <button class="ccp-btn ccp-expand">${COLOR_CHEVRON_SVG}</button>`;
  appContainer.appendChild(pill);
  pill.querySelector(".ccp-cancel").addEventListener("click", () => {
    invoke("cancel_color_pick").catch((err) => console.warn("cancel failed:", err));
  });
  pill.querySelector(".ccp-expand").addEventListener("click", () => colorSetCompact(false));
  return pill;
}

function colorLabelPill(pill) {
  pill.title = colorT("colorPickHint", "Click to pick · Esc or right-click cancels");
  pill.querySelector(".ccp-cancel").title = colorT("colorCancelPick", "Cancel");
  pill.querySelector(".ccp-expand").title = colorT("colorExpand", "Show the full card");
}

function colorUpdatePill(c) {
  const pill = document.getElementById("cc-pill");
  if (!pill) return;
  pill.querySelector(".ccp-swatch").style.background = colorToHex(c);
  pill.querySelector(".ccp-hex").textContent = colorToHex(c);
  pill.querySelector(".ccp-sub").textContent = `RGB ${colorToRgb(c)}`;
}

// Where the bar is on screen, for the mouse hook (physical px).
async function colorSyncExclusion(on) {
  try {
    if (!on) return invoke("set_pick_exclusion", { left: 0, top: 0, right: 0, bottom: 0 });
    const pill = document.getElementById("cc-pill");
    const win = window.__TAURI__.window.getCurrentWindow();
    const pos = await win.outerPosition();
    const r = pill.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    await invoke("set_pick_exclusion", {
      left: Math.round(pos.x + r.left * d) - 4,
      top: Math.round(pos.y + r.top * d) - 4,
      right: Math.round(pos.x + r.right * d) + 4,
      bottom: Math.round(pos.y + r.bottom * d) + 4,
    });
  } catch (err) {
    console.warn("pick exclusion failed:", err);
  }
}

// The bar rides to the top centre of the screen so it stays out of the way of what is picked.
function colorDockWindow(on) {
  const pill = document.getElementById("cc-pill");
  if (!pill) return;
  const d = window.devicePixelRatio || 1;
  const host = appContainer.getBoundingClientRect();
  invoke("dock_window_for_pick", {
    on,
    barCx: (host.left + pill.offsetLeft + pill.offsetWidth / 2) * d,
    barTop: (host.top + pill.offsetTop) * d,
    margin: 14 * d,
  }).catch((err) => console.warn("dock failed:", err));
}

let colorCompactTimer = null;
function colorSetCompact(on) {
  const pill = colorEnsurePill();
  colorLabelPill(pill);
  clearTimeout(colorCompactTimer);
  appContainer.classList.toggle("color-compact", on);
  pill.classList.toggle("show", on);
  if (!on) {
    colorSyncExclusion(false);
    colorDockWindow(false);
    return;
  }
  if (colorShown) colorUpdatePill(colorShown);
  // The bar settles in after its entrance; measure it once it is there.
  colorDockWindow(true);
  // The window needs its slide to the top of the screen to finish before the bar is measured.
  colorCompactTimer = setTimeout(() => colorSyncExclusion(true), 700);
}

function renderColorCard(c) {
  let card = specialContent.querySelector(".color-card");
  if (!card) {
    specialContent.innerHTML = `<div class="special-card color-card"></div>`;
    card = specialContent.querySelector(".color-card");
  }
  const base = colorShadeBase || c;
  const hasShades = card.querySelectorAll(".cc-shade").length === 3;
  if (hasShades && colorUpdateCard(card, c, base)) {
    // Same card, new colour: the swatch, shades and chips change in place (CSS eases them).
    colorUpdateHistory(card);
  } else {
    card.innerHTML = colorCardHtml(c, base);
    card.classList.toggle("picking", colorPicking);
    colorDrawLoupe(card, colorLoupe);
    colorStartSkeleton(card);
  }
  card.classList.toggle("picking", colorPicking);
  return card;
}

function colorSetQuery(hex) {
  searchInput.value = hex;
  searchInput.dispatchEvent(new Event("input"));
  searchInput.focus();
}

function colorCopy(text) {
  copyPath(text);
  if (colorShown) colorRemember(colorToHex(colorShown));
}

function handleColorCommand(query) {
  const c = parseColorQuery(query);
  if (!c) return false;
  specialSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  pinsSection.classList.add("hidden");
  colorShown = c;
  if (colorToHex(c) !== colorShadePicked) {
    colorShadeBase = c;
    colorShadePicked = null;
  }
  renderColorCard(c);
  // Enter is handled by the keydown listener below; never fall through to an old result.
  selectableItems = [];
  selectedIndex = -1;
  // Only colours that stay on screen for a moment go into History, not every prefix typed.
  clearTimeout(colorRememberTimer);
  colorRememberTimer = setTimeout(() => {
    if (parseColorQuery(searchInput.value) && colorToHex(parseColorQuery(searchInput.value)) === colorToHex(c)) {
      colorRemember(colorToHex(c));
    }
  }, COLOR_REMEMBER_MS);
  return true;
}

// Card clicks, eyedropper frames and keys. Not run when the file is loaded by the unit tests.
function colorInit() {
  specialContent.addEventListener("click", (e) => {
    const card = e.target.closest(".color-card");
    if (!card) return;
    if (e.target.closest(".cc-zoom-in")) return colorStepZoom(card, 1);
    if (e.target.closest(".cc-zoom-out")) return colorStepZoom(card, -1);
    if (e.target.closest(".cc-clear")) return colorClearShot(card);
    // History chips and the lighter / darker shades both switch the card to that colour.
    const chip = e.target.closest(".cc-chip, .cc-shade");
    if (chip) {
      if (chip.classList.contains("cc-shade")) colorShadePicked = chip.dataset.hex;
      return colorSetQuery(chip.dataset.hex);
    }
    if (e.target.closest(".cc-dropper")) {
      e.stopPropagation();
      if (colorPicking) {
        invoke("cancel_color_pick").catch((err) => console.warn("cancel failed:", err));
        return;
      }
      invoke("start_color_pick").then((started) => {
        if (!started) return;
        colorPicking = true;
        card.classList.add("picking");
        colorSetCompact(true);
      }).catch((err) => console.warn("colour pick failed:", err));
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) colorCopy(copy.dataset.copy);
  });

  // The wheel over the loupe zooms it, one step per notch.
  specialContent.addEventListener("wheel", (e) => {
    const loupe = e.target.closest(".cc-loupe");
    const card = loupe && loupe.closest(".color-card");
    if (!card || !loupe.classList.contains("has-capture")) return;
    e.preventDefault();
    const now = performance.now();
    if (now - (card._ccWheel || 0) < 90) return;
    card._ccWheel = now;
    colorStepZoom(card, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  window.__TAURI__.event.listen("color-pick", (e) => {
    const frame = e.payload;
    if (frame.pixels && frame.pixels.length) colorLoupe = frame.pixels;
    const card = specialContent.querySelector(".color-card");
    if (!frame.done) {
      // Live preview of the pixel under the cursor without touching the query.
      if (card) {
        const c = parseColorQuery(frame.color);
        if (c) {
          if (!colorUpdateCard(card, c)) card.innerHTML = colorCardHtml(c);
          card.classList.add("picking");
          colorUpdatePill(c);
        }
        colorDrawLoupe(card, colorLoupe);
      }
      return;
    }
    colorPicking = false;
    colorSetCompact(false);
    if (!frame.cancelled && frame.color) {
      const hex = frame.color.toUpperCase();
      colorRemember(hex);
      colorSetQuery(hex);
    } else if (colorShown) {
      renderColorCard(colorShown).classList.remove("picking");
    }
  });

  // Esc cancels picking (instead of hiding the window); Enter copies the HEX.
  document.addEventListener("keydown", (e) => {
    const card = specialContent.querySelector(".color-card");
    if (!card || specialSection.classList.contains("hidden")) return;
    if (e.key === "Escape" && colorPicking) {
      e.preventDefault();
      e.stopImmediatePropagation();
      invoke("cancel_color_pick").catch((err) => console.warn("cancel failed:", err));
    } else if (e.key === "Enter" && !colorPicking && colorShown && e.target === searchInput) {
      e.preventDefault();
      e.stopImmediatePropagation();
      colorCopy(colorToHex(colorShown));
    }
  }, true);
}
// Loaded before main.js, so wait for its globals (specialContent, searchInput, ...).
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", colorInit);
