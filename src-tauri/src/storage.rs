use serde::de::DeserializeOwned;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
