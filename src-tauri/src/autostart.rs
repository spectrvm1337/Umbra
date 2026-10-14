const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME: &str = "Umbra";
/// Pre-0.1.3 value name, removed once the current one has been written.
const LEGACY_VALUE_NAME: &str = "SpotlightSearch";
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
/// What the Run value should hold for this exe: its path, quoted when it has spaces.
#[cfg(target_os = "windows")]
fn run_command() -> Option<String> {
    let path = std::env::current_exe().ok()?.to_string_lossy().to_string();
    Some(if path.contains(' ') { format!("\"{path}\"") } else { path })
}
pub fn is_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        let stored = crate::registry::Key::open(HKEY_CURRENT_USER, RUN_KEY)
            .and_then(|key| key.string(VALUE_NAME).or_else(|| key.string(LEGACY_VALUE_NAME)));
        match (stored, std::env::current_exe()) {
            (Some(v), Ok(p)) => {
                let p = p.to_string_lossy().to_string();
                v == p || v == format!("\"{}\"", p)
            }
            (Some(_), Err(_)) => true,
            _ => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}
pub fn set_enabled(enable: bool) {
    #[cfg(target_os = "windows")]
    {
        if !enable {
            if let Some(key) = crate::registry::Key::open_writable(HKEY_CURRENT_USER, RUN_KEY) {
                key.delete_value(VALUE_NAME);
                key.delete_value(LEGACY_VALUE_NAME);
            }
            return;
        }
        ensure_autostart();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enable;
    }
}
pub fn ensure_autostart() {
    #[cfg(target_os = "windows")]
    {
        let Some(command) = run_command() else {
            return;
        };
        let Some(key) = crate::registry::Key::open_writable(HKEY_CURRENT_USER, RUN_KEY) else {
            return;
        };
        if key.string(VALUE_NAME).as_deref() != Some(command.as_str()) {
            key.set_string(VALUE_NAME, &command);
        }
        // Drop the pre-0.1.3 Run value so the app never starts twice.
        key.delete_value(LEGACY_VALUE_NAME);
    }
}
