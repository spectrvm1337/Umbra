use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder};
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
fn build_menu<R: tauri::Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Menu<R>> {
    let l = labels(&crate::config::get_language());
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::new(l.open).id("open").build(app)?)
        .item(&MenuItemBuilder::new(l.settings).id("settings").build(app)?)
        .item(&MenuItemBuilder::new(l.reindex).id("reindex").build(app)?)
        .item(
            &CheckMenuItemBuilder::new(l.pause)
                .id("pause")
                .checked(crate::keyboard_hook::is_paused())
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::new(l.restart).id("restart").build(app)?)
        .item(&MenuItemBuilder::new(l.quit).id("quit").build(app)?)
        .build()
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
/// Rebuilds the menu and tooltip after the language, the hotkey or the pause
/// state changed.
pub fn refresh(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_tooltip(Some(tooltip()));
    }
}
pub fn create(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let menu = build_menu(app)?;
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip(tooltip())
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" | "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    crate::show_window_with(&window, event.id.as_ref() == "settings");
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
                let _ = app.restart();
            }
            "quit" => {
                crate::storage::flush_pending();
                // app.exit lets Tauri shut down properly (the tray icon is removed
                // instead of lingering until the mouse passes over it).
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    crate::show_window(&window);
                }
            }
        })
        .build(app)?;
    Ok(())
}
