

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
pub fn get_pins() -> Vec<search::SearchResult> {
    pins::load_pins()
        .iter()
        .map(|p| search::SearchResult {
            name: p.name.clone(),
            path: p.path.clone(),
            kind: p.kind.clone(),
            icon: p.kind.clone(),
            pinned: true,
            icon_data: None,
            score: search::ScoreKey::default(),
        })
        .collect()
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
        "Alt+Space".to_string()
    }
}

#[tauri::command]
pub fn set_hotkey(_app: tauri::AppHandle, key: String) -> Result<String, String> {
    let k = key.trim();
    if !crate::keyboard_hook::is_supported_hotkey(k) {
        return Err(
            "Hotkey must be a modifier (Ctrl, Alt, Shift, Super) plus a letter, digit, F1-F12, Space or arrow key, e.g. Ctrl+Shift+P".to_string(),
        );
    }

    config::set_hotkey(k);
    crate::keyboard_hook::update_hotkey();

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
pub fn set_theme(theme: config::ThemeConfig) -> config::ThemeConfig {
    config::set_theme(theme)
}

#[tauri::command]
pub fn get_language() -> String {
    config::get_language()
}

#[tauri::command]
pub fn set_language(lang: String) -> String {
    config::set_language(lang)
}

#[tauri::command]
pub fn get_index_excludes() -> Vec<String> {
    config::get_index_excludes()
}

#[tauri::command]
pub fn set_index_excludes(excludes: Vec<String>) -> Vec<String> {
    config::set_index_excludes(excludes);
    config::get_index_excludes()
}

#[tauri::command]
pub fn get_index_defaults() -> Vec<String> {
    config::get_default_index_excludes()
}

#[tauri::command]
pub fn get_disabled_kinds() -> Vec<u8> {
    config::get_disabled_kinds()
}

#[tauri::command]
pub fn set_kind_enabled(kind: u8, enabled: bool) -> Vec<u8> {
    let mut kinds = config::get_disabled_kinds();
    if enabled {
        kinds.retain(|&k| k != kind);
    } else {
        if kind <= 10 && !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds.sort();
    kinds.dedup();
    config::set_disabled_kinds(kinds);
    config::get_disabled_kinds()
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
pub fn set_drive_enabled(drive: String, enabled: bool) -> Vec<String> {
    let mut drives = config::get_disabled_drives();
    let d = drive.trim().to_uppercase();
    if enabled {
        drives.retain(|x| x != &d);
    } else {
        if !drives.contains(&d) {
            drives.push(d);
        }
    }
    config::set_disabled_drives(drives);
    config::get_disabled_drives()
}

#[tauri::command]
pub fn open_themes_folder(app: tauri::AppHandle) -> Result<(), String> {
    let mut path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    path.push("themes");
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    std::process::Command::new("explorer")
        .arg(path.to_string_lossy().as_ref())
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
pub fn get_custom_themes(app: tauri::AppHandle) -> Vec<CustomTheme> {
    let mut themes = Vec::new();
    if let Ok(mut path) = app.path().app_config_dir() {
        path.push("themes");
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        let file_path = entry.path();
                        if file_path.extension().and_then(|s| s.to_str()) == Some("css") {
                            if let Some(name) = file_path.file_stem().and_then(|s| s.to_str()) {
                                if let Ok(css) = std::fs::read_to_string(&file_path) {
                                    themes.push(CustomTheme {
                                        name: name.to_string(),
                                        css,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    themes
}
