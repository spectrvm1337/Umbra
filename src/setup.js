// First-run setup: a few screens in the window itself -- language and theme, autostart and the
// hotkey, what to index, one look at how a result opens up -- shown on a fresh install, again when
// it was closed half way, and on demand from Settings.
//
// Nothing here has a store of its own. Each choice goes through what Settings already uses (the
// language and theme code in main.js, the autostart and hotkey commands, the index switches), and
// the screens are drawn again from those values, so running the setup a second time starts from
// what is set now rather than from defaults.

const SU_STEPS = ["welcome", "look", "startup", "index", "tour", "done"];
const SU_DENSITIES = [["full", "densityFull"], ["compact-results", "densityCompactResults"], ["compact-full", "densityCompactFull"]];
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

// The app's own mark (Umbra-icon.png): a black disc with a white arc.
const SU_LOGO = '<img class="su-logo" src="umbra-icon.png" width="84" height="84" alt="" draggable="false">';

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
        '<div class="su-themes">' + suThemeCards() + "</div>" +
        '<div class="su-label">' + escapeHtml(suT("setupDensityLabel")) + "</div>" +
        '<div class="su-denses">' +
        SU_DENSITIES.map(([d, key], i) =>
          '<button class="su-dens" type="button" data-density="' + d + '" style="--i:' + i + '">' +
          '<span class="su-dens-pic"><i class="b"></i><i class="r"></i><i class="r"></i><i class="r"></i></span>' +
          '<span class="su-theme-name">' + escapeHtml(suT(key)) + "</span></button>"
        ).join("") +
        "</div>" +
        '<p class="su-text su-text-dim su-density-tip"></p>'
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
        '<div class="su-mock" aria-hidden="true">' +
        '<div class="su-mock-inner"><div class="su-mock-bar">' + SU_SEARCH_ICON + '<span class="su-mock-q"></span><i class="su-mock-caret"></i></div>' +
        '<div class="su-mock-rows"></div></div>' +
        '<div class="su-cap"><kbd class="su-key">Shift</kbd><span class="su-plus">+</span><kbd class="su-key">Space</kbd></div>' +
        "</div>" +
        '<p class="su-text su-scene-text"></p>' +
        '<div class="su-chips">' +
        SU_SCENES.map((s, i) => '<button class="su-chip" type="button" data-scene="' + i + '">' + escapeHtml(suT(s.label)) + "</button>").join("") +
        "</div>" +
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

// The dots are made once and only change class, so the active one stretches and shrinks between steps.
function suRenderDots() {
  if (suDots.children.length !== SU_STEPS.length) {
    suDots.innerHTML = SU_STEPS.map(() => '<span class="su-dot"></span>').join("");
  }
  [...suDots.children].forEach((d, i) => {
    d.classList.toggle("on", i === suStep);
    d.classList.toggle("past", i < suStep);
  });
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
  if (name !== "tour") suTourStop();
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
    suMarkDensity(root);
    root.querySelectorAll(".su-dens").forEach((btn) =>
      btn.addEventListener("click", () => {
        // The Appearance panel's own switch does the work, so this is the same setting.
        densitySeg.querySelector('[data-density="' + btn.dataset.density + '"]').click();
        suMarkDensity(root);
      })
    );
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
      // The settings row does the recording; this one shows what that row shows.
      const row = keys.closest(".su-row");
      const paint = () => {
        row.classList.toggle("capturing", settingHotkeyRow.classList.contains("capturing"));
        keys.innerHTML = settingHotkeyValue.innerHTML;
        keys.classList.toggle("applied", settingHotkeyValue.classList.contains("applied"));
      };
      invoke("get_hotkey").then((hk) => {
        currentHotkey = hk;
        paintHotkeyIdle();
      }).catch(paint);
      paint();
      const watch = new MutationObserver(paint);
      watch.observe(settingHotkeyValue, { childList: true, attributes: true, attributeFilter: ["class"] });
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
    suTourPlay(root, 0);
    root.querySelectorAll(".su-chip").forEach((c) => c.addEventListener("click", () => suTourPlay(root, Number(c.dataset.scene))));
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

// The tour is a small copy of the real window. It types a query and what comes back is built from
// the same markup and classes the real results use, so it looks the way Umbra does rather than a
// drawing of it. Each scene is one thing Umbra does; they play in turn and a chip jumps to one.
const SU_SEARCH_ICON =
  '<svg class="su-mock-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10.9521 10.9642L15 15M12.6667 6.83333C12.6667 10.055 10.055 12.6667 6.83333 12.6667C3.61167 12.6667 1 10.055 1 6.83333C1 3.61167 3.61167 1 6.83333 1C10.055 1 12.6667 3.61167 12.6667 6.83333Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SU_LINK_ICON =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6m-7 1l9-9m-5 0h5v5"/></svg>';
const SU_CALC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/></svg>';
const SU_SCENES = [
  { label: "setupScFind", text: "setupScFindT", query: "rep", items: [
    { kind: "app", name: "REAPER", path: "C:\\Program Files\\REAPER (x64)\\reaper.exe" },
    { kind: "document", name: "Report Q3.pdf", path: "C:\\Users\\you\\Documents\\Work\\Report Q3.pdf" },
    { kind: "folder", name: "Reports", path: "C:\\Users\\you\\Desktop\\Reports" },
  ] },
  { label: "setupScOpen", text: "setupScOpenT", query: "notes", open: true, items: [
    { kind: "document", name: "notes.md", path: "C:\\Users\\you\\Documents\\notes.md", meta: "Markdown \u00B7 312 B",
      body: "# Launch checklist\n\n- ship 0.2.2\n- update the site\n- write the changelog\n- tell people" },
    { kind: "folder", name: "Notes", path: "C:\\Users\\you\\Desktop\\Notes" },
    { kind: "app", name: "Notepad", path: "C:\\Windows\\System32\\notepad.exe" },
  ] },
  { label: "setupScCalc", text: "setupScCalcT", query: "(1280 - 340) / 4", calc: ["(1280 - 340) / 4", "235"] },
  { label: "setupScCmd", text: "setupScCmdT", query: "!yt lofi beats", link: "open in youtube: lofi beats" },
  { label: "setupScColor", text: "setupScColorT", query: "!color", color: { r: 229, g: 83, b: 61 } },
];
let suTourTimers = [];

function suResultRow(item, i, query) {
  return (
    '<div class="result-item' + (i === 0 ? " selected" : "") + '" style="animation-delay:' + i * 60 + 'ms">' +
    '<div class="result-num"></div><div class="result-icon"><div class="result-icon-fallback ' + item.kind + '">' + getTypeIcon(item.kind) + "</div></div>" +
    '<div class="result-name">' + highlightMatch(item.name, query) + '</div><div class="result-path">' + pathHtml(item.path) + "</div></div>"
  );
}

// What the real card holds when a text file is open: its start on the left, name and path beside it.
function suOpenBodyHtml(item) {
  return (
    '<div class="sp-body sp-wide"><div class="sp-stage"><div class="sp-content"><pre class="sp-text">' + escapeHtml(item.body) + "</pre></div></div>" +
    '<div class="sp-info"><div class="sp-name">' + escapeHtml(item.name) + '</div><div class="sp-meta">' + escapeHtml(item.meta) +
    '</div><div class="sp-path result-path">' + pathHtml(item.path) + "</div></div></div>"
  );
}

function suColorCard(c) {
  const card = document.createElement("div");
  card.className = "special-card color-card";
  card.innerHTML = colorCardHtml(c);
  card.querySelector(".cc-history").innerHTML = "";
  card.querySelector(".cc-loupe").classList.add("has-capture");
  const cv = card.querySelector(".cc-pixels");
  const g = cv.getContext("2d");
  // A made-up patch of screen: the colour with lighter and darker cells around it.
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const k = 0.55 + 0.45 * Math.abs(Math.sin(x * 0.45 + y * 0.31) * Math.cos(y * 0.52 - x * 0.2));
      g.fillStyle = "rgb(" + [c.r, c.g, c.b].map((v) => Math.round(v * k)).join(",") + ")";
      g.fillRect(x, y, 1, 1);
    }
  }
  return card;
}

function suSceneHtml(scene) {
  if (scene.calc) {
    return '<div class="special-card"><div class="special-action calc-card">' + SU_CALC_ICON + "<span>" + escapeHtml(scene.calc[0]) +
      " = <b>" + escapeHtml(scene.calc[1]) + '</b></span><span class="special-hint">' + escapeHtml(suT("calcCopy")) + "</span></div></div>";
  }
  if (scene.link) {
    return '<div class="special-card"><div class="special-action">' + SU_LINK_ICON + "<span>" + escapeHtml(scene.link) + "</span></div></div>";
  }
  return scene.items.map((it, i) => suResultRow(it, i, scene.query)).join("");
}

function suTourStop() {
  suTourTimers.forEach(clearTimeout);
  suTourTimers = [];
}

function suTourPlay(root, index) {
  suTourStop();
  const later = (fn, ms) => suTourTimers.push(setTimeout(fn, ms));
  const scene = SU_SCENES[index];
  const mock = root.querySelector(".su-mock");
  const q = root.querySelector(".su-mock-q");
  const rows = root.querySelector(".su-mock-rows");
  root.querySelectorAll(".su-chip").forEach((c, i) => c.classList.toggle("on", i === index));
  const text = root.querySelector(".su-scene-text");
  text.classList.remove("swap");
  void text.offsetWidth;
  text.textContent = suT(scene.text);
  text.classList.add("swap");
  mock.classList.remove("pressed");
  rows.innerHTML = "";
  q.textContent = "";
  let n = 0;
  const step = () => {
    if (!root.isConnected) return;
    if (n < scene.query.length) {
      q.textContent = scene.query.slice(0, ++n);
      later(step, 70);
      return;
    }
    if (scene.color) rows.replaceChildren(suColorCard(scene.color));
    else rows.innerHTML = suSceneHtml(scene);
    if (scene.open) {
      later(() => {
        const first = rows.firstElementChild;
        mock.classList.add("pressed");
        first.classList.add("sp-open");
        first.innerHTML = suOpenBodyHtml(scene.items[0]);
      }, 900);
    }
    later(() => suTourPlay(root, (index + 1) % SU_SCENES.length), scene.open ? 5200 : 3800);
  };
  later(step, 350);
}

function suCurrentLang() {
  return window.i18n.getLang();
}

function suMarkDensity(root) {
  const now = theme.density || "full";
  root.querySelectorAll(".su-dens").forEach((b) => b.classList.toggle("on", b.dataset.density === now));
  const tips = { full: "densityFullTip", "compact-results": "densityCompactResultsTip", "compact-full": "densityCompactFullTip" };
  root.querySelector(".su-density-tip").textContent = suT(tips[now] || tips.full);
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
  suTourStop();
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
