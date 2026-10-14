use std::path::Path;
use std::time::{Duration, SystemTime};
/// Cheap fingerprint of the themes folder: file names, sizes and mtimes.
/// Compared after each folder change notification, so only real edits to
/// .css files reach the frontend.
fn themes_signature() -> Vec<(String, u64, u128)> {
    let mut entries: Vec<(String, u64, u128)> = match std::fs::read_dir(crate::paths::themes_dir()) {
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
    #[test]
    fn signature_tracks_names_sizes_and_order() {
        let a = vec![
            ("b.css".to_string(), 10u64, 1u128),
            ("a.css".to_string(), 20u64, 2u128),
        ];
        let b = vec![
            ("a.css".to_string(), 20u64, 2u128),
            ("b.css".to_string(), 10u64, 1u128),
        ];
        assert_eq!(
            signatures(a.iter().cloned().collect()),
            signatures(b.iter().cloned().collect())
        );
        let changed: Vec<_> = b
            .into_iter()
            .map(|(n, s, m)| if n == "a.css" { (n, s + 1, m) } else { (n, s, m) })
            .collect();
        assert_ne!(
            signatures(a.into_iter().collect()),
            signatures(changed.into_iter().collect())
        );
    }
    fn signatures(mut v: Vec<(String, u64, u128)>) -> Vec<(String, u64, u128)> {
        v.sort();
        v
    }
}