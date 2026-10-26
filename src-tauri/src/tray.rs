use crate::sync::LockExt;
use tauri::Manager;
const TRAY_ID: &str = "umbra";
struct Labels {
    open: &'static str,
    settings: &'static str,
    reindex: &'static str,
    pause: &'static str,
    restart: &'static str,
    quit: &'static str,
    paused: &'static str,
}
/// The tray menu follows the UI language (en / ru / de / ja).
fn labels(lang: &str) -> Labels {
    match lang {
        "ru" => Labels {
            open: "Открыть Umbra",
            settings: "Настройки",
            reindex: "Переиндексировать",
            pause: "Приостановить хоткей",
            restart: "Перезапустить",
            quit: "Выйти",
            paused: "на паузе",
        },
        "de" => Labels {
            open: "Umbra öffnen",
            settings: "Einstellungen",
            reindex: "Neu indexieren",
            pause: "Tastenkürzel pausieren",
            restart: "Neu starten",
            quit: "Beenden",
            paused: "pausiert",
        },
        "ja" => Labels {
            open: "Umbraを開く",
            settings: "設定",
            reindex: "再インデックス",
            pause: "ホットキーを一時停止",
            restart: "再起動",
            quit: "終了",
            paused: "一時停止中",
        },
        _ => Labels {
            open: "Open Umbra",
            settings: "Settings",
            reindex: "Re-index files",
            pause: "Pause hotkey",
            restart: "Restart",
            quit: "Quit",
            paused: "paused",
        },
    }
}
/// One row of the tray menu as the page draws it.
#[derive(serde::Serialize)]
pub struct TrayItem {
    id: &'static str,
    label: &'static str,
    /// Some for the check item (Pause hotkey).
    checked: Option<bool>,
    /// A divider line goes above this row.
    divider: bool,
}
fn menu_items() -> Vec<TrayItem> {
    let l = labels(&crate::config::get_language());
    let item = |id, label| TrayItem { id, label, checked: None, divider: false };
    vec![
        item("open", l.open),
        item("settings", l.settings),
        item("reindex", l.reindex),
        TrayItem { id: "pause", label: l.pause, checked: Some(crate::keyboard_hook::is_paused()), divider: false },
        TrayItem { id: "restart", label: l.restart, checked: None, divider: true },
        item("quit", l.quit),
    ]
}
/// "Umbra · Alt+Space", so the hotkey is one hover away.
fn tooltip() -> String {
    let hotkey = crate::config::get_hotkey();
    if crate::keyboard_hook::is_paused() {
        let l = labels(&crate::config::get_language());
        format!("Umbra · {hotkey} ({})", l.paused)
    } else {
        format!("Umbra · {hotkey}")
    }
}
/// Updates the tooltip after the language, the hotkey or the pause state
/// changed (the menu itself is built each time it opens).
pub fn refresh(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip()));
    }
    let _ = tauri::Emitter::emit_to(app, MENU_LABEL, "tray-menu-refresh", ());
}
fn handle_action(app: &tauri::AppHandle, id: &str) {
    match id {
        "open" | "settings" => {
            if let Some(window) = app.get_webview_window("main") {
                crate::show_window_with(&window, id == "settings");
            }
        }
        "reindex" => {
            crate::indexer::init_index_with_progress(app.clone());
        }
        "pause" => {
            crate::keyboard_hook::set_paused(!crate::keyboard_hook::is_paused());
            refresh(app);
        }
        "restart" => {
            crate::storage::flush_pending();
            app.restart();
        }
        "quit" => {
            crate::storage::flush_pending();
            // app.exit lets Tauri shut down properly (the tray icon is removed
            // instead of lingering until the mouse passes over it).
            app.exit(0);
        }
        _ => {}
    }
}
// ---- the menu window ----
//
// Right-clicking the icon opens a small Umbra-styled window (tray-menu.html)
// instead of the system menu. It is created hidden at start; on a right-click
// the cursor position is remembered and the page is asked to draw the items,
// then it calls tray_menu_present with its size and is shown next to the
// cursor, inside the work area of that monitor. It hides when it loses focus.
const MENU_LABEL: &str = "tray-menu";
static ANCHOR: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);
fn create_menu_window(app: &tauri::App) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::new(app, MENU_LABEL, tauri::WebviewUrl::App("tray-menu.html".into()))
        .title("Umbra")
        .inner_size(240.0, 300.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;
    let menu = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = menu.hide();
        }
    });
    Ok(())
}
fn open_menu(app: &tauri::AppHandle, x: f64, y: f64) {
    *ANCHOR.lock_or_recover() = Some((x, y));
    let _ = tauri::Emitter::emit_to(app, MENU_LABEL, "tray-menu-show", ());
}
/// Where a menu of `w` x `h` physical pixels goes for a click at (x, y): above
/// and to the left of the cursor like the system menu, flipped when that would
/// leave the work area (taskbar at the top or on the left), then kept inside it.
fn menu_position(x: f64, y: f64, w: f64, h: f64, area: (f64, f64, f64, f64)) -> (f64, f64) {
    let (left, top, right, bottom) = area;
    let mut px = x - w;
    if px < left {
        px = x;
    }
    let mut py = y - h;
    if py < top {
        py = y;
    }
    (px.clamp(left, (right - w).max(left)), py.clamp(top, (bottom - h).max(top)))
}
#[tauri::command]
pub fn tray_menu_items() -> Vec<TrayItem> {
    menu_items()
}
/// Called by the menu page once it has drawn the items; `width` / `height` are
/// its size in CSS pixels.
#[tauri::command]
pub fn tray_menu_present(app: tauri::AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(MENU_LABEL) else {
        return;
    };
    // Normally the right-click position; otherwise wherever the cursor is.
    let anchor = ANCHOR.lock_or_recover().take();
    let Some((x, y)) = anchor.or_else(|| app.cursor_position().ok().map(|p| (p.x, p.y))) else {
        return;
    };
    let monitor = app.monitor_from_point(x, y).ok().flatten();
    let scale = monitor.as_ref().map_or(1.0, |m| m.scale_factor());
    let (w, h) = (width * scale, height * scale);
    let area = match &monitor {
        Some(m) => {
            let wa = m.work_area();
            let (l, t) = (wa.position.x as f64, wa.position.y as f64);
            (l, t, l + wa.size.width as f64, t + wa.size.height as f64)
        }
        None => (f64::MIN / 4.0, f64::MIN / 4.0, f64::MAX / 4.0, f64::MAX / 4.0),
    };
    let (px, py) = menu_position(x, y, w, h, area);
    let _ = window.set_size(tauri::PhysicalSize::new(w.round() as u32, h.round() as u32));
    let _ = window.set_position(tauri::PhysicalPosition::new(px.round() as i32, py.round() as i32));
    let _ = window.show();
    let _ = window.set_focus();
}
#[tauri::command]
pub fn tray_menu_action(app: tauri::AppHandle, id: String) {
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = window.hide();
    }
    handle_action(&app, &id);
}
#[tauri::command]
pub fn tray_menu_hide(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = window.hide();
    }
}
pub fn create(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    create_menu_window(app)?;
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(tooltip())
        .on_tray_icon_event(|tray, event| {
            let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, position, .. } = event else {
                return;
            };
            let app = tray.app_handle();
            match button {
                MouseButton::Left => {
                    if let Some(window) = app.get_webview_window("main") {
                        crate::show_window(&window);
                    }
                }
                MouseButton::Right => open_menu(app, position.x, position.y),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::menu_position;
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1032.0); // taskbar at the bottom
    #[test]
    fn opens_above_and_left_of_the_cursor() {
        assert_eq!(menu_position(1800.0, 1050.0, 240.0, 300.0, SCREEN), (1560.0, 732.0));
    }
    #[test]
    fn flips_and_stays_inside_the_work_area() {
        // Taskbar at the top: the menu opens below the cursor.
        assert_eq!(menu_position(1800.0, 10.0, 240.0, 300.0, (0.0, 40.0, 1920.0, 1080.0)), (1560.0, 40.0));
        // Taskbar on the left: the menu opens to the right of the cursor.
        assert_eq!(menu_position(20.0, 900.0, 240.0, 300.0, (60.0, 0.0, 1920.0, 1080.0)), (60.0, 600.0));
    }
}
