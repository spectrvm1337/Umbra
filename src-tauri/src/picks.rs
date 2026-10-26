//! "Typed this, opened that." When a result is opened from a query, it is
//! remembered under that query and every shorter prefix of it, so the next time
//! it comes first as soon as the typed text is one of them: open Chrome after
//! typing "ch" and it leads already on "c". Weights fade with the same half-life
//! as the launch ranking, so old habits give way to new ones.
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
#[derive(Serialize, Deserialize, Clone)]
struct Pick {
    path: String,
    score: f64,
    last_used: f64,
}
type Db = HashMap<String, Vec<Pick>>;
/// Longer prefixes than this add nothing: by then the query is specific anyway.
const MAX_PREFIX_CHARS: usize = 24;
const PICKS_PER_PREFIX: usize = 5;
const MAX_PREFIXES: usize = 3000;
static DB: LazyLock<Mutex<Option<Db>>> = LazyLock::new(|| Mutex::new(None));
fn db_path() -> std::path::PathBuf {
    crate::paths::config_dir().join("query_picks.json")
}
fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn normalize(query: &str) -> String {
    query.trim().to_lowercase().chars().take(MAX_PREFIX_CHARS).collect()
}
fn record_in(db: &mut Db, query: &str, path: &str, now: f64) {
    let q = normalize(query);
    let mut prefix = String::new();
    for c in q.chars() {
        prefix.push(c);
        let list = db.entry(prefix.clone()).or_default();
        match list.iter_mut().find(|p| p.path == path) {
            Some(p) => {
                p.score = crate::frecency::decayed(p.score, p.last_used, now) + 1.0;
                p.last_used = now;
            }
            None => list.push(Pick { path: path.to_string(), score: 1.0, last_used: now }),
        }
        list.sort_by(|a, b| {
            let (sa, sb) = (crate::frecency::decayed(a.score, a.last_used, now), crate::frecency::decayed(b.score, b.last_used, now));
            sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
        });
        list.truncate(PICKS_PER_PREFIX);
    }
    if db.len() > MAX_PREFIXES {
        // Forget the prefixes that have gone unused the longest.
        let mut by_age: Vec<(String, f64)> = db
            .iter()
            .map(|(k, v)| (k.clone(), v.iter().map(|p| p.last_used).fold(0.0, f64::max)))
            .collect();
        by_age.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        for (key, _) in by_age.into_iter().take(db.len() - MAX_PREFIXES) {
            db.remove(&key);
        }
    }
}
fn lookup_in(db: &Db, query: &str, now: f64) -> HashMap<String, f64> {
    db.get(&normalize(query))
        .map(|list| {
            list.iter()
                .map(|p| (p.path.clone(), crate::frecency::decayed(p.score, p.last_used, now)))
                .collect()
        })
        .unwrap_or_default()
}
fn with_db<R>(f: impl FnOnce(&mut Db) -> R) -> R {
    let mut guard = DB.lock_or_recover();
    let db = guard.get_or_insert_with(|| crate::storage::load_json(&db_path()));
    f(db)
}
/// Remembers that `path` was opened after typing `query`.
pub fn record(query: &str, path: &str) {
    if normalize(query).is_empty() {
        return;
    }
    with_db(|db| {
        record_in(db, query, path, now());
        if let Ok(json) = serde_json::to_string(db) {
            crate::storage::save_later(db_path(), json);
        }
    });
}
/// Paths opened before for exactly this query (as a prefix), with their weight.
pub fn for_query(query: &str) -> HashMap<String, f64> {
    with_db(|db| lookup_in(db, query, now()))
}
#[cfg(test)]
mod tests {
    use super::*;
    const DAY: f64 = 86_400.0;
    #[test]
    fn a_pick_counts_for_every_shorter_prefix() {
        let mut db = Db::new();
        record_in(&mut db, "Chr", "C:\\chrome.lnk", 1000.0);
        for q in ["c", "ch", "CHR", " chr "] {
            assert!(lookup_in(&db, q, 1000.0).contains_key("C:\\chrome.lnk"), "{q}");
        }
        assert!(lookup_in(&db, "chro", 1000.0).is_empty(), "longer than what was typed");
        assert!(lookup_in(&db, "x", 1000.0).is_empty());
    }
    #[test]
    fn the_more_recent_habit_wins() {
        let mut db = Db::new();
        let t = 1000.0 * DAY;
        for _ in 0..3 {
            record_in(&mut db, "c", "C:\\calc.exe", t - 60.0 * DAY);
        }
        record_in(&mut db, "c", "C:\\chrome.lnk", t);
        let picks = lookup_in(&db, "c", t);
        assert!(picks["C:\\chrome.lnk"] > picks["C:\\calc.exe"]);
    }
    #[test]
    fn keeps_a_few_picks_per_prefix() {
        let mut db = Db::new();
        for i in 0..10 {
            record_in(&mut db, "a", &format!("C:\\{i}.exe"), 1000.0 + i as f64);
        }
        assert_eq!(db["a"].len(), PICKS_PER_PREFIX);
    }
}
