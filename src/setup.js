// First-run setup: a few screens in the window itself -- language and theme, autostart and the
// hotkey, what to index, one look at how a result opens up -- shown on a fresh install, again when
// it was closed half way, and on demand from Settings.
//
// Nothing here has a store of its own. Each choice goes through what Settings already uses (the
// language and theme code in main.js, the autostart and hotkey commands, the index switches), and
// the screens are drawn again from those values, so running the setup a second time starts from
// what is set now rather than from defaults.

const SU_STEPS = ["welcome", "look", "startup", "index", "tour", "done"];
const SU_LANGS = [["en", "English"], ["ru", "Русский"], ["de", "Deutsch"], ["ja", "日本語"]];
const SU_ICON = {
  look: '<path d="M12 21a9 9 0 0 1 0-18c4.97 0 9 3.58 9 8 0 2.2-1.8 3-4 3h-2a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 12 21m-4-8.5v.01m1-4v.01m4-1.51v.01m4 2.5v.01"/>',
  startup: '<path d="M12 3v9m6.4-5.4a9 9 0 1 1-12.8 0"/>',
  keys: '<path d="M2 8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm4 2v.01m4-.01v.01m4-.01v.01m4-.01v.01M6 14v.01M18 14v.01M10 14l4 .01"/>',
  index: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0m18 11l-6-6"/>',
  quick: '<path d="M13 3v7h6l-8 11v-7H5z"/>',
  full: '<path d="m12 3-9 5 9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5"/>',
  tour: '<path d="M4 5h16v4H4zm0 6h16v8H4zm4 3h8m-8 2h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};

let suEl = null;
let suStage = null;
let suDots = null;
let suBack = null;
let suNext = null;
let suDefaults = null;
let suStep = 0;
let suActive = false;
let suFirst = true;
let suHookOk = true;
let suPoll = 0;
const suState = { autostart: true };

const suT = (key, vars) => window.i18n.t(key, vars);
const suIco = (name, size) =>
  '<svg class="ico su-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" ' +
  'stroke-linejoin="round" width="' + (size || 24) + '" height="' + (size || 24) + '">' + SU_ICON[name] + "</svg>";

const SU_LOGO =
  '<svg class="su-logo" viewBox="0 0 64 64" width="72" height="72" aria-hidden="true">' +
  '<circle cx="32" cy="32" r="24" fill="currentColor"/>' +
  '<path class="su-logo-rim" d="M32 5a27 27 0 1 1-19 8" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>' +
  "</svg>";

function suKeysHtml(combo) {
  return String(combo || "")
    .split("+")
    .filter(Boolean)
    .map((k) => '<kbd class="su-key">' + escapeHtml(k.trim()) + "</kbd>")
    .join('<span class="su-plus">+</span>');
}

function suThemeCards() {
  const cards = THEME_PRESETS.map((p, i) => {
    const light = luminance(p.cardBg) > 0.5;
    const frame = light ? "#aeab9e" : shade(p.cardBg, -0.45);
    return (
      '<button class="su-theme" type="button" data-theme="' + i + '" style="--i:' + i + '">' +
      '<span class="su-theme-card" style="background:' + frame + '">' +
      '<i style="background:' + p.cardBg + '"></i>' +
      '<i style="background:' + p.cardBg + ';width:70%"></i>' +
      '<i style="background:' + p.accent + ';width:42%"></i></span>' +
      '<span class="su-theme-name">' + escapeHtml(p.name) + "</span></button>"
    );
  });
  cards.push(
    '<button class="su-theme" type="button" data-theme="system" style="--i:' + THEME_PRESETS.length + '">' +
    '<span class="su-theme-card su-theme-split">' +
    '<i style="background:#1e1e1e"></i><i style="background:#f2f0e5;width:70%"></i><i style="background:var(--accent);width:42%"></i></span>' +
    '<span class="su-theme-name">' + escapeHtml(suT("setupThemeSystem")) + "</span></button>"
  );
  return cards.join("");
}

// A hex colour moved towards black (negative) or white (positive).
function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const to = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  const ch = (v) => Math.round(v + (to - v) * k);
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, "0")).join("");
}

function suStepHtml(name) {
  switch (name) {
    case "welcome":
      return (
        '<div class="su-hero">' + SU_LOGO + "</div>" +
        '<h2 class="su-title">' + escapeHtml(suT("setupWelcomeTitle")) + "</h2>" +
        '<p class="su-text">' + escapeHtml(suT("setupWelcomeText")) + "</p>"
      );
    case "look":
      return (
        '<div class="su-head">' + suIco("look") + '<h2 class="su-title">' + escapeHtml(suT("setupLookTitle")) + "</h2></div>" +
        '<div class="su-label">' + escapeHtml(suT("setupLangLabel")) + "</div>" +
        '<div class="seg-row su-langs">' +
        SU_LANGS.map(([code, label]) => '<button class="seg-btn" data-lang="' + code + '">' + label + "</button>").join("") +
        "</div>" +
        '<div class="su-label">' + escapeHtml(suT("setupThemeLabel")) + "</div>" +
        '<div class="su-themes">' + suThemeCards() + "</div>"
      );
    case "startup":
      return (
        '<div class="su-head">' + suIco("startup") + '<h2 class="su-title">' + escapeHtml(suT("setupStartupTitle")) + "</h2></div>" +
        '<div class="su-row" id="su-autostart-row"><div class="su-row-text"><div class="su-row-title">' +
        escapeHtml(suT("setupAutostart")) + '</div><div class="su-row-sub">' + escapeHtml(suT("setupAutostartText")) +
        '</div></div><span class="toggle' + (suState.autostart ? " on" : "") + '" id="su-autostart"><span class="toggle-knob"></span></span></div>' +
        (suHookOk
          ? '<div class="su-row"><div class="su-row-text"><div class="su-row-title">' + escapeHtml(suT("setupHotkey")) +
            '</div><div class="su-row-sub">' + escapeHtml(suT("setupHotkeyText")) + "</div></div>" +
            '<div class="su-hotkey" id="su-hotkey"></div>' +
            '<button class="su-ghost" id="su-hotkey-change" type="button">' + escapeHtml(suT("setupHotkeyChange")) + "</button></div>"
          : '<div class="su-row su-warn"><div class="su-row-text"><div class="su-row-title">' +
            escapeHtml(suT("setupHotkeyFailed")) + "</div></div></div>")
      );
    case "index":
      return (
        '<div class="su-head">' + suIco("index") + '<h2 class="su-title">' + escapeHtml(suT("setupIndexTitle")) + "</h2></div>" +
        '<div class="su-opts">' +
        '<button class="su-opt" type="button" data-index="quick">' + suIco("quick", 22) +
        '<span class="su-opt-title">' + escapeHtml(suT("setupQuick")) + '</span><span class="su-opt-text">' + escapeHtml(suT("setupQuickText")) + "</span></button>" +
        '<button class="su-opt" type="button" data-index="full">' + suIco("full", 22) +
        '<span class="su-opt-title">' + escapeHtml(suT("setupFull")) + '</span><span class="su-opt-text">' + escapeHtml(suT("setupFullText")) + "</span></button>" +
        "</div>" +
        '<div class="su-progress"><div class="su-bar" id="su-bar"><i></i></div><div class="su-progress-text" id="su-progress-text"></div></div>'
      );
    case "tour":
      return (
        '<div class="su-head">' + suIco("tour") + '<h2 class="su-title">' + escapeHtml(suT("setupTourTitle")) + "</h2></div>" +
        '<div class="su-demo" aria-hidden="true">' +
        '<div class="su-r"><i class="ic"></i><i class="ln" style="width:38%"></i></div>' +
        '<div class="su-r su-r-big"><div class="su-r-top"><i class="ic"></i><i class="ln" style="width:30%"></i></div>' +
        '<div class="su-r-body"><div class="su-pic"></div><div class="su-r-lines"><i class="ln" style="width:70%"></i><i class="ln" style="width:48%"></i><i class="ln" style="width:58%"></i></div></div></div>' +
        '<div class="su-r"><i class="ic"></i><i class="ln" style="width:46%"></i></div>' +
        '<div class="su-r"><i class="ic"></i><i class="ln" style="width:30%"></i></div>' +
        '<div class="su-cap"><kbd class="su-key">Shift</kbd><span class="su-plus">+</span><kbd class="su-key">Space</kbd></div>' +
        "</div>" +
        '<p class="su-text">' + escapeHtml(suT("setupTourText")) + "</p>" +
        '<div class="su-row" id="su-keep-row"><div class="su-row-text"><div class="su-row-title">' + escapeHtml(suT("setupTourKeep")) +
        '</div><div class="su-row-sub">' + escapeHtml(suT("setupTourKeepText")) +
        '</div></div><span class="toggle' + (theme && theme.sidePreview ? " on" : "") + '" id="su-keep"><span class="toggle-knob"></span></span></div>'
      );
    case "done":
      return (
        '<div class="su-hero"><svg class="su-check" viewBox="0 0 64 64" width="84" height="84" aria-hidden="true">' +
        '<circle class="su-check-ring" cx="32" cy="32" r="28" fill="none" stroke="var(--accent)" stroke-width="3"/>' +
        '<path class="su-check-tick" d="M19 33l9 9 17-19" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '<h2 class="su-title">' + escapeHtml(suT("setupDoneTitle")) + "</h2>" +
        '<p class="su-text" id="su-done-text"></p>' +
        '<div class="su-hotkey su-hotkey-big" id="su-done-keys"></div>' +
        '<p class="su-text su-text-dim">' + escapeHtml(suT("setupDoneHelp")) + "</p>"
      );
  }
  return "";
}

function suRenderDots() {
  suDots.innerHTML = SU_STEPS.map((_, i) => '<span class="su-dot' + (i === suStep ? " on" : i < suStep ? " past" : "") + '"></span>').join("");
}

function suRenderButtons() {
  const last = suStep === SU_STEPS.length - 1;
  suBack.classList.toggle("su-hidden", suStep === 0 || last);
  suBack.textContent = suT("setupBack");
  suNext.textContent = suStep === 0 ? suT("setupStart") : last ? suT("setupFinish") : suT("setupNext");
  suDefaults.textContent = suFirst ? suT("setupDefaults") : suT("setupClose");
  suDefaults.classList.toggle("su-hidden", last);
}

// Draws the current step. `dir` is 1 or -1 for the way the content slides in, 0 for no movement
// (a language change repaints the same step in place).
function suRender(dir) {
  const name = SU_STEPS[suStep];
  const old = suStage.querySelector(".su-step");
  const fresh = document.createElement("div");
  fresh.className = "su-step su-step-" + name + (dir > 0 ? " from-right" : dir < 0 ? " from-left" : " still");
  fresh.innerHTML = suStepHtml(name);
  suStage.appendChild(fresh);
  if (old) {
    old.classList.add("leaving", dir < 0 ? "to-right" : "to-left");
    setTimeout(() => old.remove(), 260);
  }
  suRenderDots();
  suRenderButtons();
  suBind(name, fresh);
  clearInterval(suPoll);
  if (name === "index") {
    suPoll = setInterval(suPaintProgress, 250);
    suPaintProgress();
  }
}

function suBind(name, root) {
  if (name === "look") {
    root.querySelectorAll(".su-langs .seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === suCurrentLang());
      btn.addEventListener("click", async () => {
        const lang = btn.dataset.lang;
        window.i18n.setLanguage(lang);
        invoke("set_language", { lang }).catch(() => {});
        updateLanguageButtons(lang);
      });
    });
    suMarkTheme(root);
    root.querySelectorAll(".su-theme").forEach((b) =>
      b.addEventListener("click", async () => {
        const which = b.dataset.theme;
        if (which === "system") {
          theme = { ...theme, followSystem: true };
          await refreshSystemTheme();
        } else {
          const p = THEME_PRESETS[Number(which)];
          theme = { ...theme, followSystem: false, cardBg: p.cardBg, accent: p.accent, cardAlpha: p.alpha, text: p.text, customTheme: null };
        }
        saveTheme();
        suMarkTheme(root);
      })
    );
  } else if (name === "startup") {
    const tog = root.querySelector("#su-autostart");
    root.querySelector("#su-autostart-row").addEventListener("click", () => {
      suState.autostart = !suState.autostart;
      tog.classList.toggle("on", suState.autostart);
    });
    const keys = root.querySelector("#su-hotkey");
    if (keys) {
      const paint = () => {
        keys.classList.toggle("capturing", settingHotkeyRow.classList.contains("capturing"));
        keys.innerHTML = settingHotkeyRow.classList.contains("capturing")
          ? '<span class="su-press">' + escapeHtml(suT("setupHotkeyPress")) + "</span>"
          : suKeysHtml(currentHotkey);
      };
      invoke("get_hotkey").then((hk) => {
        currentHotkey = hk;
        settingHotkeyValue.textContent = hk;
        paint();
      }).catch(paint);
      const watch = new MutationObserver(paint);
      watch.observe(settingHotkeyValue, { childList: true, characterData: true, subtree: true });
      watch.observe(settingHotkeyRow, { attributes: true, attributeFilter: ["class"] });
      root._suWatch = watch;
      root.querySelector("#su-hotkey-change").addEventListener("click", (e) => {
        e.stopPropagation();
        settingHotkeyRow.click();
      });
    }
  } else if (name === "index") {
    invoke("get_index_options").then((o) => {
      indexOpts = o;
      suMarkIndex(root);
    }).catch(() => {});
    root.querySelectorAll(".su-opt").forEach((b) =>
      b.addEventListener("click", async () => {
        const full = b.dataset.index === "full";
        try {
          await setIndexOption("hidden", full);
          await setIndexOption("appdata", full);
        } catch (err) {
          console.warn("index option failed:", err);
        }
        suMarkIndex(root);
        suPaintProgress();
      })
    );
  } else if (name === "tour") {
    root.querySelector("#su-keep-row").addEventListener("click", () => {
      theme = { ...theme, sidePreview: !theme.sidePreview };
      saveTheme();
      root.querySelector("#su-keep").classList.toggle("on", !!theme.sidePreview);
    });
  } else if (name === "done") {
    invoke("get_hotkey").then((hk) => {
      const keys = root.querySelector("#su-done-keys");
      const text = root.querySelector("#su-done-text");
      if (keys) keys.innerHTML = suKeysHtml(hk);
      if (text) text.textContent = suT("setupDoneText", { hotkey: hk });
    }).catch(() => {});
  }
}

function suCurrentLang() {
  return window.i18n.getLang();
}

function suMarkTheme(root) {
  const cards = root.querySelectorAll(".su-theme");
  let on = null;
  if (theme.followSystem) on = "system";
  else {
    const i = THEME_PRESETS.findIndex((p) => p.cardBg === theme.cardBg && p.accent === theme.accent);
    if (i >= 0 && !theme.customTheme) on = String(i);
  }
  cards.forEach((b) => b.classList.toggle("on", b.dataset.theme === on));
}

function suMarkIndex(root) {
  const full = !!(indexOpts.hidden && indexOpts.appdata);
  root.querySelectorAll(".su-opt").forEach((b) => b.classList.toggle("on", (b.dataset.index === "full") === full));
}

async function suPaintProgress() {
  const bar = document.getElementById("su-bar");
  const text = document.getElementById("su-progress-text");
  if (!bar || !text) return;
  if (indexingActive) {
    bar.classList.add("run");
    bar.firstElementChild.style.width = Math.max(4, idxPct) + "%";
    text.textContent = suT("setupIndexing", { pct: idxPct });
    return;
  }
  bar.classList.remove("run");
  bar.firstElementChild.style.width = "100%";
  try {
    const n = await invoke("get_index_status");
    if (!indexingActive) text.textContent = suT("setupIndexed", { n: Number(n).toLocaleString() });
  } catch {
    text.textContent = "";
  }
}

function suGo(delta) {
  const next = Math.max(0, Math.min(SU_STEPS.length - 1, suStep + delta));
  if (next === suStep) return;
  suStep = next;
  suRender(delta);
}

async function suFinish(applyDefaults) {
  if (!suActive) return;
  suActive = false;
  clearInterval(suPoll);
  // Skipping the first run keeps what is recommended; closing a repeat run changes nothing more.
  const wantAutostart = applyDefaults && suFirst ? true : suState.autostart;
  if (suStep >= SU_STEPS.length - 1 || (applyDefaults && suFirst)) {
    await invoke("set_autostart", { enable: wantAutostart }).catch(() => {});
  }
  await invoke("finish_setup").catch(() => {});
  suEl.classList.remove("show");
  appContainer.classList.remove("setup-active");
  setTimeout(() => {
    suStage.innerHTML = "";
    searchInput.focus();
  }, 260);
  performSearch("").catch(() => {});
}

async function suOpen(opts) {
  if (suActive) return;
  suFirst = !(opts && opts.first === false);
  suHookOk = !(opts && opts.hookOk === false);
  suStep = 0;
  suActive = true;
  suState.autostart = suFirst ? true : await invoke("get_autostart").catch(() => true);
  try {
    indexOpts = await invoke("get_index_options");
  } catch {}
  suEl.classList.add("show");
  appContainer.classList.add("setup-active");
  appContainer.classList.remove("window-hidden", "window-hiding");
  appContainer.classList.add("window-showing");
  suStage.innerHTML = "";
  suRender(0);
  suEl.focus();
}

function suInit() {
  suEl = document.getElementById("setup");
  if (!suEl) return;
  suEl.innerHTML =
    '<div class="su-stage"></div>' +
    '<div class="su-foot"><button class="su-ghost" id="su-defaults" type="button"></button>' +
    '<div class="su-dots"></div>' +
    '<div class="su-nav"><button class="su-ghost" id="su-back" type="button"></button>' +
    '<button class="su-primary" id="su-next" type="button"></button></div></div>';
  suStage = suEl.querySelector(".su-stage");
  suDots = suEl.querySelector(".su-dots");
  suBack = suEl.querySelector("#su-back");
  suNext = suEl.querySelector("#su-next");
  suDefaults = suEl.querySelector("#su-defaults");
  suBack.addEventListener("click", () => suGo(-1));
  suNext.addEventListener("click", () => {
    if (suStep >= SU_STEPS.length - 1) suFinish(false);
    else suGo(1);
  });
  suDefaults.addEventListener("click", () => suFinish(true));
  // The window is the setup's for now: a click away or Esc does not hide it.
  suEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (!suActive || hotkeyCapturing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === "ArrowRight" || (e.key === "Enter" && !(e.target instanceof Element && e.target.closest("button, .su-row")))) {
      e.preventDefault();
      e.stopPropagation();
      suNext.click();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      if (suStep > 0 && suStep < SU_STEPS.length - 1) suGo(-1);
    }
  }, true);
  window.addEventListener("language-changed", () => {
    if (suActive) suRender(0);
  });
}

window.UmbraSetup = { open: suOpen, active: () => suActive };
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", suInit);
