use std::sync::{Mutex, OnceLock};
use std::time::{Instant, Duration};
use tauri::{AppHandle, Manager, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, WH_KEYBOARD_LL, KBDLLHOOKSTRUCT, SC_KEYMENU, WM_KEYDOWN,
    WM_SYSCOMMAND, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP,
};
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static HOOK_HANDLE: OnceLock<isize> = OnceLock::new();
#[derive(Clone, Default, Debug, PartialEq)]
struct HotkeyDef {
    vk: u16,
    alt: bool,
    ctrl: bool,
    shift: bool,
    win: bool,
}
static CURRENT_HOTKEY: OnceLock<Mutex<HotkeyDef>> = OnceLock::new();
static LAST_TRIGGER: OnceLock<Mutex<Instant>> = OnceLock::new();
static SUPPRESS_KEYUP: OnceLock<Mutex<bool>> = OnceLock::new();
/// Tray "Pause hotkey": the hook lets every key through until it is turned off.
static PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn is_paused() -> bool {
    PAUSED.load(std::sync::atomic::Ordering::Relaxed)
}
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, std::sync::atomic::Ordering::Relaxed);
}
/// False when SetWindowsHookExW failed, i.e. the hotkey cannot work this session.
pub fn is_installed() -> bool {
    HOOK_HANDLE.get().is_some()
}
pub fn init(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
    update_hotkey();
    unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
        if !hook.is_null() {
            let _ = HOOK_HANDLE.set(hook as isize);
        }
    }
}
/// While Umbra itself has focus, Alt+Space doesn't reach the hook: Windows turns it into
/// WM_SYSCOMMAND / SC_KEYMENU for the window, which opens the system menu (Restore, Move,
/// Close...) before the page ever sees the Space. Umbra has no use for that menu, or for
/// the menu mode a lone Alt enters, so the window drops both, and Alt+Space hides Umbra
/// when it is the hotkey.
pub fn guard_system_menu(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetWindowSubclass(hwnd.0 as HWND, Some(system_menu_proc), 1, 0);
        }
    }
}
unsafe extern "system" fn system_menu_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_SYSCOMMAND && (wparam as u32 & 0xFFF0) == SC_KEYMENU {
        let alt_space = HotkeyDef { vk: 0x20, alt: true, ..Default::default() };
        let is_hotkey = CURRENT_HOTKEY.get().is_some_and(|m| *m.lock().unwrap() == alt_space);
        if lparam == 0x20 && is_hotkey {
            if let Some(win) = APP_HANDLE.get().and_then(|app| app.get_webview_window("main")) {
                let _ = win.emit("window-hide-requested", ());
            }
        }
        return 0;
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
const DEFAULT_HOTKEY: &str = "alt+space";
/// Falls back to the built-in default when the stored hotkey is unusable
/// (empty, no modifier, unknown key).
fn effective_hotkey() -> String {
    let stored = crate::config::get_hotkey();
    if is_supported_hotkey(&stored) {
        return stored;
    }
    if is_supported_hotkey(DEFAULT_HOTKEY) {
        return DEFAULT_HOTKEY.to_string();
    }
    crate::config::DEFAULT_HOTKEY.to_string()
}
fn key_to_vk(key: &str) -> Option<u16> {
    let vk = match key {
        "space" => 0x20,
        "enter" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "left" | "arrowleft" => 0x25,
        "up" | "arrowup" => 0x26,
        "right" | "arrowright" => 0x27,
        "down" | "arrowdown" => 0x28,
        _ => {
            let bytes = key.as_bytes();
            match bytes {
                [c] if c.is_ascii_alphabetic() => c.to_ascii_uppercase() as u16,
                [c] if c.is_ascii_digit() => *c as u16,
                [b'f', rest @ ..] => match std::str::from_utf8(rest).ok()?.parse::<u16>().ok()? {
                    n @ 1..=12 => 0x70 + n - 1,
                    _ => return None,
                },
                _ => return None,
            }
        }
    };
    Some(vk)
}
fn parse_hotkey(hotkey: &str) -> Option<HotkeyDef> {
    let mut def = HotkeyDef::default();
    for part in hotkey.trim().to_lowercase().split('+').map(str::trim) {
        match part {
            "alt" => def.alt = true,
            "ctrl" | "control" => def.ctrl = true,
            "shift" => def.shift = true,
            "super" | "meta" | "win" | "cmd" | "command" => def.win = true,
            key if def.vk == 0 => def.vk = key_to_vk(key)?,
            _ => return None,
        }
    }
    let has_modifier = def.alt || def.ctrl || def.shift || def.win;
    (def.vk != 0 && has_modifier).then_some(def)
}
pub fn is_supported_hotkey(hotkey: &str) -> bool {
    parse_hotkey(hotkey).is_some()
}
pub fn update_hotkey() {
    let def = parse_hotkey(&effective_hotkey()).unwrap_or_default();
    let guard = CURRENT_HOTKEY.get_or_init(|| Mutex::new(def.clone()));
    *guard.lock().unwrap() = def;
}
fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.emit("window-hide-requested", ());
        } else {
            crate::show_window(&win);
        }
    }
}
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && !is_paused() {
        let w = wparam as u32;
        let kbd = &*(lparam as *const KBDLLHOOKSTRUCT);

        let hotkey = {
            if let Some(m) = CURRENT_HOTKEY.get() {
                m.lock().unwrap().clone()
            } else {
                HotkeyDef::default()
            }
        };
        if hotkey.vk != 0 && kbd.vkCode as u16 == hotkey.vk {
            if w == WM_KEYUP || w == WM_SYSKEYUP {
                let mut supp = SUPPRESS_KEYUP.get_or_init(|| Mutex::new(false)).lock().unwrap();
                if *supp {
                    *supp = false;
                    return 1;
                }
            } else if w == WM_KEYDOWN || w == WM_SYSKEYDOWN {
                let alt_down = (kbd.flags & 0x20) != 0 || (GetAsyncKeyState(0x12) as u16 & 0x8000) != 0;
                let ctrl_down = (GetAsyncKeyState(0x11) as u16 & 0x8000) != 0;
                let shift_down = (GetAsyncKeyState(0x10) as u16 & 0x8000) != 0;
                let win_down = (GetAsyncKeyState(0x5B) as u16 & 0x8000) != 0 || (GetAsyncKeyState(0x5C) as u16 & 0x8000) != 0;
                if alt_down == hotkey.alt
                    && ctrl_down == hotkey.ctrl
                    && shift_down == hotkey.shift
                    && win_down == hotkey.win
                {

                    let mut last = LAST_TRIGGER
                        .get_or_init(|| Mutex::new(Instant::now() - Duration::from_secs(1)))
                        .lock()
                        .unwrap();

                    if last.elapsed() < Duration::from_millis(250) {
                        return 1; 
                    }
                    *last = Instant::now();
                    *SUPPRESS_KEYUP.get_or_init(|| Mutex::new(false)).lock().unwrap() = true;
                    if let Some(app) = APP_HANDLE.get() {
                        // Windows only waits a few hundred ms for a low-level hook and
                        // silently removes one that is too slow, so showing the window
                        // (focus, positioning, starting a re-index) must not happen in
                        // here. run_on_main_thread runs the task inline when called from
                        // the main thread, which this hook is on, so hand it over from
                        // another thread: it is then queued and runs after we return.
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let handle = app.clone();
                            let _ = app.run_on_main_thread(move || toggle_window(&handle));
                        });
                    }
                    return 1;
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn def(vk: u16, alt: bool, ctrl: bool, shift: bool, win: bool) -> HotkeyDef {
        HotkeyDef { vk, alt, ctrl, shift, win }
    }
    #[test]
    fn parses_supported_hotkeys() {
        assert_eq!(parse_hotkey("Alt+Space"), Some(def(0x20, true, false, false, false)));
        assert_eq!(parse_hotkey("Ctrl+Shift+P"), Some(def(0x50, false, true, true, false)));
        assert_eq!(parse_hotkey("Alt+7"), Some(def(0x37, true, false, false, false)));
        assert_eq!(parse_hotkey("Ctrl+F1"), Some(def(0x70, false, true, false, false)));
        assert_eq!(parse_hotkey("Super+F12"), Some(def(0x7B, false, false, false, true)));
        assert_eq!(parse_hotkey("Ctrl+Alt+ArrowUp"), Some(def(0x26, true, true, false, false)));
        assert_eq!(parse_hotkey(" ctrl + q "), Some(def(0x51, false, true, false, false)));
    }
    #[test]
    fn rejects_hotkeys_the_hook_cannot_trigger() {
        for bad in ["", "Space", "Alt", "Ctrl+", "Ctrl+F13", "Ctrl+F0", "Ctrl+-", "Ctrl+/", "Alt+Й", "Ctrl+A+B", "Ctrl+Numpad1"] {
            assert_eq!(parse_hotkey(bad), None, "{bad}");
        }
    }
}
