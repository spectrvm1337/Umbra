use crate::{autostart, config, indexer, pins, search};
use tauri::Manager;
#[tauri::command]
pub fn get_index_status() -> usize {
    indexer::get_indexed_count()
}
#[tauri::command]
pub fn reindex(app: tauri::AppHandle) {
    indexer::init_index_with_progress(app);
}
#[tauri::command]
pub fn get_index_options() -> config::IndexOptions {
    config::get_index_options()
}
/// Turns `hidden` or `appdata` indexing on or off and rebuilds the index so it takes effect.
#[tauri::command]
pub fn set_index_option(app: tauri::AppHandle, name: String, on: bool) -> config::IndexOptions {
    let options = config::set_index_option(&name, on);
    indexer::init_index_with_progress(app);
    options
}
#[tauri::command]
pub fn add_pin(name: String, path: String, kind: String) -> bool {
    pins::add_pin(&search::SearchResult {
        name,
        path,
        kind: kind.clone(),
        icon: kind,
        pinned: false,
        icon_data: None,
        score: search::ScoreKey::default(),
    })
}
#[tauri::command]
pub fn remove_pin(path: String) -> bool {
    pins::remove_pin(&path)
}
#[tauri::command]
pub fn reorder_pins(ordered_paths: Vec<String>) -> bool {
    pins::reorder_pins(ordered_paths)
}
#[tauri::command]
pub fn get_hotkey() -> String {
    let hotkey = config::get_hotkey();
    if crate::keyboard_hook::is_supported_hotkey(&hotkey) {
        hotkey
    } else {
        config::DEFAULT_HOTKEY.to_string()
    }
}
#[tauri::command]
pub fn set_hotkey(app: tauri::AppHandle, key: String) -> Result<String, String> {
    let k = key.trim();
    if !crate::keyboard_hook::is_supported_hotkey(k) {
        return Err(
            "Hotkey must be a modifier (Ctrl, Alt, Shift, Super) plus a letter, digit, F1-F12, Space or arrow key, e.g. Ctrl+Shift+P".to_string(),
        );
    }
    config::set_hotkey(k);
    crate::keyboard_hook::update_hotkey();
    #[cfg(target_os = "windows")]
    crate::tray::refresh(&app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    Ok("Hotkey applied".to_string())
}
#[tauri::command]
pub fn get_zoom() -> f64 {
    config::get_zoom()
}
#[tauri::command]
pub fn set_zoom(zoom: f64) -> Result<String, String> {
    let z = zoom.clamp(0.5, 2.0);
    config::set_zoom(z);
    Ok(format!("Zoom set to {}", z))
}
#[tauri::command]
pub fn get_autostart() -> bool {
    autostart::is_enabled()
}
#[tauri::command]
pub fn set_autostart(enable: bool) -> bool {
    config::set_autostart(enable);
    autostart::set_enabled(enable);
    autostart::is_enabled()
}
#[tauri::command]
pub fn get_keybinds() -> std::collections::BTreeMap<String, String> {
    config::get_keybinds()
}
#[tauri::command]
pub fn set_keybinds(map: std::collections::BTreeMap<String, String>) -> std::collections::BTreeMap<String, String> {
    config::set_keybinds(map)
}
/// The first-run setup was finished or skipped.
#[tauri::command]
pub fn finish_setup() {
    config::set_setup_done(true);
}
#[tauri::command]
pub fn get_preview_style() -> String {
    config::get_preview_style()
}
#[tauri::command]
pub fn set_preview_style(style: String) -> String {
    config::set_preview_style(&style)
}
#[derive(serde::Serialize)]
pub struct Placement {
    pub align: String,
    pub monitor: i32,
}
#[derive(serde::Serialize)]
pub struct MonitorInfo {
    pub index: i32,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}
#[tauri::command]
pub fn get_placement() -> Placement {
    let (align, monitor) = config::get_placement();
    Placement { align, monitor }
}
#[tauri::command]
pub fn set_placement(align: String, monitor: i32) -> Placement {
    let a = if config::is_valid_align(&align) { align } else { "cc".to_string() };
    config::set_placement(a, monitor);
    let (align, monitor) = config::get_placement();
    Placement { align, monitor }
}
#[tauri::command]
pub fn list_monitors(app: tauri::AppHandle) -> Vec<MonitorInfo> {
    let Some(window) = app.get_webview_window("main") else {
        return Vec::new();
    };
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i as i32,
            label: format!("Monitor {}", i + 1),
            width: m.size().width,
            height: m.size().height,
            primary: primary
                .as_ref()
                .map_or(false, |p| p.name() == m.name() && p.position() == m.position()),
        })
        .collect()
}
#[tauri::command]
pub fn get_theme() -> config::ThemeConfig {
    config::get_theme()
}
#[tauri::command]
pub fn set_theme(app: tauri::AppHandle, theme: config::ThemeConfig) -> config::ThemeConfig {
    let saved = config::set_theme(theme);
    // Apply "results to screen bottom" right away rather than on the next summon.
    super::refit_window(&app);
    saved
}
#[derive(serde::Serialize)]
pub struct SystemTheme {
    pub dark: bool,
    /// The Windows accent colour as #rrggbb, when it can be read.
    pub accent: Option<String>,
}
/// Windows' app mode (light / dark) and accent colour, for "Match Windows".
#[tauri::command]
pub fn get_system_theme() -> SystemTheme {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        let personalize = crate::registry::Key::open(
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        );
        let dark = personalize.and_then(|k| k.dword("AppsUseLightTheme")).map_or(true, |v| v == 0);
        // AccentColor is stored as 0xAABBGGRR.
        let accent = crate::registry::Key::open(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\DWM")
            .and_then(|k| k.dword("AccentColor"))
            .map(|v| format!("#{:02x}{:02x}{:02x}", v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff));
        SystemTheme { dark, accent }
    }
    #[cfg(not(target_os = "windows"))]
    {
        SystemTheme { dark: true, accent: None }
    }
}
#[tauri::command]
pub fn get_language() -> String {
    config::get_language()
}
#[tauri::command]
pub fn set_language(app: tauri::AppHandle, lang: String) -> String {
    let lang = config::set_language(lang);
    #[cfg(target_os = "windows")]
    crate::tray::refresh(&app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    lang
}
#[tauri::command]
pub fn get_disabled_kinds() -> Vec<u8> {
    config::get_disabled_kinds()
}
#[tauri::command]
pub fn set_kind_enabled(kind: u8, enabled: bool) -> Vec<u8> {
    config::set_kind_enabled(kind, enabled)
}
#[tauri::command]
pub fn get_available_drives() -> Vec<String> {
    crate::indexer::get_available_drives()
}
#[tauri::command]
pub fn get_disabled_drives() -> Vec<String> {
    config::get_disabled_drives()
}
#[tauri::command]
pub fn get_anim_off() -> Vec<String> {
    config::get_anim_off()
}
#[tauri::command]
pub fn set_anim_off(kind: String, off: bool) -> Vec<String> {
    config::set_anim_off(kind, off)
}
/// Turns a drive on or off and rebuilds the index, so its files come or go now
/// rather than at the next start.
#[tauri::command]
pub fn set_drive_enabled(app: tauri::AppHandle, drive: String, enabled: bool) -> Vec<String> {
    let before = config::get_disabled_drives();
    let after = config::set_drive_enabled(&drive, enabled);
    if after != before {
        indexer::init_index_with_progress(app);
    }
    after
}
#[tauri::command]
pub fn open_themes_folder() -> Result<(), String> {
    let path = crate::paths::themes_dir();
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[derive(serde::Serialize)]
pub struct CustomTheme {
    pub name: String,
    pub css: String,
}
#[tauri::command]
pub fn get_custom_themes() -> Vec<CustomTheme> {
    let mut themes = Vec::new();
    let Ok(entries) = std::fs::read_dir(crate::paths::themes_dir()) else {
        return themes;
    };
    for entry in entries.flatten() {
        let file_path = entry.path();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file || file_path.extension().and_then(|s| s.to_str()) != Some("css") {
            continue;
        }
        let Some(name) = file_path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Ok(css) = std::fs::read_to_string(&file_path) {
            themes.push(CustomTheme {
                name: name.to_string(),
                css,
            });
        }
    }
    themes
}
