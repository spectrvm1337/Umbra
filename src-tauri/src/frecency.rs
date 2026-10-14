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
fn db_path() -> PathBuf {
    crate::paths::frecency_file()
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
/// A launch counts half as much after this many days, so programs you stopped
/// using sink below the ones you use now instead of ranking first forever.
const HALF_LIFE_DAYS: f64 = 14.0;
/// The stored score is its value at `last_used`; this is what it is worth `now`.
pub(crate) fn decayed(score: f64, last_used: f64, now: f64) -> f64 {
    let age_days = ((now - last_used) / 86_400.0).max(0.0);
    score * 0.5f64.powf(age_days / HALF_LIFE_DAYS)
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
    entry.score = decayed(entry.score, entry.last_used, now) * 0.9 + 100.0;
    entry.last_used = now;
    save_db(db);
}
pub fn scores_snapshot() -> std::collections::HashMap<String, f64> {
    ensure_db();
    let now = chrono_timestamp();
    let guard = DB.lock().unwrap();
    guard
        .as_ref()
        .unwrap()
        .entries
        .iter()
        .map(|(k, v)| (k.clone(), decayed(v.score, v.last_used, now)))
        .collect()
}
/// Everything ever launched (paths and URLs), most recently used first.
pub fn recent_ids() -> Vec<String> {
    ensure_db();
    let guard = DB.lock().unwrap();
    most_recent_first(&guard.as_ref().unwrap().entries)
}
fn most_recent_first(entries: &HashMap<String, FrecencyEntry>) -> Vec<String> {
    let mut list: Vec<&FrecencyEntry> = entries.values().collect();
    list.sort_by(|a, b| b.last_used.partial_cmp(&a.last_used).unwrap_or(std::cmp::Ordering::Equal));
    list.into_iter().map(|e| e.id.clone()).collect()
}
/// Queued like the config and pins (storage::save_later), so quitting from the
/// tray flushes the last launches too instead of dropping them.
fn save_db(db: &FrecencyDb) {
    if let Ok(json) = serde_json::to_string(&db.entries) {
        crate::storage::save_later(db.path.clone(), json);
    }
}
fn chrono_timestamp() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn most_recent_first_orders_by_last_use() {
        let entry = |id: &str, score: f64, last_used: f64| (id.to_string(), FrecencyEntry { id: id.to_string(), score, last_used });
        let entries: HashMap<String, FrecencyEntry> =
            [entry("old", 900.0, 10.0), entry("newest", 100.0, 30.0), entry("middle", 500.0, 20.0)].into_iter().collect();
        assert_eq!(most_recent_first(&entries), vec!["newest", "middle", "old"]);
    }
    #[test]
    fn launches_lose_weight_over_time() {
        let day = 86_400.0;
        let now = 1_000.0 * day;
        assert_eq!(decayed(100.0, now, now), 100.0);
        assert!((decayed(100.0, now - 14.0 * day, now) - 50.0).abs() < 1e-9);
        // A clock that went backwards never inflates a score.
        assert_eq!(decayed(100.0, now + day, now), 100.0);
        // Used constantly two months ago (capped at 1000) vs once today.
        assert!(decayed(1000.0, now - 60.0 * day, now) < decayed(100.0, now, now));
    }
}
