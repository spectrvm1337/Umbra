let faviconTimer = 0;
// Slides the site's own icon in between the card's arrow and its label once it has been fetched,
// pushing the label aside. Waits for a pause in typing, and drops the answer if the card has moved on
// to another address meanwhile.
function loadFavicon(url) {
  clearTimeout(faviconTimer);
  if (!/^https?:\/\//i.test(url)) return;
  faviconTimer = setTimeout(async () => {
    let src = null;
    try { src = await invoke("fetch_favicon", { url }); } catch { return; }
    const action = specialContent.querySelector(".special-action");
    if (!src || !action || action.dataset.url !== url) return;
    const img = document.createElement("img");
    img.className = "special-favicon";
    img.alt = "";
    img.onload = () => {
      const svg = action.querySelector("svg");
      if (!svg || !action.isConnected || action.querySelector(".special-favicon")) return;
      svg.after(img);
      // Two frames: the box has to be laid out at 0 wide before it can grow.
      requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add("show")));
    };
    img.src = src;
  }, 400);
}
function showOpenCard(url, label) {
  specialSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  pinsSection.classList.add("hidden");
  specialContent.innerHTML = `
    <div class="special-card">
      <div class="special-action" data-url="${escapeHtml(url)}">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6m-7 1l9-9m-5 0h5v5"/></svg>
        <span>${escapeHtml(label)}</span>
      </div>
    </div>
  `;
  specialContent.querySelector(".special-action").addEventListener("click", (e) => {
    const url = e.currentTarget.dataset.url;
    invoke("launch_item", { path: url })
      .catch((err) => console.warn("launch failed:", err));
    hideWindow();
  });
  // Enter launches selectableItems[selectedIndex]; without this it opened the previous search's top result.
  selectableItems = [{ name: "", path: url, kind: "open", icon_data: null, pinned: false }];
  selectedIndex = 0;
  loadFavicon(url);
}
const WIKI_LANGS = new Set(["en", "ru", "de", "ja"]);
const OPEN_TLDS = new Set(["com", "org", "net", "io", "dev", "me", "gg", "tv", "co", "uk", "de", "info", "xyz", "ru", "su", "ua", "by", "kz", "рф"]);
// A URL or an absolute path typed into the search box, normalized for launch_item; null for ordinary searches.
function parseOpenTarget(q) {
  const s = q.replace(/^"(.+)"$/, "$1");
  if (/^[a-z]:[\\/]/i.test(s) || /^\\\\[^\\\s]+\\[^\\]+/.test(s)) return s.replace(/\//g, "\\");
  if (/\s/.test(s)) return null;
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^file:\/\/\/[a-z]:/i.test(s)) {
    try { return decodeURIComponent(s.slice(8)).replace(/\//g, "\\"); } catch { return null; }
  }
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(s)) return `http://${s}`;
  const host = s.match(/^((?:[a-z0-9-]+\.)+([a-zа-я]{2,}))(:\d+)?(\/\S*)?$/i);
  if (host && (/^www\./i.test(s) || host[4] || OPEN_TLDS.has(host[2].toLowerCase()))) return `https://${s}`;
  return null;
}
const BUNDLED_FONTS = {
  wix: "wix", "wix madefor display": "wix", "wix madefor": "wix",
  "sn pro": "sn-pro", snpro: "sn-pro",
  montserrat: "montserrat", "montserrat alternates": "montserrat",
};
// Whether the web view can draw with a font of that name: it is installed if text in it measures
// differently from the plain fallback fonts it would otherwise land on.
function fontInstalled(name) {
  const ctx = document.createElement("canvas").getContext("2d");
  const sample = "mmmmmmmmmmlli Ж 0123456789";
  return ["monospace", "serif", "sans-serif"].some((fallback) => {
    ctx.font = `40px ${fallback}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `40px '${name}', ${fallback}`;
    return ctx.measureText(sample).width !== base;
  });
}
// `!font <name>`: picks a font installed on this PC and adds it to the choices in Settings.
function handleFontCommand(q) {
  const m = q.match(/^!font(?:\s+(.*))?$/i);
  if (!m) return false;
  const name = (m[1] || "").trim().replace(/^["']|["']$/g, "").trim();
  selectableItems = [];
  selectedIndex = -1;
  specialSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  pinsSection.classList.add("hidden");
  const bundled = BUNDLED_FONTS[name.toLowerCase()];
  const valid = /^[\p{L}\p{N} ._+-]{1,64}$/u.test(name);
  const found = !!name && (bundled || (valid && fontInstalled(name)));
  const label = !name ? t("fontHint") : found ? `${t("fontUse")}: ${name}` : `${name} — ${t("fontMissing")}`;
  specialContent.innerHTML = `
    <div class="special-card">
      <div class="special-action${found ? "" : " is-disabled"}">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M4 20l3 0m4 0l3 0m-9 0l5.5 -16l5.5 16m-3 0l3 0m-12 -6l9 0"/></svg>
        <span></span>
      </div>
    </div>
  `;
  const action = specialContent.querySelector(".special-action");
  const span = action.querySelector("span");
  span.textContent = label;
  // Shows the label in the font it names.
  if (found && !bundled) span.style.fontFamily = `'${name}', var(--font-main)`;
  if (!found) return true;
  const apply = () => {
    const pick = bundled || `sys:${name}`;
    const fonts = bundled ? (theme.systemFonts || []) : [...(theme.systemFonts || []).filter((f) => f.toLowerCase() !== name.toLowerCase()), name];
    theme = { ...theme, font: pick, systemFonts: fonts };
    saveTheme();
    showToast(t("fontSet", { name }));
    hideWindow();
  };
  action.addEventListener("click", apply);
  selectableItems = [{ name: "", path: "", kind: "font", icon_data: null, pinned: false, run: apply }];
  selectedIndex = 0;
  return true;
}
function handleSpecialCommand(query) {
  const q = query.trim();
  if (handleFontCommand(q)) return true;
  if (handleColorCommand(q)) return true;
  const killMatch = q.match(/^kill\s+(.+)/i);
  if (killMatch) {
    const procName = killMatch[1].trim();
    // Confirm by clicking; without this Enter launched the previous search's top result.
    selectableItems = [];
    selectedIndex = -1;
    specialSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");
    pinsSection.classList.add("hidden");
    // taskkill expands * and ? itself, so "kill *" would close every program.
    const invalid = /[*?\\/"]/.test(procName);
    specialContent.innerHTML = `
      <div class="special-card">
        <div class="special-action${invalid ? " is-disabled" : ""}" data-kill="${escapeHtml(procName)}">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0m7-2l4 4m0-4l-4 4"/></svg>
          <span>${escapeHtml(t("killLabel", { name: procName }))}</span>
          <span class="special-hint">${invalid ? escapeHtml(t("killInvalid")) : ""}</span>
        </div>
      </div>
    `;
    const action = specialContent.querySelector(".special-action");
    if (invalid) return true;
    // Show what would be killed: the program's icon and how many are running. A partial name is
    // taken to mean the running program it matches ("kill spot" -> Spotify.exe), which the card
    // then names, and that is what the click kills.
    let target = procName;
    invoke("find_process", { name: procName })
      .then(async (found) => {
        if (!action.isConnected) return;
        if (found.exe) {
          target = found.exe;
          action.querySelector("span").textContent = t("killLabel", { name: found.exe });
        }
        action.querySelector(".special-hint").textContent =
          found.count === 0 ? t("procNotRunning") : found.count === 1 ? t("procRunning") : t("procRunningN", { n: found.count });
        if (!found.path) return;
        const src = (await invoke("get_icons", { paths: [found.path] }))[found.path];
        if (!src || !action.isConnected) return;
        const icon = document.createElement("div");
        icon.className = "result-icon";
        icon.innerHTML = `<img src="${src}" alt="">`;
        action.querySelector("svg").replaceWith(icon);
      })
      .catch(() => {});
    action.addEventListener("click", async () => {
      try {
        const result = await invoke("kill_process", { name: target });
        const el = specialContent.querySelector(".special-action span");
        el.textContent = result;
        action.querySelector(".special-hint").textContent = "";
        setTimeout(hideWindow, 1000);
      } catch (e) {
        const el = specialContent.querySelector(".special-action span");
        el.textContent = `${window.i18n.t("errorPrefix")}: ${e}`;
      }
    });
    return true;
  }
  const powerMatch = q.match(/^(shutdown|restart|sleep)$/i);
  if (powerMatch) {
    const cmd = powerMatch[1].toLowerCase();
    const word = cmd[0].toUpperCase() + cmd.slice(1);
    // Same as kill: never let Enter fall through to a stale result on a power prompt.
    selectableItems = [];
    selectedIndex = -1;
    specialSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");
    pinsSection.classList.add("hidden");
    specialContent.innerHTML = `
      <div class="special-card">
        <div class="special-action" data-power="${cmd}">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M7 6a7.75 7.75 0 1 0 10 0m-5-2v8"/></svg>
          <span>${escapeHtml(t("powerConfirm" + word))}</span>
        </div>
      </div>
    `;
    specialContent.querySelector(".special-action").addEventListener("click", async () => {
      try {
        const result = await invoke("exec_power_command", { command: cmd });
        const el = specialContent.querySelector(".special-action span");
        el.textContent = t("powerDoing" + word) || result;
      } catch (e) {
        const el = specialContent.querySelector(".special-action span");
        el.textContent = `${window.i18n.t("errorPrefix")}: ${e}`;
      }
    });
    return true;
  }
  if (handleCurrencyCommand(q)) return true;
  if (handleCalcCommand(q)) return true;
  if (/^!help\s*$/i.test(q)) {
    const cmds = [
      { name: "!help", desc: t("helpHelp"), fill: "" },
      { name: "#c83939", desc: t("helpColor"), fill: "#" },
      { name: "!picker", desc: t("helpPicker"), fill: "!picker" },
      { name: "!yt <query>", desc: t("helpYt"), fill: "!yt " },
      { name: "!g <query>", desc: t("helpG"), fill: "!g " },
      { name: "!gh <query>", desc: t("helpGh"), fill: "!gh " },
      { name: "!wiki <query>", desc: t("helpWiki"), fill: "!wiki " },
      { name: "!d <query>", desc: t("helpD"), fill: "!d " },
      { name: "!npm <query>", desc: t("helpNpm"), fill: "!npm " },
      { name: "!red <query>", desc: t("helpRed"), fill: "!red " },
      { name: "!so <query>", desc: t("helpSo"), fill: "!so " },
      { name: "!translate <text>", desc: t("helpTranslate"), fill: "!translate " },
      { name: "!font <name>", desc: t("helpFont"), fill: "!font " },
      { name: "100 usd to rub", desc: t("helpCurr"), fill: "100 usd to " },
      { name: "(2+3)*4 · 200+10%", desc: t("helpCalc"), fill: "" },
      { name: "kill <proc>", desc: t("helpKill"), fill: "kill " },
      { name: "shutdown|restart|sleep", desc: t("helpPower"), fill: "" },
      { name: "D:\\ <query>", desc: t("helpDrive"), fill: "D:\\ " },
      { name: "<link or path>", desc: t("helpOpen"), fill: "" },
    ];
    resultsSection.classList.remove("hidden");
    specialSection.classList.add("hidden");
    pinsSection.classList.add("hidden");
    resultsList.innerHTML = "";
    let cmdIndex = 0;
    for (const c of cmds) {
      const el = document.createElement("div");
      el.className = "result-item";
      el.style.paddingLeft = "16px";
      // The index is what the pointer and Ctrl+1..9 read. Without it they
      // found NaN and the selection was lost.
      el.dataset.index = String(cmdIndex++);
      el.innerHTML = `
        <div class="result-name" style="font-family:var(--font-main);font-weight:var(--weight-regular);font-size:13px">${escapeHtml(c.name)}</div>
        <div class="result-path" style="font-size:13px">${escapeHtml(c.desc)}</div>
      `;
      el.addEventListener("click", () => {
        if (!c.fill) return;
        searchInput.value = c.fill;
        clearBtn.classList.add("visible");
        clearGhost();
        updateGhost();
        searchInput.focus();
      });
      resultsList.appendChild(el);
    }
    selectableItems = cmds.map(c => ({
      name: c.name, path: "", kind: "help", fill: c.fill,
      icon_data: null, pinned: false,
    }));
    selectedIndex = 0;
    updateSelection();
    return true;
  }
  const quickMatch = q.match(/^!(\w+)\s+(.+)/);
  if (quickMatch) {
    const site = quickMatch[1].toLowerCase();
    const query = quickMatch[2];
    // [search url, the name the row shows]: "open in Google", not "open in g".
    const sites = {
      yt: ["https://www.youtube.com/results?search_query=", "YouTube"],
      y: ["https://www.youtube.com/results?search_query=", "YouTube"],
      gh: ["https://github.com/search?q=", "GitHub"],
      g: ["https://www.google.com/search?q=", "Google"],
      google: ["https://www.google.com/search?q=", "Google"],
      ru: ["https://www.google.ru/search?q=", "Google.ru"],
      // The Wikipedia of the interface language.
      wiki: [`https://${WIKI_LANGS.has(window.i18n.getLang()) ? window.i18n.getLang() : "en"}.wikipedia.org/w/index.php?search=`, "Wikipedia"],
      w: ["https://en.wikipedia.org/w/index.php?search=", "Wikipedia"],
      translate: ["https://translate.google.com/?sl=auto&tl=en&text=", "Google Translate"],
      so: ["https://stackoverflow.com/search?q=", "Stack Overflow"],
      npm: ["https://www.npmjs.com/search?q=", "npm"],
      py: ["https://pypi.org/search/?q=", "PyPI"],
      red: ["https://www.reddit.com/search/?q=", "Reddit"],
      tw: ["https://twitter.com/search?q=", "X"],
      d: ["https://duckduckgo.com/?q=", "DuckDuckGo"],
    };
    if (sites[site]) {
      const [url, name] = sites[site];
      showOpenCard(`${url}${encodeURIComponent(query)}`, t("openIn", { site: name, query }));
    } else {
      // An unknown !word is searched for on Google together with the rest, and says so.
      const all = `${quickMatch[1]} ${query}`;
      showOpenCard(`https://www.google.com/search?q=${encodeURIComponent(all)}`, t("openIn", { site: "Google", query: all }));
    }
    return true;
  }
  const target = parseOpenTarget(q);
  if (target) {
    showOpenCard(target, t("openTarget", { target }));
    return true;
  }
  return false;
}
