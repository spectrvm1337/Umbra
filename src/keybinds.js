// Keybinds: the keys Umbra answers to, in one place. Each action has a default; what the user
// changed is kept in the config (`keybinds`, by action id) and read through kbMatches() by the
// handlers, so none of them hard-codes a combination. The Keybinds panel beside the window lists the
// actions and records a new combination for one; the global hotkey (which is registered in Rust and
// has its own recording in Settings) is shown there too and records through that same row.
//
// A combination is written the way the global hotkey is: modifiers in the order Ctrl, Alt, Shift,
// Super, then the key -- a letter, a digit, F1-F12, Space, Enter or an arrow. Keys are matched by
// code, so a Russian layout reaches the same Ctrl+P as an English one.

// The global hotkey, registered in Rust; the row for it offers a reset once it is anything else.
const KB_DEFAULT_HOTKEY = "Alt+Space";
const KB_ACTIONS = [
  { id: "previewHold", def: "Shift+Space", label: "kbPreviewHold" },
  { id: "reveal", def: "Ctrl+Enter", label: "kbReveal" },
  { id: "admin", def: "Ctrl+Shift+Enter", label: "kbAdmin" },
  { id: "pin", def: "Ctrl+P", label: "kbPin" },
  { id: "historyPrev", def: "Alt+ArrowUp", label: "kbHistoryPrev" },
  { id: "historyNext", def: "Alt+ArrowDown", label: "kbHistoryNext" },
];
// Shown in the panel but not changeable: they are the list's own keys.
const KB_FIXED = [
  ["kbFixedNumbers", "Ctrl+1–9"],
  ["kbFixedComplete", "Tab"],
  ["kbFixedBack", "Esc"],
];
// Combinations the page needs for itself: copy, paste, undo and the row numbers.
const KB_RESERVED = new Set(["Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y"]);
const KB_GLYPH = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

let kbMap = {};
let kbRecording = null;
let kbCard = null;
let kbChain = Promise.resolve();

const kbT = (key, vars) => window.i18n.t(key, vars);
const kbAction = (id) => KB_ACTIONS.find((a) => a.id === id);
const kbCombo = (id) => kbMap[id] || (kbAction(id) || {}).def || "";

// The base key of an event by its code, or null for a key combinations are not made from.
function kbBaseOf(e) {
  const code = e.code || "";
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit([0-9])$/))) return m[1];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (code === "Space") return "Space";
  if (code === "Enter" || code === "NumpadEnter") return "Enter";
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) return code;
  return null;
}
function kbMods(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return mods;
}
// The combination an event is, or "" while only modifiers are down.
function kbEventCombo(e) {
  const base = kbBaseOf(e);
  return base ? [...kbMods(e), base].join("+") : "";
}
function kbMatches(e, id) {
  const want = kbCombo(id);
  return !!want && kbEventCombo(e) === want;
}
// Whether this key's base is the one an action ends on (a held action repeats it as typing).
function kbIsBase(e, id) {
  const parts = kbCombo(id).split("+");
  return !!parts.length && kbBaseOf(e) === parts[parts.length - 1];
}
// A key coming up ends a held action when it is one of the keys of its combination.
function kbReleases(e, id) {
  const parts = kbCombo(id).split("+");
  const base = parts.pop();
  if (kbBaseOf(e) === base) return true;
  const down = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Super: e.metaKey };
  return parts.some((m) => !down[m]);
}
function kbDisplay(combo) {
  return String(combo || "").split("+").map((k) => KB_GLYPH[k] || k).join("+");
}
function kbKeysHtml(combo, live) {
  return String(combo || "")
    .split("+")
    .filter(Boolean)
    .map((k) => '<kbd class="su-key' + (live ? " live" : "") + '">' + escapeHtml(KB_GLYPH[k] || k) + "</kbd>")
    .join('<span class="su-plus">+</span>');
}

// Why a combination cannot be used, as a message, or "" when it can.
function kbProblem(id, combo) {
  const parts = combo.split("+");
  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const fkey = /^F\d+$/.test(base);
  if (!mods.length && !fkey) return kbT("kbErrModifier");
  // Shift alone with a letter or a digit is just a capital letter.
  if (mods.length === 1 && mods[0] === "Shift" && /^[A-Z0-9]$/.test(base)) return kbT("kbErrTyping");
  if (KB_RESERVED.has(combo) || (mods.length === 1 && mods[0] === "Ctrl" && /^[1-9]$/.test(base))) return kbT("kbErrReserved");
  for (const a of KB_ACTIONS) {
    if (a.id !== id && kbCombo(a.id) === combo) return kbT("kbErrTaken", { name: kbT(a.label) });
  }
  if (String(currentHotkey).toLowerCase() === combo.toLowerCase()) return kbT("kbErrTaken", { name: kbT("kbGlobal") });
  return "";
}

function kbSave() {
  const changed = {};
  for (const a of KB_ACTIONS) if (kbMap[a.id] && kbMap[a.id] !== a.def) changed[a.id] = kbMap[a.id];
  kbMap = changed;
  kbChain = kbChain.then(() => invoke("set_keybinds", { map: changed })).catch((err) => console.warn("keybinds save failed:", err));
  kbPaint();
}

function kbRowHtml(id, label, extra) {
  return (
    '<div class="settings-row interactive kb-row" data-kb="' + id + '"><span class="settings-label">' + escapeHtml(label) + "</span>" +
    '<span class="settings-value kb-keys"></span>' + (extra || "") + "</div>"
  );
}

function kbBuild() {
  const reset = '<button class="kb-reset" type="button" tabindex="-1" data-tip="' + escapeHtml(kbT("kbReset")) + '"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg></button>';
  kbCard.innerHTML =
    kbRowHtml("hotkey", kbT("kbGlobal"), reset) +
    KB_ACTIONS.map((a) => kbRowHtml(a.id, kbT(a.label), reset)).join("") +
    KB_FIXED.map(([label, keys]) =>
      '<div class="settings-row kb-fixed"><span class="settings-label">' + escapeHtml(kbT(label)) + '</span><span class="settings-value kb-keys">' +
      kbKeysHtml(keys) + "</span></div>"
    ).join("");
  kbPaint();
}

// Draws every row from the current map; the row being recorded keeps its own display.
function kbPaint() {
  if (!kbCard) return;
  for (const a of KB_ACTIONS) {
    const row = kbCard.querySelector('[data-kb="' + a.id + '"]');
    if (!row) continue;
    row.classList.toggle("changed", !!kbMap[a.id] && kbMap[a.id] !== a.def);
    if (kbRecording !== a.id) row.querySelector(".kb-keys").innerHTML = kbKeysHtml(kbCombo(a.id));
  }
  kbPaintGlobal();
  kbPaintContext();
}
function kbPaintGlobal() {
  const row = kbCard && kbCard.querySelector('[data-kb="hotkey"]');
  if (!row) return;
  row.classList.toggle("capturing", settingHotkeyRow.classList.contains("capturing"));
  row.classList.toggle("changed", String(currentHotkey).toLowerCase() !== KB_DEFAULT_HOTKEY.toLowerCase());
  row.querySelector(".kb-keys").innerHTML = settingHotkeyValue.innerHTML;
}
// The right-click menu names the keys of what it offers.
function kbPaintContext() {
  const set = (action, combo) => {
    const el = document.querySelector('.ctx-item[data-action="' + action + '"] .ctx-item-shortcut');
    if (el) el.textContent = kbDisplay(combo);
  };
  set("admin", kbCombo("admin"));
  set("directory", kbCombo("reveal"));
  set("pin", kbCombo("pin"));
}

function kbHint(row, text, bad) {
  row.querySelector(".kb-keys").innerHTML = '<span class="hk-hint' + (bad ? " bad" : "") + '">' + escapeHtml(text) + "</span>";
}

function kbStop() {
  if (!kbRecording) return;
  const row = kbCard.querySelector('[data-kb="' + kbRecording + '"]');
  kbRecording = null;
  if (row) row.classList.remove("capturing");
  kbPaint();
}
function kbStart(id) {
  if (kbRecording === id) return;
  kbStop();
  if (hotkeyCapturing) endHotkeyCapture();
  kbRecording = id;
  const row = kbCard.querySelector('[data-kb="' + id + '"]');
  row.classList.add("capturing");
  kbHint(row, kbT("pressKeys"));
  setSettingsStatus("");
}
function kbHeld(e) {
  const row = kbCard.querySelector('[data-kb="' + kbRecording + '"]');
  const held = kbMods(e);
  if (!held.length) {
    kbHint(row, kbT("pressKeys"));
    return;
  }
  row.querySelector(".kb-keys").innerHTML = kbKeysHtml(held.join("+"), true) + '<span class="su-plus">+</span><kbd class="su-key su-key-wait">…</kbd>';
}

function kbApply(id, combo) {
  const row = kbCard.querySelector('[data-kb="' + id + '"]');
  kbMap[id] = combo;
  kbRecording = null;
  row.classList.remove("capturing");
  kbSave();
  const keys = row.querySelector(".kb-keys");
  keys.classList.remove("applied");
  void keys.offsetWidth;
  keys.classList.add("applied");
}

async function kbInit() {
  kbCard = document.getElementById("keys-card");
  if (!kbCard) return;
  try {
    kbMap = (await invoke("get_keybinds")) || {};
  } catch {
    kbMap = {};
  }
  kbBuild();
  window.addEventListener("language-changed", kbBuild);
  // The global hotkey row records through Settings' own row; this one only shows what that shows.
  new MutationObserver(kbPaintGlobal).observe(settingHotkeyValue, { childList: true });
  new MutationObserver(kbPaintGlobal).observe(settingHotkeyRow, { attributes: true, attributeFilter: ["class"] });

  kbCard.addEventListener("click", (e) => {
    const reset = e.target.closest(".kb-reset");
    const row = e.target.closest("[data-kb]");
    if (!row) return;
    const id = row.dataset.kb;
    if (reset) {
      e.stopPropagation();
      kbStop();
      if (id === "hotkey") {
        applyHotkey(KB_DEFAULT_HOTKEY);
        return;
      }
      delete kbMap[id];
      kbSave();
      return;
    }
    if (id === "hotkey") {
      kbStop();
      settingHotkeyRow.click();
    } else {
      kbStart(id);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (kbRecording && !(e.target instanceof Element && e.target.closest('[data-kb="' + kbRecording + '"]'))) kbStop();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!kbRecording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      kbStop();
      return;
    }
    const row = kbCard.querySelector('[data-kb="' + kbRecording + '"]');
    const combo = kbEventCombo(e);
    if (!combo) {
      // A modifier on its own, or a key combinations are not made of.
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) kbHeld(e);
      else {
        kbHint(row, kbT("kbErrKey"), true);
        setTimeout(() => { if (kbRecording) kbHeld(e); }, 1600);
      }
      return;
    }
    const problem = kbProblem(kbRecording, combo);
    if (problem) {
      setSettingsStatus(problem, true);
      kbHint(row, problem, true);
      setTimeout(() => { if (kbRecording) kbHint(row, kbT("pressKeys")); }, 1800);
      return;
    }
    setSettingsStatus("");
    kbApply(kbRecording, combo);
  }, true);
  // Letting go of a modifier shows what is still held; a key coming up must not wipe a message.
  document.addEventListener("keyup", (e) => {
    if (kbRecording && ["Control", "Alt", "Shift", "Meta"].includes(e.key)) kbHeld(e);
  }, true);
}
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", kbInit);
