#![windows_subsystem = "windows"]
mod autostart;
mod backdrop;
mod blur;
mod color_pick;
mod commands;
mod config;
mod favicon;
mod frecency;
mod icons;
mod index_cache;
mod index_watch;
mod indexer;
mod paths;
mod picks;
mod pins;
mod program_version;
mod preview;
mod registry;
mod search;
mod storage;
mod sync;
mod taskbar;
mod themes;
mod tray;
mod updater;
mod winhttp;
mod keyboard_hook;
use crate::sync::LockExt;
use tauri::Emitter;
use tauri::Manager;
fn remove_sysmenu(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, WS_EX_APPWINDOW,
                WS_EX_TOOLWINDOW, WS_SYSMENU, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_FRAMECHANGED,
            };
            let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
            let mut style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            style &= !(WS_SYSMENU as isize);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style);
            // A tool window, never in Alt+Tab or on the taskbar: as an app window it was listed in
            // Alt+Tab whenever it was up, and a window left showing a page that could not load stayed
            // there for good.
            let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            ex = (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
            SetWindowPos(
                hwnd,
                0 as _,
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        }
    }
}
pub fn show_window(window: &tauri::WebviewWindow) {
    show_window_with(window, false);
}
/// When the window was last shown; a focus lost right after it is a game taking the foreground
/// back, not the user clicking away (see the Focused handler in main).
static LAST_SHOWN: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
/// Whether the window in front belongs to Umbra.
pub fn is_in_front(_window: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let mut pid = 0u32;
        GetWindowThreadProcessId(GetForegroundWindow(), &mut pid);
        return pid == std::process::id();
    }
    #[cfg(not(target_os = "windows"))]
    _window.is_focused().unwrap_or(false)
}
/// Puts the window in front of everything, a full-screen game included. Windows gives the
/// foreground only to the program that got the last input, which for a hotkey seen by a hook is
/// the game; so the call borrows the input state of the window in front (AttachThreadInput) instead
/// of the usual trick of faking an Alt press, which a game that uses Alt would see as one.
pub fn bring_to_front(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow, SetWindowPos,
            HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        if let Ok(h) = window.hwnd() {
            let hwnd = h.0 as HWND;
            unsafe {
                // The top of the always-on-top band, above a borderless game that is topmost too.
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                if SetForegroundWindow(hwnd) == 0 || GetForegroundWindow() != hwnd {
                    let front = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
                    let me = GetCurrentThreadId();
                    let attached = front != 0 && front != me && AttachThreadInput(me, front, 1) != 0;
                    BringWindowToTop(hwnd);
                    SetForegroundWindow(hwnd);
                    if attached {
                        AttachThreadInput(me, front, 0);
                    }
                }
            }
            if is_in_front(window) {
                return;
            }
        }
    }
    // Last resort: the window library's own way (it fakes the Alt press).
    let _ = window.set_focus();
}
/// Shows the window; with `open_settings` the page opens the settings panel as
/// part of the same "window-shown" event (the tray's Settings item).
pub fn show_window_with(window: &tauri::WebviewWindow, open_settings: bool) {
    // What was behind the window when it last went away (contrast.js); never taken here, see backdrop.rs.
    let backdrop = backdrop::latest();
    #[cfg(target_os = "windows")]
    taskbar::show_if_autohide();
    // Woken first, so the page is running again by the time the window and "window-shown" arrive.
    commands::set_webview_awake(window, true);
    // Placed before it is shown, raised by the slide, and then it comes down into place with the
    // page's fade (commands::slide_in_*). Already up (tray Settings, a second launch), it just
    // glides to where it belongs, as before.
    let was_visible = window.is_visible().unwrap_or(false);
    let rest = commands::resting_place(window);
    if let (false, Some(rest)) = (was_visible, rest) {
        commands::slide_in_start(window, rest);
    }
    let _ = window.show();
    *LAST_SHOWN.lock_or_recover() = Some(std::time::Instant::now());
    bring_to_front(window);
    let _ = window.emit("window-shown", serde_json::json!({ "openSettings": open_settings, "backdrop": backdrop }));
    indexer::warm_async();
    // A hidden window comes down when the page starts its fade (commands::slide_in_start).
    if let (true, Some(rest)) = (was_visible, rest) {
        commands::glide_to(window, rest);
    }
}
fn main() {
    // Everything opened from Umbra inherits its environment. Started from a terminal that sets this,
    // cmd stops looking in the current folder, and a batch file calling another one beside it
    // (`call gradlew.bat`) failed to find it; opened from Explorer it would have worked.
    std::env::remove_var("NoDefaultCurrentDirectoryInExePath");
    preview::install_panic_hook();
    let _ = rayon::ThreadPoolBuilder::new().num_threads(3).build_global();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                crate::show_window(&w);
            }
        }))
        .setup(|app| {
            paths::migrate_legacy_config_dir();
            storage::remove_stale_temp_files(&paths::config_dir());
            updater::remove_replaced_copy();
            // No config file yet: a fresh install, nothing has been saved so far.
            let fresh_install = !paths::config_file().exists();
            indexer::init_index_with_progress(app.handle().clone());
            #[cfg(target_os = "windows")]
            index_watch::start(app.handle().clone());
            let window = app.get_webview_window("main").unwrap();
            remove_sysmenu(&window);
            crate::keyboard_hook::guard_system_menu(&window);
            if let Some((x, y)) = config::pinned_position() {
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
            crate::keyboard_hook::init(app.handle().clone());
            let hook_ok = crate::keyboard_hook::is_installed();
            if fresh_install {
                config::save_defaults();
            }
            // A setup that was closed half way is shown again; a config from before it existed is done.
            let first_run = fresh_install || !config::get_setup_done();
            if first_run || !hook_ok {
                commands::set_welcome(app.handle(), commands::Welcome { hotkey: config::get_hotkey(), hook_ok, first_run });
            }
            themes::watch(app.handle().clone());
            blur::apply(app.handle());
            // Started hidden (autostart): the page gets a few seconds to load, then sleeps until the
            // first summon instead of only after the first hide.
            // The wallpaper behind the window for the first summon (contrast.js).
            backdrop::refresh_later(&window, 1500);
            let sleeper = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                if !sleeper.is_visible().unwrap_or(true) {
                    commands::set_webview_awake(&sleeper, false);
                }
            });
            let win_focus = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    if !focused {
                        let win = win_focus.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            // The eyedropper keeps the window up while the cursor roams the screen.
                            // Already hidden (the focus went because the window did): nothing to hide.
                            // Asked anyway, the page ran its close again, and a summon in that moment
                            // was closed by it.
                            if win.is_focused().unwrap_or(true) || color_pick::is_picking() || !win.is_visible().unwrap_or(false) {
                                return;
                            }
                            // Lost within a moment of being shown: a full-screen game taking the
                            // foreground straight back. The window takes it once more instead of
                            // going away, which looked like the hotkey not working.
                            let just_shown = LAST_SHOWN
                                .lock_or_recover()
                                .take()
                                .is_some_and(|t| t.elapsed() < std::time::Duration::from_millis(700));
                            if just_shown {
                                let again = win.clone();
                                let _ = win.run_on_main_thread(move || bring_to_front(&again));
                                return;
                            }
                            let _ = win.emit("window-hide-requested", ());
                        });
                    }
                }
            });
            #[cfg(target_os = "windows")]
            tray::create(app)?;
            // Debug builds (tauri dev) leave the Run value alone: otherwise every dev run
            // points Windows' autostart at target\debug\umbra.exe instead of the
            // installed app.
            #[cfg(target_os = "windows")]
            if config::get_autostart() && !cfg!(debug_assertions) {
                autostart::ensure_autostart();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_all,
            commands::get_recent_items,
            commands::launch_item,
            commands::launch_admin,
            commands::reveal_in_explorer,
            commands::record_pick,
            favicon::fetch_favicon,
            commands::kill_process,
            commands::find_process,
            commands::exec_power_command,
            commands::add_pin,
            commands::remove_pin,
            commands::reorder_pins,
            commands::get_index_status,
            commands::hide_window,
            commands::set_window_motion,
            commands::set_window_lift,
            commands::window_slide_out,
            commands::window_slide_in,
            commands::stop_window_motion,
            commands::get_icons,
            commands::recenter_window,
            commands::resize_main_window,
            commands::get_hotkey,
            commands::set_hotkey,
            commands::get_zoom,
            commands::set_zoom,
            commands::get_autostart,
            commands::set_autostart,
            commands::finish_setup,
            commands::get_keybinds,
            commands::set_keybinds,
            commands::get_preview_style,
            commands::set_preview_style,
            commands::get_theme,
            commands::set_theme,
            commands::get_language,
            commands::get_system_theme,
            commands::set_language,
            commands::get_window_pin,
            commands::take_welcome,
            tray::tray_menu_items,
            tray::tray_menu_present,
            tray::tray_menu_ready,
            tray::tray_menu_action,
            tray::tray_menu_hide,
            commands::set_window_pin,
            commands::get_placement,
            commands::set_placement,
            commands::list_monitors,
            commands::reindex,
            commands::get_index_options,
            commands::set_index_option,
            commands::get_disabled_kinds,
            commands::set_kind_enabled,
            commands::get_available_drives,
            commands::get_disabled_drives,
            commands::set_drive_enabled,
            commands::get_anim_off,
            commands::set_anim_off,
            commands::open_themes_folder,
            commands::get_custom_themes,
            commands::get_app_version,
            commands::check_for_updates,
            commands::download_update,
            commands::install_update,
            color_pick::start_color_pick,
            color_pick::cancel_color_pick,
            color_pick::set_pick_exclusion,
            commands::dock_window_for_pick,
            preview::get_preview,
            blur::set_blur_shapes,
            blur::set_blur_fade,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
