use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

#[derive(Serialize, Deserialize, Clone)]
pub struct FrecencyEntry {
    pub id: String,
    pub score: f64,
    pub last_used: f64,
}

struct FrecencyDb {
    path: PathBuf,
    entries: HashMap<String, FrecencyEntry>,
}

static DB: LazyLock<Mutex<Option<FrecencyDb>>> = LazyLock::new(|| Mutex::new(None));
static WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn db_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("SpotlightSearch")
        .join("frecency_stats.json")
}

fn ensure_db() {
    let mut guard = DB.lock().unwrap();
    if guard.is_some() {
        return;
    }
    let path = db_path();
    let entries = crate::storage::load_json(&path);
    *guard = Some(FrecencyDb { path, entries });
}

pub fn record_usage(id: &str) {
    ensure_db();
    let mut guard = DB.lock().unwrap();
    let db = guard.as_mut().unwrap();
    let now = chrono_timestamp();
    let entry = db.entries.entry(id.to_string()).or_insert(FrecencyEntry {
        id: id.to_string(),
        score: 0.0,
        last_used: now,
    });
    entry.score = entry.score * 0.9 + 100.0;
    entry.last_used = now;
    save_db(db);
}

pub fn scores_snapshot() -> std::collections::HashMap<String, f64> {
    ensure_db();
    let guard = DB.lock().unwrap();
    guard
        .as_ref()
        .unwrap()
        .entries
        .iter()
        .map(|(k, v)| (k.clone(), v.score))
        .collect()
}

static SAVE_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn save_db(db: &FrecencyDb) {
    if SAVE_PENDING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let path = db.path.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        SAVE_PENDING.store(false, std::sync::atomic::Ordering::SeqCst);
        
        let json = {
            let guard = DB.lock().unwrap();
            if let Some(db_ref) = guard.as_ref() {
                serde_json::to_string(&db_ref.entries).unwrap_or_default()
            } else {
                String::new()
            }
        };
        
        if !json.is_empty() {
            let _write_guard = WRITE_LOCK.lock().unwrap();
            let _ = crate::storage::write_atomic(&path, json);
        }
    });
}

fn chrono_timestamp() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
