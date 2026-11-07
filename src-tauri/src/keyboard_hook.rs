use crate::sync::LockExt;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, Duration};
use tauri::{AppHandle, Manager, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, SetTimer,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE,
    SC_KEYMENU, WH_KEYBOARD_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN, WM_KEYUP, WM_SYSCOMMAND, WM_SYSKEYDOWN,
    WM_SYSKEYUP, WM_TIMER,
};
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
/// The current low-level hook (0 while none) and the thread that owns it and its message loop.
static HOOK_HANDLE: AtomicIsize = AtomicIsize::new(0);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
/// Posted to the hook thread: register the hotkey again (it changed, or Pause was toggled).
const WM_APP_REGISTER: u32 = WM_APP + 1;
/// The hotkey's RegisterHotKey id, unique within the hook thread.
const HOTKEY_ID: i32 = 0x5542;
/// How often the hook is installed afresh (see install_hook).
const REINSTALL_MS: u32 = 30_000;
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
/// When the hotkey's key went down, while it is held (cleared when it comes up).
static HELD_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
/// Tray "Pause hotkey": the hook lets every key through until it is turned off.
static PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn is_paused() -> bool {
    PAUSED.load(std::sync::atomic::Ordering::Relaxed)
}
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, std::sync::atomic::Ordering::Relaxed);
    // Paused, the combination is given back to other programs, so it is unregistered too.
    post_to_hook_thread(WM_APP_REGISTER);
}
/// False when SetWindowsHookExW failed, i.e. the hotkey cannot work this session.
pub fn is_installed() -> bool {
    HOOK_HANDLE.load(Ordering::SeqCst) != 0
}
/// The hotkey lives on a thread of its own, which does nothing else. Low-level hooks are called on
/// the thread that installed them, and Windows skips -- and after a few times silently removes -- a
/// hook that does not answer within a few hundred ms. On the UI thread, busy with the page, the blur
/// and IPC, that happened: in a game the hotkey then worked only some of the time, or not at all
/// until Umbra was restarted.
pub fn init(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
    update_hotkey_def();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    let started = std::thread::Builder::new()
        .name("umbra-hotkey".into())
        .spawn(move || unsafe { hook_thread(ready_tx) });
    if started.is_ok() {
        // The first install is waited for, so is_installed() is right when setup asks.
        let _ = ready_rx.recv_timeout(Duration::from_secs(2));
    }
}
unsafe fn hook_thread(ready: std::sync::mpsc::Sender<()>) {
    HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
    let mut msg: MSG = std::mem::zeroed();
    // Creates this thread's message queue, so a message posted from now on is not lost.
    PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
    install_hook();
    register_hotkey();
    let _ = ready.send(());
    SetTimer(std::ptr::null_mut(), 0, REINSTALL_MS, None);
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
        match msg.message {
            WM_TIMER => install_hook(),
            WM_HOTKEY if msg.wParam == HOTKEY_ID as usize => {
                if !is_paused() {
                    trigger();
                }
            }
            WM_APP_REGISTER => register_hotkey(),
            _ => {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}
/// Installs the hook afresh and drops the previous one. Hooks are called newest first, so a game
/// or an overlay (Discord, Steam, the GPU's) that installed its own since, and swallows Alt
/// combinations, would otherwise see the hotkey before Umbra and keep it; a fresh hook is first
/// again. It also brings back a hook Windows dropped for being slow.
unsafe fn install_hook() {
    let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
    if hook.is_null() {
        return; // the old one, if any, stays
    }
    let old = HOOK_HANDLE.swap(hook as isize, Ordering::SeqCst);
    if old != 0 {
        UnhookWindowsHookEx(old as _);
    }
}
/// The same combination as a registered hotkey too, as a fallback the hook makes unnecessary
/// most of the time: when the hook takes the key the registered one never fires. It catches what
/// the hook cannot see -- keys typed into a program running as administrator, whose input a
/// normal process's hook does not get -- and a WM_HOTKEY lets Windows hand Umbra the foreground.
/// Another program holding the same combination just leaves the hook alone to do it.
unsafe fn register_hotkey() {
    UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
    if is_paused() {
        return;
    }
    let def = CURRENT_HOTKEY.get().map(|m| m.lock_or_recover().clone()).unwrap_or_default();
    if def.vk == 0 {
        return;
    }
    let mut mods = MOD_NOREPEAT;
    if def.alt {
        mods |= MOD_ALT;
    }
    if def.ctrl {
        mods |= MOD_CONTROL;
    }
    if def.shift {
        mods |= MOD_SHIFT;
    }
    if def.win {
        mods |= MOD_WIN;
    }
    RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods, def.vk as u32);
}
fn post_to_hook_thread(msg: u32) {
    let thread = HOOK_THREAD.load(Ordering::SeqCst);
    if thread != 0 {
        unsafe { PostThreadMessageW(thread, msg, 0, 0) };
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
        if lparam == 0x20 {
            if let Some(win) = APP_HANDLE.get().and_then(|app| app.get_webview_window("main")) {
                // The page never sees this Space, so Settings could not record Alt+Space as a
                // new hotkey; it is told here instead. One event carries both facts -- the
                // combination and whether it is the hotkey -- because the page alone knows
                // whether it is recording: two separate events used to record the combination
                // and then hide the window straight after.
                let held = |vk: i32| (GetAsyncKeyState(vk) as u16 & 0x8000) != 0;
                let pressed = HotkeyDef { vk: 0x20, alt: true, ctrl: held(0x11), shift: held(0x10), win: false };
                let is_hotkey = CURRENT_HOTKEY.get().is_some_and(|m| *m.lock_or_recover() == pressed);
                let mut combo = String::new();
                if pressed.ctrl {
                    combo.push_str("Ctrl+");
                }
                combo.push_str("Alt+");
                if pressed.shift {
                    combo.push_str("Shift+");
                }
                combo.push_str("Space");
                let _ = win.emit("alt-space-key", serde_json::json!({ "combo": combo, "hotkey": is_hotkey }));
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
    update_hotkey_def();
    post_to_hook_thread(WM_APP_REGISTER);
}
fn update_hotkey_def() {
    let def = parse_hotkey(&effective_hotkey()).unwrap_or_default();
    let guard = CURRENT_HOTKEY.get_or_init(|| Mutex::new(def.clone()));
    *guard.lock_or_recover() = def;
}
/// The hotkey was pressed (by the hook or as a registered hotkey). Within 80 ms it is the same press
/// seen by both; the hook tells a held key from a new press itself (HELD_SINCE), so a quick close
/// and reopen is no longer swallowed, as it was by the 250 ms this used to wait.
fn trigger() {
    let mut last = LAST_TRIGGER
        .get_or_init(|| Mutex::new(Instant::now() - Duration::from_secs(1)))
        .lock_or_recover();
    if last.elapsed() < Duration::from_millis(80) {
        return;
    }
    *last = Instant::now();
    drop(last);
    if let Some(app) = APP_HANDLE.get() {
        // Called from the hotkey thread, so this is queued for the main thread and runs after the
        // hook has returned: showing the window must not happen inside it.
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || toggle_window(&handle));
    }
}
/// Hides the window only when it is the one in front. Visible but behind a game that took the
/// foreground back, it used to be hidden by the press meant to bring it up, so the hotkey seemed
/// to need two or three presses in full screen.
fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) && crate::is_in_front(&win) {
            // From the hotkey: pressed while the page is still fading out, it brings the window back.
            let _ = win.emit("window-hide-requested", serde_json::json!({ "hotkey": true }));
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
                m.lock_or_recover().clone()
            } else {
                HotkeyDef::default()
            }
        };
        if hotkey.vk != 0 && kbd.vkCode as u16 == hotkey.vk {
            if w == WM_KEYUP || w == WM_SYSKEYUP {
                *HELD_SINCE.lock_or_recover() = None;
                let mut supp = SUPPRESS_KEYUP.get_or_init(|| Mutex::new(false)).lock_or_recover();
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
                    *SUPPRESS_KEYUP.get_or_init(|| Mutex::new(false)).lock_or_recover() = true;
                    // Held down, the key repeats: only the first press counts. A repeat comes every
                    // few dozen ms, so a "held" older than half a second is a release the hook
                    // missed, and this is a new press.
                    let mut held = HELD_SINCE.lock_or_recover();
                    let repeat = held.is_some_and(|t| t.elapsed() < Duration::from_millis(500));
                    *held = Some(Instant::now());
                    drop(held);
                    if !repeat {
                        trigger();
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
