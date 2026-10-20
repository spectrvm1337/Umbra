// Currency converter widget: "100 usd to rub" -> converted sum, rate, recent pairs and a 7-day chart.
// Rates come from the free fawazahmed0 currency-api (daily, no key), with the pages.dev mirror as fallback.

const FX_CODES = new Set([
  "usd", "eur", "rub", "uah", "byn", "kzt", "gbp", "jpy", "cny", "chf", "pln", "czk", "try", "gel",
  "amd", "azn", "uzs", "kgs", "mdl", "ils", "inr", "aed", "cad", "aud", "nzd", "sek", "nok", "dkk",
  "huf", "ron", "bgn", "krw", "hkd", "sgd", "thb", "brl", "mxn", "zar", "btc", "eth", "usdt",
]);

const FX_ALIASES = {
  yen: "jpy", euro: "eur", dollar: "usd", dollars: "usd",
  "евро": "eur", "доллар": "usd", "долларов": "usd",
  "руб": "rub", "рубль": "rub", "рублей": "rub",
  "грн": "uah", "гривна": "uah", "гривен": "uah",
};

const FX_DEFAULT_PAIRS = ["USD-UAH", "USD-BYN", "JPY-UAH", "EUR-USD", "USD-EUR"];
const FX_RECENT_KEY = "umbra.fx.recent";
const FX_HISTORY_DAYS = 7;
const FX_LATEST_TTL = 30 * 60 * 1000;

// Plot geometry inside the graph panel, taken from the 238x122 Figma frame; the panel stretches with the card.
const FX_CHART = { w: 238, h: 122, left: 13, right: 225, top: 38, bottom: 76, base: 108, cursorTop: 32 };

function fxChartBox(width) {
  const w = Math.max(FX_CHART.w, Math.round(width) || 0);
  return { ...FX_CHART, w, right: w - (FX_CHART.w - FX_CHART.right) };
}

const FX_QUERY_RE = /^(\d[\d\s.,]*?)?\s*([a-zа-яё]+)(\s+(?:to|in|into|в)\s+|\s*(?:->|→|=)\s*|\s+)([a-zа-яё]+)$/i;

function fxResolveCode(word) {
  const w = word.toLowerCase();
  const code = FX_ALIASES[w] || w;
  return FX_CODES.has(code) ? code.toUpperCase() : null;
}

function parseFxAmount(raw) {
  let s = raw.replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (s.includes(",")) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  return /^\d+(\.\d*)?$/.test(s) ? parseFloat(s) : NaN;
}

function parseFxQuery(query) {
  const m = query.trim().match(FX_QUERY_RE);
  if (!m) return null;
  const [, rawAmount, fromWord, sep, toWord] = m;
  if (!rawAmount && !sep.trim()) return null;
  const from = fxResolveCode(fromWord);
  const to = fxResolveCode(toWord);
  if (!from || !to) return null;
  const raw = rawAmount ? rawAmount.trim() : "";
  const amount = raw ? parseFxAmount(raw) : 1;
  if (!Number.isFinite(amount) || amount > 1e15) return null;
  return { amount, raw, from, to };
}

function fxTrimZeros(s) {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function fxDigits(abs) {
  if (abs === 0) return "0";
  if (abs >= 1000) return Math.round(abs).toString();
  if (abs >= 1) return fxTrimZeros(abs.toFixed(2));
  return fxTrimZeros(abs.toPrecision(4));
}

function fxGroup(digits, negative) {
  const [int, frac] = digits.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (negative ? "-" : "") + grouped + (frac ? "." + frac : "");
}

function formatFxNumber(v) {
  return fxGroup(fxDigits(Math.abs(v)), v < 0);
}

// Rates (and their changes) keep trailing zeros: 2 decimals, or 4 significant digits below 1.
function fxRateDecimals(rate) {
  const abs = Math.abs(rate);
  if (abs >= 1 || abs === 0) return 2;
  return abs.toPrecision(4).split(".")[1].length;
}

function formatFxFixed(v, decimals) {
  const digits = Math.abs(v).toFixed(decimals);
  return fxGroup(digits, v < 0 && Number(digits) !== 0);
}

function fxCopyText(v) {
  const abs = Math.abs(v);
  const s = abs >= 1 || abs === 0 ? fxTrimZeros(abs.toFixed(2)) : fxTrimZeros(abs.toPrecision(4));
  return (v < 0 ? "-" : "") + s;
}

function fxChipPairs(current, recent) {
  const out = [];
  for (const p of [...recent, ...FX_DEFAULT_PAIRS]) {
    if (p !== current && !out.includes(p)) out.push(p);
    if (out.length === 3) break;
  }
  return out;
}

function fxShiftDate(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fxRound(n) {
  return Math.round(n * 100) / 100;
}

function fxChartPoints(values, box) {
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const step = (box.right - box.left) / (values.length - 1);
  return values.map((v, i) => ({
    x: fxRound(box.left + i * step),
    y: fxRound(span === 0 ? (box.top + box.bottom) / 2 : box.bottom - ((v - min) / span) * (box.bottom - box.top)),
  }));
}

// Monotone cubic (Fritsch–Carlson) so the curve never overshoots between daily points.
function fxSmoothPath(pts) {
  const n = pts.length;
  let d = `M${pts[0].x} ${pts[0].y}`;
  if (n === 2) return d + ` L${pts[1].x} ${pts[1].y}`;
  const h = pts.map((p, i) => (i < n - 1 ? pts[i + 1].x - p.x : 0));
  const delta = pts.map((p, i) => (i < n - 1 ? (pts[i + 1].y - p.y) / h[i] : 0));
  const m = pts.map((_, i) => {
    if (i === 0) return delta[0];
    if (i === n - 1) return delta[n - 2];
    return delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const c = h[i] / 3;
    d += ` C${fxRound(pts[i].x + c)} ${fxRound(pts[i].y + m[i] * c)} ${fxRound(pts[i + 1].x - c)} ${fxRound(pts[i + 1].y - m[i + 1] * c)} ${pts[i + 1].x} ${pts[i + 1].y}`;
  }
  return d;
}

// ---- data ----

const fxTables = new Map();
const fxBundles = new Map();

function fxJson(r) {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function fxFetchTable(code, ver) {
  const key = `${ver}:${code}`;
  const hit = fxTables.get(key);
  if (hit && (ver !== "latest" || Date.now() - hit.at < FX_LATEST_TTL)) return hit.promise;
  const file = `v1/currencies/${code}.min.json`;
  const promise = fetchWithTimeout(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${ver}/${file}`)
    .then(fxJson)
    .catch(() => fetchWithTimeout(`https://${ver}.currency-api.pages.dev/${file}`).then(fxJson))
    .catch((e) => { fxTables.delete(key); throw e; });
  fxTables.set(key, { at: Date.now(), promise });
  return promise;
}

// Everything the card needs for one source currency: today's table plus the previous days.
async function fxLoadBundle(from) {
  const code = from.toLowerCase();
  const latest = await fxFetchTable(code, "latest");
  const dates = [];
  for (let i = FX_HISTORY_DAYS - 1; i >= 1; i--) dates.push(fxShiftDate(latest.date, -i));
  const settled = await Promise.allSettled(dates.map((d) => fxFetchTable(code, d)));
  const history = settled
    .filter((s) => s.status === "fulfilled")
    .map((s) => ({ date: s.value.date, rates: s.value[code] }));
  history.push({ date: latest.date, rates: latest[code] });
  const bundle = { at: Date.now(), date: latest.date, rates: latest[code], history };
  fxBundles.set(from, bundle);
  return bundle;
}

function fxCachedBundle(from) {
  const b = fxBundles.get(from);
  return b && Date.now() - b.at < FX_LATEST_TTL ? b : null;
}

function fxReadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(FX_RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && /^[A-Z]{3,4}-[A-Z]{3,4}$/.test(p)) : [];
  } catch {
    return [];
  }
}

function fxRememberPair(pair) {
  try {
    const list = [pair, ...fxReadRecent().filter((p) => p !== pair)].slice(0, 4);
    localStorage.setItem(FX_RECENT_KEY, JSON.stringify(list));
  } catch {}
}

// ---- rendering ----

let fxRenderId = 0;

const FX_ARROW_SVG = `<svg class="fx-arrow" width="17" height="14.7279" viewBox="0 0 17 14.7279" fill="none" aria-hidden="true"><path d="M1 6.36396C0.447715 6.36396 0 6.81168 0 7.36396C0 7.91625 0.447715 8.36396 1 8.36396V7.36396V6.36396ZM16.7071 8.07107C17.0976 7.68054 17.0976 7.04738 16.7071 6.65685L10.3431 0.292893C9.95262 -0.097631 9.31946 -0.097631 8.92893 0.292893C8.53841 0.683418 8.53841 1.31658 8.92893 1.70711L14.5858 7.36396L8.92893 13.0208C8.53841 13.4113 8.53841 14.0445 8.92893 14.435C9.31946 14.8256 9.95262 14.8256 10.3431 14.435L16.7071 8.07107ZM1 7.36396V8.36396H16V7.36396V6.36396H1V7.36396Z" fill="currentColor"/></svg>`;

function fxTrendSvg(dir, x, y) {
  const flip = dir === "up" ? ` transform="rotate(180 4 4.375)"` : "";
  return `<svg x="${x}" y="${y}" width="8" height="8.75" viewBox="0 0 8.00001 8.75" fill="none" overflow="visible"><path${flip} d="M4 1V7.75M7 4.9375L4 7.75L1 4.9375" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Text comes from the language chosen in settings (i18n.js); the English strings are the fallback.
function fxT(key, fallback, params) {
  return window.i18n ? window.i18n.t(key, params) : fallback;
}

function fxFormatDate(iso) {
  const lang = window.i18n ? window.i18n.getLang() : undefined;
  return new Date(iso + "T00:00:00").toLocaleDateString(lang, { day: "numeric", month: "short" });
}

function fxSumHtml(p, result, placeholder = "…") {
  const left = formatFxNumber(p.amount);
  const right = result == null ? placeholder : formatFxNumber(result);
  return `
    <div class="fx-sum"${result == null ? "" : ` title="${escapeHtml(fxT("fxCopyTip", "Click or press Enter to copy"))}"`}>
      <span class="fx-part"><span class="fx-val">${left}</span><span class="fx-code">${p.from}</span></span>
      ${FX_ARROW_SVG}
      <span class="fx-part"><span class="fx-val${result == null ? " fx-pending" : ""}">${right}</span><span class="fx-code">${p.to}</span></span>
    </div>`;
}

function fxChartHtml(series, C) {
  const pts = fxChartPoints(series.map((s) => s.value), C);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const grid = pts
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i > 0 && i < pts.length - 1 && i % 2 === 0)
    .map(({ p, i }) => `<line class="fx-grid" data-i="${i}" x1="${p.x}" y1="${p.y}" x2="${p.x}" y2="${C.base}"/>`)
    .join("");
  const dec = fxRateDecimals(series[series.length - 1].value);
  const delta = Number((series[series.length - 1].value - series[0].value).toFixed(dec));
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const deltaText = (delta > 0 ? "+" : "") + formatFxFixed(delta, dec);
  const days = series.length;
  return `
    <svg class="fx-chart" width="${C.w}" height="${C.h}" viewBox="0 0 ${C.w} ${C.h}">
      <path class="fx-grid fx-edge" d="M${C.left} ${first.y}V${C.base}H${C.right}V${last.y}"/>
      ${grid}
      <path class="fx-line" d="${fxSmoothPath(pts)}"/>
      <circle class="fx-dot" cx="${last.x}" cy="${last.y}" r="3"/>
      <g class="fx-cursor" visibility="hidden">
        <line class="fx-cursor-line" x1="0" x2="0" y1="${C.cursorTop}" y2="${C.base}"/>
        <circle class="fx-dot" r="3"/>
        <g class="fx-tip-g">
          <rect class="fx-tip-bg" height="20" rx="6"/>
          <text class="fx-tip" x="8" y="14"><tspan class="fx-tip-val"></tspan><tspan class="fx-tip-date" dx="6"></tspan></text>
        </g>
      </g>
      <g class="fx-change fx-change--${dir}">
        <title>${escapeHtml(fxT("fxDayChange", "{n}-day change", { n: days }))}</title>
        <text class="fx-change-text" x="${C.w - (dir === "flat" ? 15 : 27)}" y="19" text-anchor="end">${deltaText}</text>
        ${dir === "flat" ? "" : fxTrendSvg(dir, C.w - 23, 12)}
      </g>
    </svg>`;
}

// Motion follows the "move" switch in settings.
function fxMotionOn() {
  return document.documentElement.dataset.animMove !== "off";
}

// Puts the curve, its frame and the grid on a given set of points; the chart is
// morphed from one shape to the next by feeding this a point set per frame.
function fxApplyShape(card, svg, pts, C) {
  const first = pts[0];
  const last = pts[pts.length - 1];
  svg.querySelector(".fx-edge").setAttribute("d", `M${C.left} ${first.y}V${C.base}H${C.right}V${last.y}`);
  svg.querySelector(".fx-line").setAttribute("d", fxSmoothPath(pts));
  svg.querySelectorAll("line.fx-grid").forEach((l) => l.setAttribute("y1", pts[l.dataset.i].y));
  svg.querySelector(":scope > .fx-dot").setAttribute("cy", last.y);
  card._fxShown = { pts, w: C.w };
}

// Brings a previous set of points to the length of the new one, so a 7-day and a
// 3-day history can still be morphed into each other.
function fxResample(from, to) {
  if (from.length === to.length) return from;
  return to.map((p, k) => {
    const t = (k / (to.length - 1)) * (from.length - 1);
    const i = Math.min(from.length - 2, Math.floor(t));
    return { x: p.x, y: from[i].y + (from[i + 1].y - from[i].y) * (t - i) };
  });
}

function fxDrawChart(card, series, from) {
  cancelAnimationFrame(card._fxRaf);
  const graph = card.querySelector(".fx-graph");
  const C = fxChartBox(graph.clientWidth);
  graph.innerHTML = fxChartHtml(series, C);
  const svg = graph.querySelector(".fx-chart");
  const pts = fxChartPoints(series.map((s) => s.value), C);
  card._fxShown = { pts, w: C.w };
  if (from && from.w === C.w && fxMotionOn()) {
    const start = fxResample(from.pts, pts);
    fxApplyShape(card, svg, start, C);
    svg.classList.add("fx-morph");
    const travel = Math.max(...pts.map((p, i) => Math.abs(p.y - start[i].y))) / (C.bottom - C.top);
    const dur = 450 + 550 * Math.min(1, travel);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      fxApplyShape(card, svg, pts.map((p, i) => ({ x: p.x, y: start[i].y + (p.y - start[i].y) * e })), C);
      if (k < 1) card._fxRaf = requestAnimationFrame(step);
    };
    card._fxRaf = requestAnimationFrame(step);
  }
  const decimals = fxRateDecimals(series[series.length - 1].value);
  const cursor = svg.querySelector(".fx-cursor");
  const line = cursor.querySelector("line");
  const dot = cursor.querySelector("circle");
  const tipG = cursor.querySelector(".fx-tip-g");
  const tipBg = tipG.querySelector("rect");
  const tipText = tipG.querySelector("text");
  const tipVal = tipG.querySelector(".fx-tip-val");
  const tipDate = tipG.querySelector(".fx-tip-date");
  const change = svg.querySelector(".fx-change");
  // The change figure sits on a soft tinted pill of its own colour.
  const cb = change.getBBox();
  if (cb.width) {
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("class", "fx-change-bg");
    bg.setAttribute("x", cb.x - 7);
    bg.setAttribute("y", cb.y - 3);
    bg.setAttribute("width", cb.width + 14);
    bg.setAttribute("height", cb.height + 6);
    bg.setAttribute("rx", 7);
    change.insertBefore(bg, change.firstChild);
  }
  const changeLeft = () => {
    const box = change.getBBox();
    return box.width ? box.x : C.w;
  };
  let shown = false;

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * C.w;
    let idx = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - x) < Math.abs(pts[idx].x - x)) idx = i;
    const p = pts[idx];
    tipVal.textContent = formatFxFixed(series[idx].value, decimals);
    tipDate.textContent = fxFormatDate(series[idx].date);
    const bw = Math.ceil(tipText.getBBox().width) + 16;
    tipBg.setAttribute("width", bw);
    // Centred on the cursor, kept inside the panel and clear of the change pill.
    const room = Math.min(C.w - 6, changeLeft() - 8) - bw;
    const tx = Math.max(6, Math.min(p.x - bw / 2, room));
    if (!shown) {
      svg.classList.add("fx-snap");
      cursor.setAttribute("visibility", "visible");
    }
    line.style.transform = `translateX(${p.x}px)`;
    dot.style.transform = `translate(${p.x}px, ${p.y}px)`;
    tipG.style.transform = `translate(${tx}px, 6px)`;
    if (!shown) {
      shown = true;
      svg.getBoundingClientRect();
      svg.classList.remove("fx-snap");
    }
  });
  svg.addEventListener("mouseleave", () => {
    shown = false;
    cursor.setAttribute("visibility", "hidden");
  });
}

// Shrink the big numbers until the whole "amount → result" line fits next to the graph.
function fxFitSum(card) {
  const sum = card.querySelector(".fx-sum");
  if (!sum || !sum.clientWidth) return;
  for (let size = 36; size >= 16; size -= 2) {
    sum.style.fontSize = `${size}px`;
    if (sum.scrollWidth <= sum.clientWidth) break;
  }
}

function fxCardHtml(p, state) {
  const pair = `${p.from}-${p.to}`;
  const chips = fxChipPairs(pair, fxReadRecent())
    .map((c) => `<button class="fx-chip" data-pair="${c}">${c}</button>`)
    .join("");

  if (state.error) {
    return `
      <div class="fx-main">
        ${fxSumHtml(p, null, "—")}
        <div class="fx-rate fx-muted">${escapeHtml(state.error)}</div>
        <div class="fx-chips">${chips}</div>
      </div>`;
  }

  const rate = state.rate;
  const graph = !state.series
    ? `<div class="fx-graph"></div>`
    : state.series.length < 2
      ? `<div class="fx-graph fx-graph--empty"><span class="fx-muted">${escapeHtml(fxT("fxNoHistory", "No history"))}</span></div>`
      : `<div class="fx-graph"></div>`;

  return `
    <div class="fx-main">
      ${fxSumHtml(p, rate == null ? null : p.amount * rate)}
      <div class="fx-rate">1 ${p.from} = ${rate == null ? "…" : formatFxFixed(rate, fxRateDecimals(rate))} ${p.to}</div>
      <div class="fx-chips">${chips}</div>
    </div>
    ${graph}`;
}

function fxStateFromBundle(p, bundle) {
  const from = p.from.toLowerCase();
  const to = p.to.toLowerCase();
  const rate = from === to ? 1 : bundle.rates[to];
  if (typeof rate !== "number") return { error: fxT("fxNoRate", `No rate for ${p.to}`, { code: p.to }) };
  const series = bundle.history
    .map((h) => ({ date: h.date, value: from === to ? 1 : h.rates && h.rates[to] }))
    .filter((s) => typeof s.value === "number");
  return { rate, series };
}

// The window can be resized (and the dock widens it), so refit the sum and redraw the chart whenever the card's width changes.
let fxResizeObs = null;
let fxObserved = null;
function fxWatchCard(card) {
  if (typeof ResizeObserver === "undefined" || fxObserved === card) return;
  if (fxResizeObs) fxResizeObs.disconnect();
  let lastW = 0;
  let lastGraphW = 0;
  fxResizeObs = new ResizeObserver(() => {
    const graph = card.querySelector(".fx-graph");
    const w = card.clientWidth;
    const gw = graph ? graph.clientWidth : 0;
    if (w === lastW && gw === lastGraphW) return;
    lastW = w;
    lastGraphW = gw;
    fxFitSum(card);
    if (card._fxSeries && gw) fxDrawChart(card, card._fxSeries);
  });
  fxResizeObs.observe(card);
  fxObserved = card;
}

// A number that runs from what is on screen to its new value instead of jumping.
function fxCountTo(card, key, el, to, format) {
  cancelAnimationFrame(card["_fxN" + key]);
  const from = typeof el._fxV === "number" ? el._fxV : to;
  if (!fxMotionOn() || from === to) {
    el._fxV = to;
    el.textContent = format(to);
    return;
  }
  el.textContent = format(from);
  // Between 0.45s and 1s, longer the further the number has to travel.
  const rel = Math.abs(to - from) / Math.max(Math.abs(to), Math.abs(from), 1e-9);
  const dur = 450 + 550 * Math.sqrt(Math.min(1, rel));
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    el._fxV = k < 1 ? from + (to - from) * e : to;
    el.textContent = format(el._fxV);
    if (k < 1) card["_fxN" + key] = requestAnimationFrame(step);
  };
  card["_fxN" + key] = requestAnimationFrame(step);
}

// Text that changes under the eye eases in rather than being swapped.
function fxSwap(el) {
  if (!fxMotionOn()) return;
  el.classList.remove("fx-swap");
  void el.offsetWidth;
  el.classList.add("fx-swap");
}

function fxRateText(p, rate, decimals) {
  return `1 ${p.from} = ${formatFxFixed(rate, decimals)} ${p.to}`;
}

function fxUpdateChips(card, p) {
  const wrap = card.querySelector(".fx-chips");
  const pairs = fxChipPairs(`${p.from}-${p.to}`, fxReadRecent());
  const buttons = [...wrap.children];
  pairs.forEach((pair, i) => {
    let b = buttons[i];
    if (!b) {
      b = document.createElement("button");
      b.className = "fx-chip";
      wrap.appendChild(b);
    } else if (b.dataset.pair === pair) return;
    b.dataset.pair = pair;
    b.textContent = pair;
    fxSwap(b);
  });
  buttons.slice(pairs.length).forEach((b) => b.remove());
}

// The numbers, codes, chips and graph of the card that is already on screen
// change in place, so a new amount or pair eases over instead of the whole card
// being thrown away and drawn again.
function fxUpdateCard(card, p, state) {
  const result = p.amount * state.rate;
  const vals = card.querySelectorAll(".fx-val");
  const codes = card.querySelectorAll(".fx-code");
  card._fxP = p;
  card._fxResult = result;
  [p.from, p.to].forEach((c, i) => {
    if (codes[i].textContent !== c) {
      codes[i].textContent = c;
      fxSwap(codes[i]);
    }
  });
  // Fit the line for the final numbers first; the count then runs inside that size.
  vals[0].textContent = formatFxNumber(p.amount);
  vals[1].textContent = formatFxNumber(result);
  fxFitSum(card);
  vals[1].classList.remove("fx-pending");
  fxCountTo(card, "A", vals[0], p.amount, formatFxNumber);
  fxCountTo(card, "B", vals[1], result, formatFxNumber);
  const decimals = fxRateDecimals(state.rate);
  const rateEl = card.querySelector(".fx-rate");
  rateEl.classList.remove("fx-muted");
  fxCountTo(card, "R", rateEl, state.rate, (v) => fxRateText(p, v, decimals));
  fxUpdateChips(card, p);
}

function renderFxCard(p, state) {
  let card = specialContent.querySelector(".fx-card");
  if (!card) {
    specialContent.innerHTML = `<div class="special-card fx-card"></div>`;
    card = specialContent.querySelector(".fx-card");
    // One listener for the card's whole life: its contents are updated in place,
    // so it must read the current query and result, not the ones it was drawn with.
    card.addEventListener("click", (e) => {
      const chip = e.target.closest(".fx-chip");
      if (chip) {
        const [from, to] = chip.dataset.pair.toLowerCase().split("-");
        const raw = card._fxP && card._fxP.raw;
        searchInput.value = `${raw ? raw + " " : ""}${from} to ${to}`;
        searchInput.dispatchEvent(new Event("input"));
        searchInput.focus();
      } else if (e.target.closest(".fx-sum[title]") && card._fxResult != null) {
        copyPath(fxCopyText(card._fxResult));
      }
    });
  }
  card.classList.remove("fx-loading");

  const chartNow = !!(state.series && state.series.length >= 2);
  const inPlace = card._fxOk && state.rate != null && !state.error && card._fxHasChart === chartNow
    && card.querySelector(".fx-sum[title]");
  const result = state.rate == null ? null : p.amount * state.rate;

  if (inPlace) {
    fxUpdateCard(card, p, state);
    card._fxSeries = chartNow ? state.series : null;
    if (chartNow) fxDrawChart(card, state.series, card._fxShown);
  } else {
    cancelAnimationFrame(card._fxRaf);
    ["A", "B", "R"].forEach((k) => cancelAnimationFrame(card["_fxN" + k]));
    card.innerHTML = fxCardHtml(p, state);
    fxFitSum(card);
    if (document.fonts) document.fonts.ready.then(() => fxFitSum(card));
    card._fxP = p;
    card._fxResult = result;
    card._fxOk = state.rate != null && !state.error;
    card._fxHasChart = chartNow;
    card._fxShown = null;
    const vals = card.querySelectorAll(".fx-val");
    if (result != null) {
      vals[0]._fxV = p.amount;
      vals[1]._fxV = result;
      const rateEl = card.querySelector(".fx-rate");
      if (rateEl) rateEl._fxV = state.rate;
    }
    card._fxSeries = chartNow ? state.series : null;
    if (chartNow) fxDrawChart(card, state.series);
  }

  selectableItems = [{
    name: "", path: result == null ? "" : fxCopyText(result), kind: "copy",
    icon_data: null, pinned: false,
  }];
  selectedIndex = 0;
  fxWatchCard(card);
}

function handleCurrencyCommand(query) {
  const p = parseFxQuery(query);
  if (!p) return false;

  specialSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  pinsSection.classList.add("hidden");

  const id = ++fxRenderId;
  const cached = fxCachedBundle(p.from);
  if (cached) {
    const state = fxStateFromBundle(p, cached);
    renderFxCard(p, state);
    if (!state.error) fxRememberPair(`${p.from}-${p.to}`);
    return true;
  }

  const live = specialContent.querySelector(".fx-card");
  if (live && live._fxOk) {
    // Keep the card that is showing, slightly dimmed, until the new rates arrive.
    live.classList.add("fx-loading");
    selectableItems = [{ name: "", path: "", kind: "copy", icon_data: null, pinned: false }];
    selectedIndex = 0;
  } else {
    renderFxCard(p, {});
  }
  // The user may have typed something else (or opened settings) while rates were loading.
  const stale = () => id !== fxRenderId || lastQuery !== query || specialSection.classList.contains("hidden");
  fxLoadBundle(p.from)
    .then((bundle) => {
      if (stale()) return;
      const state = fxStateFromBundle(p, bundle);
      renderFxCard(p, state);
      if (!state.error) fxRememberPair(`${p.from}-${p.to}`);
    })
    .catch(() => {
      if (stale()) return;
      renderFxCard(p, { error: fxT("fxLoadFail", "Couldn't load rates") });
    });
  return true;
}
