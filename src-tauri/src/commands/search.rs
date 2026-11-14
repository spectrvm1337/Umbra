use crate::{icons, indexer, pins, search};
use std::collections::HashMap;
#[derive(serde::Serialize)]
pub struct SearchResponse {
    pub results: Vec<search::SearchResult>,
    pub pins: Vec<search::SearchResult>,
    pub indexed: usize,
}
/// `scope` (`D:` or `D:\`) keeps the results to one drive: typing `D:\ report`
/// searches for "report" on D: only.
#[tauri::command]
pub async fn search_all(_app: tauri::AppHandle, query: String, scope: Option<String>) -> SearchResponse {
    if query.trim().is_empty() {
        let saved_pins = pins::load_pins();
        return SearchResponse {
            results: Vec::new(),
            pins: pins_to_results(&saved_pins),
            indexed: indexer::get_indexed_count(),
        };
    }
    let version = search::SEARCH_VERSION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let prefix = scope.as_deref().and_then(crate::config::drive_key).map(|d| format!("{d}\\"));
    let results = tauri::async_runtime::spawn_blocking(move || crate::search::search_index(&query, version, prefix.as_deref()))
        .await
        .unwrap_or_default();
    if !search::is_current(version) {
        return SearchResponse {
            results: Vec::new(),
            pins: Vec::new(),
            indexed: indexer::get_indexed_count(),
        };
    }
    let saved_pins = pins::load_pins();
    let pin_paths: std::collections::HashSet<String> =
        saved_pins.iter().map(|p| p.path.clone()).collect();
    let mut results = results;
    for r in &mut results {
        r.pinned = pin_paths.contains(&r.path);
    }
    results.sort_by(|a, b| a.score.cmp(&b.score).then_with(|| a.name.cmp(&b.name)));
    SearchResponse {
        results,
        pins: pins_to_results(&saved_pins),
        indexed: indexer::get_indexed_count(),
    }
}
/// Recently opened items for the empty search box while pins live in the side dock,
/// newest first. Pinned ones are left out because the dock already shows them.
#[tauri::command]
pub fn get_recent_items(limit: usize) -> Vec<search::SearchResult> {
    let pinned: std::collections::HashSet<String> =
        pins::load_pins().into_iter().map(|p| p.path).collect();
    crate::frecency::recent_ids()
        .iter()
        .filter(|id| !pinned.contains(*id))
        .filter_map(|id| indexer::file_result(id))
        .take(limit.min(50))
        .collect()
}
fn pins_to_results(pins: &[pins::Pin]) -> Vec<search::SearchResult> {
    pins.iter()
        .map(|p| search::SearchResult {
            name: p.name.clone(),
            path: p.path.clone(),
            kind: p.kind.clone(),
            icon: p.kind.clone(),
            pinned: true,
            icon_data: None,
            score: search::ScoreKey::default(),
            copies: None,
            copies_more: false,
        })
        .collect()
}
#[tauri::command]
pub async fn get_icons(paths: Vec<String>) -> HashMap<String, String> {
    // Shell / COM / GDI calls block; keep them off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = HashMap::new();
        for path in paths {
            if let Some(png) = icons::get_icon_png_data(&path) {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                result.insert(path, format!("data:image/png;base64,{}", b64));
            }
        }
        result
    })
    .await
    .unwrap_or_default()
}
/// Entries listed for one folder opened in the results (→ on a folder row): more would not be
/// read anyway, and every row costs the page.
const FOLDER_LIST_MAX: usize = 300;
/// What is in `path`, folders first, then by name; hidden and system entries left out, as Explorer
/// does. Read from the disk rather than the index, so it is what is there now.
#[tauri::command]
pub async fn list_folder(path: String) -> Vec<search::SearchResult> {
    tauri::async_runtime::spawn_blocking(move || list_folder_now(&path)).await.unwrap_or_default()
}
fn list_folder_now(path: &str) -> Vec<search::SearchResult> {
    let Ok(dir) = std::fs::read_dir(path) else { return Vec::new() };
    let mut out: Vec<(bool, String, search::SearchResult)> = dir
        .filter_map(|e| e.ok())
        .filter(|e| !is_hidden(e))
        .map(|e| {
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            let full = e.path().to_string_lossy().into_owned();
            let kind = indexer::kind_from_file(&e.file_name().to_string_lossy(), is_dir);
            let r = indexer::entry_to_result(&indexer::SearchEntry {
                name_lower: Box::from(""),
                path: full,
                kind,
            });
            (!is_dir, r.name.to_lowercase(), r)
        })
        .collect();
    out.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    out.into_iter().take(FOLDER_LIST_MAX).map(|(_, _, r)| r).collect()
}
#[cfg(windows)]
fn is_hidden(e: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
    e.metadata().is_ok_and(|m| m.file_attributes() & 0x6 != 0)
}
#[cfg(not(windows))]
fn is_hidden(e: &std::fs::DirEntry) -> bool {
    e.file_name().to_string_lossy().starts_with('.')
}
#[cfg(test)]
mod tests {
    #[test]
    fn a_folder_lists_its_folders_first_then_its_files_by_name() {
        let dir = std::env::temp_dir().join(format!("umbra-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("zeta")).unwrap();
        std::fs::write(dir.join("b.txt"), "").unwrap();
        std::fs::write(dir.join("A.md"), "").unwrap();
        let names: Vec<(String, String)> =
            super::list_folder_now(&dir.to_string_lossy()).into_iter().map(|r| (r.name, r.kind)).collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(names[0], ("zeta".to_string(), "folder".to_string()));
        assert_eq!(names[1].0, "A.md");
        assert_eq!(names[2].0, "b.txt");
        assert!(super::list_folder_now(r"Z:\no\such\folder").is_empty());
    }
}
