// Colour widget: "#c83939" or "rgb(200, 57, 57)" -> swatch with shades, RGB / HSL,
// recent colours, and a screen eyedropper whose loupe shows the pixels under the cursor
// (the capture runs in Rust, src-tauri/src/color_pick.rs).

const COLOR_HISTORY_KEY = "umbra.color.history";
const COLOR_HISTORY_MAX = 7;
const COLOR_REMEMBER_MS = 1000;
const COLOR_GRID = 15;

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
      <div class="cc-swatch" style="background:${hex}" data-copy="${hex}" title="Click or press Enter to copy ${hex}"></div>
    </div>
    <div class="cc-info">
      <div class="cc-field" data-copy="${colorToRgb(c)}" title="Copy"><div class="cc-label">RGB</div><div class="cc-value">${colorToRgb(c)}</div></div>
      <div class="cc-field" data-copy="hsl(${colorToHsl(c)})" title="Copy"><div class="cc-label">HSL</div><div class="cc-value">${colorToHsl(c)}</div></div>
      <div class="cc-field"><div class="cc-label">History</div><div class="cc-history">${history}</div></div>
    </div>
    <div class="cc-loupe">
      <canvas class="cc-pixels" width="${COLOR_GRID}" height="${COLOR_GRID}"></canvas>
      <canvas class="cc-skeleton"></canvas>
      ${COLOR_PIN_SVG}
      <button class="cc-dropper" title="Pick a colour from the screen (Esc or right-click cancels)">${COLOR_DROPPER_SVG}</button>
    </div>`;
}

// Eyedropper frames arrive ~30 times a second: change the values in place instead of
// rebuilding the card (and its loupe canvas) on every frame. False if the card has not
// been built yet.
function colorUpdateCard(card, c) {
  const swatch = card.querySelector(".cc-swatch");
  const shades = card.querySelectorAll(".cc-shade");
  const [rgb, hsl] = card.querySelectorAll(".cc-info .cc-field[data-copy]");
  if (!swatch || shades.length !== 3 || !rgb || !hsl) return false;
  const hex = colorToHex(c);
  swatch.style.background = hex;
  swatch.dataset.copy = hex;
  swatch.title = `Click or press Enter to copy ${hex}`;
  [0.25, 0, -0.25].forEach((k, i) => {
    const shade = colorToHex(colorShade(c, k));
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
// captured pixels, drawn as dim dots with two slow blobs of accent colour drifting
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
  const styles = getComputedStyle(card);
  const accent = styles.getPropertyValue("--accent").trim() || "#e07a3a";
  const dim = styles.getPropertyValue("--text-dim").trim() || "#737373";
  const step = Math.min(w, h) / COLOR_GRID;
  const blob = (t, a, b, phase) => [0.5 + 0.38 * Math.sin(t * a + phase), 0.5 + 0.38 * Math.cos(t * b + phase * 1.7)];
  const start = performance.now();
  const frame = (now) => {
    if (!canvas.isConnected || loupe.classList.contains("has-capture")) {
      delete canvas.dataset.running;
      return;
    }
    // Looping is permanent, so the only thing that stills this is the system
    // asking for reduced motion.
    const t = colorReduceMotion.matches ? 2 : (now - start) / 1000;
    const blobs = [blob(t, 0.55, 0.42, 0), blob(t, 0.37, 0.61, 2.4)];
    ctx.clearRect(0, 0, w, h);
    for (let row = 0; row < COLOR_GRID; row++) {
      for (let col = 0; col < COLOR_GRID; col++) {
        const u = (col + 0.5) / COLOR_GRID;
        const v = (row + 0.5) / COLOR_GRID;
        let glow = 0;
        for (const [bx, by] of blobs) glow = Math.max(glow, Math.exp(-((u - bx) ** 2 + (v - by) ** 2) / 0.06));
        const x = (col + 0.5) * step + (w - step * COLOR_GRID) / 2;
        const y = (row + 0.5) * step + (h - step * COLOR_GRID) / 2;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = dim;
        ctx.beginPath();
        ctx.arc(x, y, 0.9, 0, Math.PI * 2);
        ctx.fill();
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

function renderColorCard(c) {
  let card = specialContent.querySelector(".color-card");
  if (!card) {
    specialContent.innerHTML = `<div class="special-card color-card"></div>`;
    card = specialContent.querySelector(".color-card");
  }
  card.innerHTML = colorCardHtml(c, colorShadeBase || c);
  card.classList.toggle("picking", colorPicking);
  colorDrawLoupe(card, colorLoupe);
  colorStartSkeleton(card);
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
      }).catch((err) => console.warn("colour pick failed:", err));
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) colorCopy(copy.dataset.copy);
  });

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
        }
        colorDrawLoupe(card, colorLoupe);
      }
      return;
    }
    colorPicking = false;
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
