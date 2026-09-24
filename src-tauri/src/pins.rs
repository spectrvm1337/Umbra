use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pin {
    pub name: String,
    pub path: String,
    pub kind: String,
}

struct PinsState {
    path: PathBuf,
    pins: Vec<Pin>,
}

static PINS_STATE: LazyLock<Mutex<Option<PinsState>>> = LazyLock::new(|| Mutex::new(None));

fn pins_file_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("SpotlightSearch");
    fs::create_dir_all(&path).ok();
    path.push("pins.json");
    path
}

fn ensure_loaded() {
    let mut guard = PINS_STATE.lock().unwrap();
    if guard.is_some() {
        return;
    }
    let path = pins_file_path();
    let pins = crate::storage::load_json(&path);
    *guard = Some(PinsState { path, pins });
}

pub fn load_pins() -> Vec<Pin> {
    ensure_loaded();
    let guard = PINS_STATE.lock().unwrap();
    guard.as_ref().unwrap().pins.clone()
}

pub fn add_pin(result: &crate::search::SearchResult) -> bool {
    ensure_loaded();
    let mut guard = PINS_STATE.lock().unwrap();
    let state = guard.as_mut().unwrap();
    if state.pins.iter().any(|p| p.path == result.path) {
        return false;
    }
    state.pins.push(Pin {
        name: result.name.clone(),
        path: result.path.clone(),
        kind: result.kind.clone(),
    });
    let path = state.path.clone();
    let pins = state.pins.clone();
    drop(guard);
    if let Ok(json) = serde_json::to_string_pretty(&pins) {
        let _ = crate::storage::write_atomic(&path, json);
    }
    true
}

pub fn remove_pin(path: &str) -> bool {
    ensure_loaded();
    let mut guard = PINS_STATE.lock().unwrap();
    let state = guard.as_mut().unwrap();
    let len_before = state.pins.len();
    state.pins.retain(|p| p.path != path);
    if state.pins.len() == len_before {
        return false;
    }
    let path = state.path.clone();
    let pins = state.pins.clone();
    drop(guard);
    if let Ok(json) = serde_json::to_string_pretty(&pins) {
        let _ = crate::storage::write_atomic(&path, json);
    }
    true
}

pub fn reorder_pins(ordered_paths: Vec<String>) -> bool {
    ensure_loaded();
    let mut guard = PINS_STATE.lock().unwrap();
    let state = guard.as_mut().unwrap();
    if ordered_paths.len() != state.pins.len() {
        return false;
    }
    let mut map: std::collections::HashMap<String, Pin> = state
        .pins
        .iter()
        .cloned()
        .map(|p| (p.path.clone(), p))
        .collect();
    if ordered_paths.iter().any(|p| !map.contains_key(p)) {
        return false;
    }
    let mut new_pins = Vec::with_capacity(ordered_paths.len());
    for path in ordered_paths {
        if let Some(pin) = map.remove(&path) {
            new_pins.push(pin);
        }
    }
    if !map.is_empty() {
        return false;
    }
    state.pins = new_pins.clone();
    let path = state.path.clone();
    drop(guard);
    if let Ok(json) = serde_json::to_string_pretty(&new_pins) {
        let _ = crate::storage::write_atomic(&path, json);
    }
    true
}
