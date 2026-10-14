// The tray icon's right-click menu, drawn in Umbra's own style (tray.rs opens
// this window). Items, labels and the Pause check come from the backend so they
// match the language and state; the theme is the main window's.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const menu = document.getElementById("tray-menu");
let active = -1;

function hexWithAlpha(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
  return hex + a;
}
async function applyTheme() {
  try {
    const theme = await invoke("get_theme");
    let { accent, cardBg, text } = theme;
    if (theme.followSystem) {
      // Same as the main window's "Match Windows": Default / Paper + the Windows accent.
      const sys = await invoke("get_system_theme");
      [cardBg, text] = sys.dark ? ["#1e1e1e", "#e3e3e3"] : ["#f2f0e5", "#100f0f"];
      accent = sys.accent || (sys.dark ? "#507090" : "#205ea6");
    }
    const root = document.documentElement.style;
    root.setProperty("--accent", accent);
    root.setProperty("--card-bg", hexWithAlpha(cardBg, Math.max(theme.cardAlpha, 0.92)));
    root.setProperty("--text", text);
    root.setProperty("--card-radius", theme.radius + "px");
    root.setProperty("--card-border-w", (theme.borderOn ? theme.borderW : 0) + "px");
  } catch {}
}
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
async function render() {
  const items = await invoke("tray_menu_items");
  menu.innerHTML = items
    .map((it) => `${it.divider ? '<div class="tm-divider"></div>' : ""}<div class="tm-item" role="menuitem" data-id="${it.id}">
      <span class="tm-check">${it.checked ? CHECK_SVG : ""}</span><span class="tm-label">${escapeText(it.label)}</span></div>`)
    .join("");
  setActive(-1);
}
function rows() {
  return [...menu.querySelectorAll(".tm-item")];
}
function setActive(i) {
  active = i;
  rows().forEach((el, k) => el.classList.toggle("active", k === i));
}
function choose(el) {
  if (el) invoke("tray_menu_action", { id: el.dataset.id });
}
menu.addEventListener("click", (e) => choose(e.target.closest(".tm-item")));
menu.addEventListener("mousemove", (e) => {
  const el = e.target.closest(".tm-item");
  setActive(el ? rows().indexOf(el) : -1);
});
menu.addEventListener("mouseleave", () => setActive(-1));
document.addEventListener("keydown", (e) => {
  const n = rows().length;
  if (e.key === "ArrowDown") setActive((active + 1) % n);
  else if (e.key === "ArrowUp") setActive(active <= 0 ? n - 1 : active - 1);
  else if (e.key === "Enter") choose(rows()[active]);
  else if (e.key === "Escape") invoke("tray_menu_hide");
  else return;
  e.preventDefault();
});
document.addEventListener("contextmenu", (e) => e.preventDefault());
listen("tray-menu-show", async () => {
  await Promise.all([applyTheme(), render()]);
  menu.classList.remove("shown");
  // The window is sized to the menu plus room for its shadow.
  const rect = menu.getBoundingClientRect();
  const margin = 12;
  await invoke("tray_menu_present", { width: Math.ceil(rect.width) + margin * 2, height: Math.ceil(rect.height) + margin * 2 });
  void menu.offsetWidth;
  menu.classList.add("shown");
});
listen("tray-menu-refresh", () => render());
