#![windows_subsystem = "windows"]

mod autostart;
mod commands;
mod config;
mod frecency;
mod icons;
mod indexer;
mod pins;
mod search;
mod storage;
mod taskbar;
mod tray;
mod keyboard_hook;

use tauri::Emitter;
use tauri::Manager;

fn remove_sysmenu(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, WS_SYSMENU,
                SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_FRAMECHANGED,
            };
            let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
            let mut style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            style &= !(WS_SYSMENU as isize);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style);
            SetWindowPos(
                hwnd,
                0 as _,
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        }
    }
}

pub fn show_chat_window(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    taskbar::show_if_autohide();
    commands::place_chat_window(window.app_handle());
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("chat-shown", ());
}

pub fn show_window(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    taskbar::show_if_autohide();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("window-shown", ());
    indexer::refresh_fast_index_async();

    if !config::is_pinned() {
        commands::place_window(window.app_handle());
    }
}

fn main() {
    let _ = rayon::ThreadPoolBuilder::new().num_threads(3).build_global();
    tauri::Builder::default()

        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                crate::show_window(&w);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            indexer::init_index_with_progress(app.handle().clone());
            let window = app.get_webview_window("main").unwrap();
            remove_sysmenu(&window);

            if let Some((x, y)) = config::pinned_position() {
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }

            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            if let Some(chat) = app.get_webview_window("chat") {
                remove_sysmenu(&chat);
                let chat_win = chat.clone();
                if let Err(e) = app.global_shortcut().on_shortcut("Ctrl+Alt+Space", move |_app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if chat_win.is_visible().unwrap_or(false) {
                            let _ = chat_win.emit("window-hide-requested", ());
                        } else {
                            show_chat_window(&chat_win);
                        }
                    }
                }) {
                    eprintln!("Failed to register global shortcut 'Ctrl+Alt+Space': {}", e);
                }

                let chat_focus = chat.clone();
                chat.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        if !focused {
                            let win = chat_focus.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(150));
                                if win.is_focused().unwrap_or(true) {
                                    return;
                                }
                                let _ = win.emit("window-hide-requested", ());
                            });
                        }
                    }
                });
            }

            crate::keyboard_hook::init(app.handle().clone());

            let win_focus = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    if !focused {
                        let win = win_focus.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            if win.is_focused().unwrap_or(true) {
                                return;
                            }
                            let _ = win.emit("window-hide-requested", ());
                        });
                    }
                }
            });

            #[cfg(target_os = "windows")]
            tray::create(app)?;

            #[cfg(target_os = "windows")]
            if config::get_autostart() {
                autostart::ensure_autostart();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_all,
            commands::launch_item,
            commands::launch_admin,
            commands::kill_process,
            commands::exec_power_command,
            commands::get_pins,
            commands::add_pin,
            commands::remove_pin,
            commands::reorder_pins,
            commands::get_index_status,
            commands::hide_window,
            commands::hide_chat_window,
            commands::get_icons,
            commands::recenter_window,
            commands::resize_main_window,
            commands::get_hotkey,
            commands::set_hotkey,
            commands::get_zoom,
            commands::set_zoom,
            commands::get_autostart,
            commands::set_autostart,
            commands::get_theme,
            commands::set_theme,
            commands::get_language,
            commands::set_language,
            commands::get_window_pin,
            commands::set_window_pin,
            commands::get_placement,
            commands::set_placement,
            commands::list_monitors,
            commands::reindex,
            commands::get_index_excludes,
            commands::set_index_excludes,
            commands::get_index_defaults,
            commands::get_disabled_kinds,
            commands::set_kind_enabled,
            commands::get_available_drives,
            commands::get_disabled_drives,
            commands::set_drive_enabled,
            commands::open_themes_folder,
            commands::get_custom_themes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
