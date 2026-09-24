

use crate::search::SearchResult;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::thread;
use tauri::Emitter;
use jwalk::WalkDir;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub(crate) static INDEX: OnceLock<RwLock<Vec<SearchEntry>>> = OnceLock::new();

pub(crate) const KIND_APP: u8 = 0;
pub(crate) const KIND_SHORTCUT: u8 = 1;
pub(crate) const KIND_FOLDER: u8 = 2;
pub(crate) const KIND_DOCUMENT: u8 = 3;
pub(crate) const KIND_IMAGE: u8 = 4;
pub(crate) const KIND_AUDIO: u8 = 5;
pub(crate) const KIND_VIDEO: u8 = 6;
pub(crate) const KIND_ARCHIVE: u8 = 7;
pub(crate) const KIND_CODE: u8 = 8;
pub(crate) const KIND_FILE: u8 = 9;
pub(crate) const KIND_SYSTEM: u8 = 10;

#[derive(Clone)]
pub(crate) struct SearchEntry {
    pub name_lower: Box<str>,
    pub path: String,
    pub kind: u8,
}

pub(crate) fn kind_str(kind: u8) -> &'static str {
    match kind {
        KIND_APP => "app",
        KIND_SHORTCUT => "shortcut",
        KIND_FOLDER => "folder",
        KIND_DOCUMENT => "document",
        KIND_IMAGE => "image",
        KIND_AUDIO => "audio",
        KIND_VIDEO => "video",
        KIND_ARCHIVE => "archive",
        KIND_CODE => "code",
        KIND_SYSTEM => "system",
        _ => "file",
    }
}

pub(crate) fn derive_display_name(path: &str, kind: u8) -> String {
    let p = Path::new(path);
    let file_name = p.file_name().unwrap_or_default().to_string_lossy();
    if kind == KIND_APP || kind == KIND_SHORTCUT {
        file_name
            .rsplit_once('.')
            .map(|(n, _)| n.to_string())
            .unwrap_or(file_name.to_string())
    } else {
        file_name.to_string()
    }
}

pub(crate) fn entry_to_result(e: &SearchEntry) -> SearchResult {
    let kind = kind_str(e.kind);
    SearchResult {
        name: derive_display_name(&e.path, e.kind),
        path: e.path.clone(),
        kind: kind.to_string(),
        icon: kind.to_string(),
        pinned: false,
        icon_data: None,
        score: crate::search::ScoreKey::default(),
    }
}

/// Read-only access to the live index for the query layer.
pub(crate) fn with_entries<R>(f: impl FnOnce(&[SearchEntry]) -> R) -> Option<R> {
    INDEX.get().and_then(|rw| rw.read().ok()).map(|r| f(&r))
}

fn kind_from_file(file_name: &str, is_dir: bool) -> u8 {
    if is_dir {
        return KIND_FOLDER;
    }
    let ext = Path::new(file_name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "exe" | "msi" => KIND_APP,
        "lnk" | "url" => KIND_SHORTCUT,
        "txt" | "log" | "md" | "ini" | "cfg" => KIND_DOCUMENT,
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" => KIND_DOCUMENT,
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "svg" | "ico" => KIND_IMAGE,
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" => KIND_AUDIO,
        "mp4" | "avi" | "mkv" | "mov" | "wmv" | "webm" => KIND_VIDEO,
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" => KIND_ARCHIVE,
        "js" | "ts" | "py" | "rs" | "c" | "cpp" | "h" | "java" | "go" => KIND_CODE,
        "html" | "css" | "json" | "xml" | "yaml" | "toml" => KIND_CODE,
        "dll" | "sys" | "so" | "dylib" | "lib" | "a" | "pdb" | "bin" | "dat" | "db" | "sqlite" | "" => KIND_SYSTEM,
        _ => KIND_FILE,
    }
}

/// Structured progress event for the frontend island.
/// `pct` is a smooth 0..=100 estimate, `scanned` is the exact live counter
/// of entries collected so far, `phase` is one of:
/// starting | apps | scan | finalizing | icons | done.
#[derive(Clone, serde::Serialize)]
struct IndexProgress {
    phase: String,
    pct: u8,
    scanned: usize,
    total: usize,
    drive: String,
    done: bool,
}

fn emit_progress(app: &tauri::AppHandle, run: u64, p: &IndexProgress) {
    // Stale runs (superseded by a newer reindex) stay silent.
    if INDEX_RUN.load(std::sync::atomic::Ordering::SeqCst) != run {
        return;
    }
    let _ = app.emit("index-progress", p);
}

/// Legacy fallback for old frontends: plain percent number.
#[allow(dead_code)]
fn emit_pct(app: &tauri::AppHandle, run: u64, pct: u8, scanned: usize) {
    emit_progress(
        app,
        run,
        &IndexProgress {
            phase: if pct >= 100 {
                "done".to_string()
            } else {
                "scan".to_string()
            },
            pct: pct.min(100),
            scanned,
            total: 0,
            drive: String::new(),
            done: pct >= 100,
        },
    );
}

static INDEX_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn init_index_with_progress(app: tauri::AppHandle) {
    // OnceLock::set fails on the 2nd (reindex) call — ensure instead.
    INDEX.get_or_init(|| RwLock::new(Vec::with_capacity(100_000)));

    // Every new run cancels the previous one: the old thread sees a
    // mismatched run id at the next checkpoint and exits quietly.
    let run = INDEX_RUN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

    thread::spawn(move || {
        let mut entries = Vec::with_capacity(100_000);
        let cancelled = || INDEX_RUN.load(std::sync::atomic::Ordering::SeqCst) != run;

        emit_progress(
            &app,
            run,
            &IndexProgress {
                phase: "starting".to_string(),
                pct: 0,
                scanned: 0,
                total: 0,
                drive: String::new(),
                done: false,
            },
        );

        index_start_menu(&mut entries);
        if cancelled() {
            return;
        }
        emit_progress(
            &app,
            run,
            &IndexProgress {
                phase: "apps".to_string(),
                pct: 2,
                scanned: entries.len(),
                total: 0,
                drive: String::new(),
                done: false,
            },
        );

        index_registry_apps(&mut entries);
        if cancelled() {
            return;
        }
        let post_apps = entries.len();

        emit_progress(
            &app,
            run,
            &IndexProgress {
                phase: "apps".to_string(),
                pct: 5,
                scanned: post_apps,
                total: 0,
                drive: String::new(),
                done: false,
            },
        );

        index_drives_with_progress(&mut entries, &app, run, post_apps);
        if cancelled() {
            return;
        }

        // Dedup by path, keeping the first occurrence: Start Menu / registry
        // entries come before the drive walk, so their display names win over
        // the raw file names for the same exe.
        let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
        entries.retain(|e| seen_paths.insert(e.path.clone()));

        if let Some(rw) = INDEX.get() {
            if let Ok(mut w) = rw.write() {
                *w = entries;
            }
        }
        if cancelled() {
            return;
        }
        let total = with_entries(|r| r.len()).unwrap_or(0);

        emit_progress(
            &app,
            run,
            &IndexProgress {
                phase: "finalizing".to_string(),
                pct: 94,
                scanned: total,
                total,
                drive: String::new(),
                done: false,
            },
        );

        // Icons will be lazy-loaded to prevent massive memory footprint
        if cancelled() {
            return;
        }

        emit_progress(
            &app,
            run,
            &IndexProgress {
                phase: "icons".to_string(),
                pct: 97,
                scanned: total,
                total,
                drive: String::new(),
                done: false,
            },
        );

        emit_progress(
            &app,
            run,
            &IndexProgress {
                phase: "done".to_string(),
                pct: 100,
                scanned: total,
                total,
                drive: String::new(),
                done: true,
            },
        );
    });
}

// Re-scan the fast sources (Start Menu + registry apps) and merge them into
// the live index, so newly installed/removed apps are found without an app
// restart. Full drive re-walk is intentionally NOT done here (too slow);
// it still happens once at startup. Throttled to once per 5 minutes.
static LAST_FAST_REFRESH: OnceLock<std::sync::Mutex<Option<std::time::Instant>>> = OnceLock::new();

const FAST_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);

pub fn refresh_fast_index_async() {
    std::thread::spawn(refresh_fast_index);
}

pub fn refresh_fast_index() {
    let cell = LAST_FAST_REFRESH.get_or_init(|| std::sync::Mutex::new(None));
    {
        let mut guard = cell.lock().unwrap();
        if let Some(t) = *guard {
            if t.elapsed() < FAST_REFRESH_INTERVAL {
                return;
            }
        }
        *guard = Some(std::time::Instant::now());
    }

    let mut fresh: Vec<SearchEntry> = Vec::new();
    index_start_menu(&mut fresh);
    index_registry_apps(&mut fresh);
    if fresh.is_empty() {
        return;
    }

    if let Some(rw) = INDEX.get() {
        if let Ok(mut w) = rw.write() {
            let fresh_paths: std::collections::HashSet<&str> =
                fresh.iter().map(|e| e.path.as_str()).collect();
            // drop old entries superseded by the fresh scan, plus app/shortcut
            // entries whose target no longer exists on disk (uninstalled) —
            // a fresh scan alone can't see removals
            w.retain(|e| {
                !fresh_paths.contains(e.path.as_str())
                    && ((e.kind != KIND_APP && e.kind != KIND_SHORTCUT)
                        || Path::new(&e.path).exists())
            });
            w.extend(fresh);
        }
    }
}

fn index_start_menu(entries: &mut Vec<SearchEntry>) {
    let mut paths = Vec::new();
    if let Some(app_data) = dirs::data_dir() {
        paths.push(
            app_data
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    paths.push(PathBuf::from(
        "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    ));

    for base in &paths {
        if !base.exists() {
            continue;
        }
        for entry in WalkDir::new(base)
            .skip_hidden(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let ext = Path::new(&file_name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            if ext != "lnk" && ext != "url" {
                continue;
            }

            let display_name = file_name
                .rsplit_once('.')
                .map(|(n, _)| n.to_string())
                .unwrap_or(file_name);

            let path_str = entry.path().to_string_lossy().to_string();
            entries.push(SearchEntry {
                name_lower: display_name.to_lowercase().into_boxed_str(),
                path: path_str,
                kind: KIND_APP,
            });
        }
    }
}

fn clean_registry_path(val: &str) -> Option<String> {
    let trimmed = val.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut path = trimmed.to_string();
    if path.starts_with('"') {
        if let Some(idx) = path[1..].find('"') {
            path = path[1..idx + 1].to_string();
        }
    } else {
        let path_lower = path.to_lowercase();
        let mut found_ext = false;
        for ext in [".exe", ".ico", ".lnk"] {
            if let Some(idx) = path_lower.find(ext) {
                path = path[..idx + ext.len()].to_string();
                found_ext = true;
                break;
            }
        }
        if !found_ext && !Path::new(&path).exists() {
            if let Some(space_idx) = path.find(' ') {
                path = path[..space_idx].to_string();
            }
        }
    }

    if let Some(comma_idx) = path.rfind(',') {
        let before = &path[..comma_idx];
        if Path::new(before).exists() {
            return Some(before.to_string());
        }
    }

    let p = Path::new(&path);
    if p.exists() {
        return Some(path);
    }

    None
}

fn find_exe_in_dir(dir: &str, app_name: &str) -> Option<String> {
    let p = Path::new(dir);
    if !p.is_dir() {
        return None;
    }

    let app_name_lower = app_name.to_lowercase();

    if let Ok(rd) = std::fs::read_dir(p) {
        let mut exes = Vec::new();
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |ext| ext == "exe") {
                let file_name = path.file_name().unwrap().to_string_lossy().to_string();
                let file_name_lower = file_name.to_lowercase();

                if file_name_lower.contains(&app_name_lower)
                    || app_name_lower.contains(&file_name_lower.replace(".exe", ""))
                {
                    return Some(path.to_string_lossy().to_string());
                }
                exes.push(path.to_string_lossy().to_string());
            }
        }
        if exes.len() == 1 {
            return Some(exes[0].clone());
        }
    }

    None
}

fn index_registry_apps(entries: &mut Vec<SearchEntry>) {
    let mut seen = std::collections::HashSet::new();
    let mut seen_paths = std::collections::HashSet::new();

    let hives = [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for hive in &hives {
        
        let mut reg_cmd = std::process::Command::new("reg");
        reg_cmd.args(["query", hive, "/s", "/reg:64"]);
        #[cfg(target_os = "windows")]
        reg_cmd.creation_flags(0x08000000);
        if let Ok(out) = reg_cmd.output() {
            let text = String::from_utf8_lossy(&out.stdout);

            let mut current_name: Option<String> = None;
            let mut current_icon: Option<String> = None;
            let mut current_location: Option<String> = None;
            let mut current_uninstall: Option<String> = None;

            let mut process_entry = |name: &mut Option<String>,
                                     icon: &mut Option<String>,
                                     loc: &mut Option<String>,
                                     un: &mut Option<String>| {
                if let Some(app_name) = name.take() {
                    if app_name.is_empty() || app_name.len() < 2 {
                        return;
                    }
                    let key = app_name.to_lowercase();
                    if seen.contains(&key) {
                        return;
                    }

                    let mut resolved_path = None;

                    if let Some(icon_path) = icon.take() {
                        if let Some(cleaned) = clean_registry_path(&icon_path) {
                            resolved_path = Some(cleaned);
                        }
                    }

                    if resolved_path.is_none() {
                        if let Some(loc_path) = loc.take() {
                            let cleaned = loc_path.trim().replace('"', "");
                            if !cleaned.is_empty() && Path::new(&cleaned).exists() {
                                if let Some(exe_path) = find_exe_in_dir(&cleaned, &app_name) {
                                    resolved_path = Some(exe_path);
                                }
                            }
                        }
                    }

                    if resolved_path.is_none() {
                        if let Some(un_path) = un.take() {
                            if let Some(cleaned) = clean_registry_path(&un_path) {
                                if let Some(parent) = Path::new(&cleaned).parent() {
                                    if parent.exists() {
                                        if let Some(exe_path) = find_exe_in_dir(
                                            &parent.to_string_lossy(),
                                            &app_name,
                                        ) {
                                            resolved_path = Some(exe_path);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if let Some(path) = resolved_path {

                        if !Path::new(&path).is_file() {
                            return;
                        }

                        let path_key = path.to_lowercase();
                        if seen_paths.contains(&path_key) {
                            return;
                        }
                        seen.insert(key);
                        seen_paths.insert(path_key);
                        entries.push(SearchEntry {
                            name_lower: app_name.to_lowercase().into_boxed_str(),
                            path,
                            kind: KIND_APP,
                        });
                    }
                }
            };

            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("HKEY_") {
                    process_entry(
                        &mut current_name,
                        &mut current_icon,
                        &mut current_location,
                        &mut current_uninstall,
                    );
                    continue;
                }

                let parts: Vec<&str> = if trimmed.contains("REG_SZ") {
                    trimmed.splitn(2, "REG_SZ").collect()
                } else if trimmed.contains("REG_EXPAND_SZ") {
                    trimmed.splitn(2, "REG_EXPAND_SZ").collect()
                } else {
                    Vec::new()
                };

                if parts.len() == 2 {
                    let val_name = parts[0].trim().to_lowercase();
                    let val_content = parts[1].trim().to_string();

                    match val_name.as_str() {
                        "displayname" => current_name = Some(val_content),
                        "displayicon" => current_icon = Some(val_content),
                        "installlocation" => current_location = Some(val_content),
                        "uninstallstring" => current_uninstall = Some(val_content),
                        _ => {}
                    }
                }
            }

            process_entry(
                &mut current_name,
                &mut current_icon,
                &mut current_location,
                &mut current_uninstall,
            );
        }
    }
}

const SCAN_FROM: f64 = 5.0;
const SCAN_TO: f64 = 92.0;

const SCAN_SMOOTH: f64 = 40_000.0;

const EMIT_EVERY_MS: u128 = 150;
const EMIT_EVERY_FILES: usize = 1500;

fn index_drive(
    drive: &str,
    skip_dirs: &std::collections::HashSet<String>,
    out: &mut Vec<SearchEntry>,
    app: &tauri::AppHandle,
    run: u64,
    base: usize,
    span_from: f64,
    span_to: f64,
) {
    let root = Path::new(drive);
    if !root.exists() {
        return;
    }
    let mut in_drive: usize = 0;
    let mut last_emit = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_millis(1000))
        .unwrap_or_else(std::time::Instant::now);

    for entry in WalkDir::new(root)
        .follow_links(false)
        .skip_hidden(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !name.starts_with('.') && !skip_dirs.contains(name.as_str())
        })
    {
        
        if in_drive % 2048 == 0 && INDEX_RUN.load(std::sync::atomic::Ordering::SeqCst) != run {
            return;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let path_str = entry.path().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_dir();
        let kind = kind_from_file(&file_name, is_dir);
        let display_name = derive_display_name(&path_str, kind);
        out.push(SearchEntry {
            name_lower: display_name.to_lowercase().into_boxed_str(),
            path: path_str,
            kind,
        });
        in_drive += 1;

        if in_drive % EMIT_EVERY_FILES == 0 && last_emit.elapsed().as_millis() >= EMIT_EVERY_MS {
            last_emit = std::time::Instant::now();
            let frac = (in_drive as f64) / (in_drive as f64 + SCAN_SMOOTH);
            let pct = span_from + frac * (span_to - span_from);
            emit_progress(
                app,
                run,
                &IndexProgress {
                    phase: "scan".to_string(),
                    pct: pct.clamp(0.0, 100.0) as u8,
                    scanned: base + out.len(),
                    total: 0,
                    drive: drive.to_string(),
                    done: false,
                },
            );
        }
    }

    emit_progress(
        app,
        run,
        &IndexProgress {
            phase: "scan".to_string(),
            pct: span_to.clamp(0.0, 100.0) as u8,
            scanned: base + out.len(),
            total: 0,
            drive: drive.to_string(),
            done: false,
        },
    );
}

fn index_drives_with_progress(
    entries: &mut Vec<SearchEntry>,
    app: &tauri::AppHandle,
    run: u64,
    base: usize,
) {
    let mut drives = get_available_drives();
    let disabled_drives = crate::config::get_disabled_drives();
    drives.retain(|d| {
        !disabled_drives.iter().any(|dd| d.to_uppercase() == dd.to_uppercase())
    });

    if drives.is_empty() {
        return;
    }
    let config_excludes = crate::config::get_index_excludes();
    let skip_dirs: std::collections::HashSet<String> = config_excludes.into_iter().collect();
    let n = drives.len() as f64;

    for (i, drive) in drives.iter().enumerate() {
        if INDEX_RUN.load(std::sync::atomic::Ordering::SeqCst) != run {
            return;
        }
        let span_from = SCAN_FROM + (SCAN_TO - SCAN_FROM) * (i as f64 / n);
        let span_to = SCAN_FROM + (SCAN_TO - SCAN_FROM) * ((i + 1) as f64 / n);
        let before = entries.len();
        
        emit_progress(
            app,
            run,
            &IndexProgress {
                phase: "scan".to_string(),
                pct: span_from.clamp(0.0, 100.0) as u8,
                scanned: base + before,
                total: 0,
                drive: drive.clone(),
                done: false,
            },
        );
        index_drive(drive, &skip_dirs, entries, app, run, base, span_from, span_to);
    }
}

#[cfg(target_os = "windows")]
pub fn get_available_drives() -> Vec<String> {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDriveStringsW};

    let mut buffer = [0u16; 256];
    let len = unsafe { GetLogicalDriveStringsW(buffer.len() as u32, buffer.as_mut_ptr()) };
    if len == 0 || len as usize > buffer.len() {
        return vec!["C:\\".to_string(), "D:\\".to_string()];
    }

    let mut drives = Vec::new();
    let mut i = 0;
    while i < len as usize {
        let mut j = i;
        while j < buffer.len() && buffer[j] != 0 {
            j += 1;
        }
        if j > i {
            let drive = OsString::from_wide(&buffer[i..j]);
            if let Some(s) = drive.to_str() {
                drives.push(s.to_string());
            }
        }
        i = j + 1;
    }

    drives
        .into_iter()
        .filter(|d| {
            let wide: Vec<u16> = OsStr::new(d)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
            drive_type == 3 || drive_type == 2
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
pub fn get_available_drives() -> Vec<String> {
    vec!["/".to_string()]
}

pub fn get_indexed_count() -> usize {
    with_entries(|r| r.len()).unwrap_or(0)
}
