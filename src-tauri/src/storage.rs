use crate::sync::LockExt;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = sibling(path, &format!(".{}.{}.tmp", std::process::id(), n));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_ref())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
/// Deletes the temp files `write_atomic` leaves behind when the process is killed
/// mid-write (`index.bin.<pid>.<n>.tmp` can be tens of megabytes). Files of this
/// process are left alone: one of its writes may be under way.
pub fn remove_stale_temp_files(dir: &Path) {
    let own = format!(".{}.", std::process::id());
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp") && !name.contains(&own) && entry.file_type().is_ok_and(|t| t.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}
/// Latest unsaved contents per file. Settings commands run on the UI thread,
/// so they only drop their JSON here; a background thread writes it shortly
/// after, and a burst of clicks becomes a single write.
static PENDING: LazyLock<Mutex<HashMap<PathBuf, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);
/// Held while pending files are taken and written, so an older snapshot can
/// never land on disk after a newer one.
static WRITING: Mutex<()> = Mutex::new(());
const SAVE_DELAY: Duration = Duration::from_millis(300);
pub fn save_later(path: PathBuf, contents: String) {
    PENDING.lock_or_recover().insert(path, contents);
    if FLUSH_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(SAVE_DELAY);
        FLUSH_SCHEDULED.store(false, Ordering::SeqCst);
        flush_pending();
    });
}
/// Writes everything `save_later` still holds. Call before the process exits.
pub fn flush_pending() {
    let _writing = WRITING.lock_or_recover();
    let files = std::mem::take(&mut *PENDING.lock_or_recover());
    for (path, contents) in files {
        let _ = write_atomic(&path, contents);
    }
}
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(data) = fs::read_to_string(path) else {
        return T::default();
    };
    match serde_json::from_str(&data) {
        Ok(value) => value,
        Err(_) => {
            if !data.trim().is_empty() {
                let backup = sibling(path, ".bak");
                if !backup.exists() {
                    let _ = fs::copy(path, &backup);
                }
            }
            T::default()
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("umbra-storage-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
    #[test]
    fn write_atomic_creates_and_replaces_without_leftovers() {
        let dir = temp_dir("write");
        let path = dir.join("nested").join("config.json");
        write_atomic(&path, "first").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        write_atomic(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(files_in(&dir.join("nested")), vec!["config.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn stale_temp_files_of_other_processes_are_removed() {
        let dir = temp_dir("stale");
        fs::write(dir.join("index.bin"), "keep").unwrap();
        fs::write(dir.join("index.bin.3288.1.tmp"), "left by a killed run").unwrap();
        let mine = format!("config.json.{}.7.tmp", std::process::id());
        fs::write(dir.join(&mine), "being written").unwrap();
        remove_stale_temp_files(&dir);
        assert_eq!(files_in(&dir), {
            let mut v = vec!["index.bin".to_string(), mine];
            v.sort();
            v
        });
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn write_atomic_keeps_old_file_when_rename_fails() {
        let dir = temp_dir("fail");
        let path = dir.join("config.json");
        fs::create_dir_all(&path).unwrap();
        assert!(write_atomic(&path, "data").is_err());
        assert!(path.is_dir());
        assert_eq!(files_in(&dir), vec!["config.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn write_atomic_handles_concurrent_writers() {
        let dir = temp_dir("concurrent");
        let path = dir.join("pins.json");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        let _ = write_atomic(&path, format!("[{}]", i));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let content = fs::read_to_string(&path).unwrap();
        assert!(serde_json::from_str::<Vec<u32>>(&content).is_ok(), "got {content:?}");
        assert!(files_in(&dir).iter().all(|n| !n.ends_with(".tmp")));
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn save_later_coalesces_writes_and_flush_writes_the_latest() {
        let dir = temp_dir("later");
        let path = dir.join("config.json");
        for i in 0..50 {
            save_later(path.clone(), format!("{{\"n\": {i}}}"));
        }
        assert!(!path.exists(), "nothing is written on the calling thread");
        flush_pending();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"n\": 49}");
        save_later(path.clone(), "{\"n\": 50}".to_string());
        std::thread::sleep(SAVE_DELAY * 3);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"n\": 50}", "background flush");
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn load_json_reads_valid_file() {
        let dir = temp_dir("valid");
        let path = dir.join("stats.json");
        fs::write(&path, r#"{"a": 1}"#).unwrap();
        let map: HashMap<String, u32> = load_json(&path);
        assert_eq!(map.get("a"), Some(&1));
        assert_eq!(files_in(&dir), vec!["stats.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn load_json_missing_or_empty_file_gives_default_without_backup() {
        let dir = temp_dir("empty");
        let path = dir.join("stats.json");
        let map: HashMap<String, u32> = load_json(&path);
        assert!(map.is_empty());
        fs::write(&path, "  \n").unwrap();
        let map: HashMap<String, u32> = load_json(&path);
        assert!(map.is_empty());
        assert_eq!(files_in(&dir), vec!["stats.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn load_json_backs_up_broken_file_once() {
        let dir = temp_dir("broken");
        let path = dir.join("config.json");
        fs::write(&path, r#"{"hotkey": "Alt+Sp"#).unwrap();
        let map: HashMap<String, String> = load_json(&path);
        assert!(map.is_empty());
        let backup = dir.join("config.json.bak");
        assert_eq!(fs::read_to_string(&backup).unwrap(), r#"{"hotkey": "Alt+Sp"#);
        fs::write(&path, "garbage").unwrap();
        let _: HashMap<String, String> = load_json(&path);
        assert_eq!(fs::read_to_string(&backup).unwrap(), r#"{"hotkey": "Alt+Sp"#);
        fs::remove_dir_all(&dir).unwrap();
    }
}
