use std::path::Path;
use std::time::{Duration, SystemTime};
/// Cheap fingerprint of the themes folder: file names, sizes and mtimes.
/// Compared after each folder change notification, so only real edits to
/// .css files reach the frontend.
fn themes_signature() -> Vec<(String, u64, u128)> {
    signature_of(&crate::paths::themes_dir())
}
fn signature_of(dir: &Path) -> Vec<(String, u64, u128)> {
    let mut entries: Vec<(String, u64, u128)> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("css") {
                    return None;
                }
                let meta = entry.metadata().ok()?;
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                Some((
                    file_key(&path),
                    meta.len(),
                    modified,
                ))
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    entries.sort();
    entries
}
fn file_key(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}
/// Watches `themes/` and emits `themes-changed` whenever a .css file is
/// added, edited or removed. The frontend reloads the preset list on that event.
pub fn watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut previous = themes_signature();
        let mut changes = ChangeWaiter::default();
        loop {
            changes.wait();
            // Editors often save in several steps; let them finish first.
            std::thread::sleep(Duration::from_millis(200));
            changes.rearm();
            let current = themes_signature();
            if current != previous {
                previous = current;
                let _ = tauri::Emitter::emit(&app, "themes-changed", ());
            }
        }
    });
}
/// Sleeps until Windows reports a change in the folder (names, sizes, write
/// times) instead of re-reading it every second while Umbra sits in the tray.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct ChangeWaiter {
    handle: Option<windows_sys::Win32::Foundation::HANDLE>,
}
#[cfg(target_os = "windows")]
impl ChangeWaiter {
    fn wait(&mut self) {
        use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
        match self.handle.or_else(|| self.open()) {
            Some(handle) => unsafe {
                WaitForSingleObject(handle, INFINITE);
            },
            // Could not watch the folder (it may be missing for a moment): poll.
            None => std::thread::sleep(Duration::from_secs(2)),
        }
    }
    /// Asks for the next change. Changes made since the wait returned still
    /// signal the handle, so none are missed while the signature is read.
    fn rearm(&mut self) {
        use windows_sys::Win32::Storage::FileSystem::{FindCloseChangeNotification, FindNextChangeNotification};
        if let Some(handle) = self.handle {
            if unsafe { FindNextChangeNotification(handle) } == 0 {
                // The folder went away; open a fresh watch next time.
                unsafe { FindCloseChangeNotification(handle) };
                self.handle = None;
            }
        }
    }
    fn open(&mut self) -> Option<windows_sys::Win32::Foundation::HANDLE> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            FindFirstChangeNotificationW, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
            FILE_NOTIFY_CHANGE_SIZE,
        };
        let dir: Vec<u16> = crate::paths::themes_dir()
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            FindFirstChangeNotificationW(
                dir.as_ptr(),
                0,
                FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE,
            )
        };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        self.handle = Some(handle);
        self.handle
    }
}
#[cfg(not(target_os = "windows"))]
#[derive(Default)]
struct ChangeWaiter;
#[cfg(not(target_os = "windows"))]
impl ChangeWaiter {
    fn wait(&mut self) {
        std::thread::sleep(Duration::from_millis(1000));
    }
    fn rearm(&mut self) {}
}
#[cfg(test)]
mod tests {
    use super::signature_of;
    #[test]
    fn signature_sees_css_edits_and_ignores_other_files() {
        let dir = std::env::temp_dir().join(format!("umbra-themes-sig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.css"), "a{}").unwrap();
        std::fs::write(dir.join("a.css"), "b{}").unwrap();
        let first = signature_of(&dir);
        let names: Vec<&str> = first.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(names, vec!["a.css", "b.css"], "sorted, so read order does not matter");
        std::fs::write(dir.join("notes.txt"), "not a theme").unwrap();
        assert_eq!(signature_of(&dir), first, "other files are not themes");
        std::fs::write(dir.join("a.css"), "b{color:red}").unwrap();
        assert_ne!(signature_of(&dir), first, "an edit changes the size");
        let _ = std::fs::remove_dir_all(&dir);
    }
}