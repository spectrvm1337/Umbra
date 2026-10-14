use crate::{icons, indexer, pins, search};
use std::collections::HashMap;
#[derive(serde::Serialize)]
pub struct SearchResponse {
    pub results: Vec<search::SearchResult>,
    pub pins: Vec<search::SearchResult>,
    pub indexed: usize,
    pub icons_ready: bool,
}
#[tauri::command]
pub async fn search_all(_app: tauri::AppHandle, query: String) -> SearchResponse {
    if query.trim().is_empty() {
        let saved_pins = pins::load_pins();
        return SearchResponse {
            results: Vec::new(),
            pins: pins_to_results(&saved_pins),
            indexed: indexer::get_indexed_count(),
            icons_ready: icons::is_precache_done(),
        };
    }
    let version = search::SEARCH_VERSION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let results = tauri::async_runtime::spawn_blocking(move || crate::search::search_index(&query, version))
        .await
        .unwrap_or_default();
    if !search::is_current(version) {
        return SearchResponse {
            results: Vec::new(),
            pins: Vec::new(),
            indexed: indexer::get_indexed_count(),
            icons_ready: icons::is_precache_done(),
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
        icons_ready: icons::is_precache_done(),
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
