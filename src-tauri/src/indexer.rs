

use crate::search::SearchResult;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::thread;
use tauri::Emitter;
use jwalk::WalkDir;

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
        index_system_tools(&mut entries, &system_tool_dirs());
        let skip_dirs: std::collections::HashSet<String> =
            crate::config::get_index_excludes().into_iter().collect();
        index_program_exes(
            &mut entries,
            &program_dirs(),
            &skip_dirs,
            &crate::config::get_disabled_drives(),
        );
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

fn missing_paths(paths: Vec<String>) -> std::collections::HashSet<String> {
    paths.into_iter().filter(|p| !Path::new(p).exists()).collect()
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

    let fresh_paths: std::collections::HashSet<String> =
        fresh.iter().map(|e| e.path.clone()).collect();

    // drop old entries superseded by the fresh scan, plus app/shortcut
    // entries whose target no longer exists on disk (uninstalled) —
    // a fresh scan alone can't see removals. The disk checks run before
    // taking the write lock so searches are not blocked meanwhile.
    let app_paths: Vec<String> = with_entries(|r| {
        r.iter()
            .filter(|e| e.kind == KIND_APP || e.kind == KIND_SHORTCUT)
            .filter(|e| !fresh_paths.contains(&e.path))
            .map(|e| e.path.clone())
            .collect()
    })
    .unwrap_or_default();
    let gone = missing_paths(app_paths);

    if let Some(rw) = INDEX.get() {
        if let Ok(mut w) = rw.write() {
            w.retain(|e| !fresh_paths.contains(&e.path) && !gone.contains(&e.path));
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
    paths.push(
        std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
            .join("Microsoft\\Windows\\Start Menu\\Programs"),
    );

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

fn system_tool_dirs() -> Vec<PathBuf> {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    let mut dirs = vec![
        root.join("System32"),
        root.join("System32\\WindowsPowerShell\\v1.0"),
        root,
    ];
    if let Some(local) = dirs::data_local_dir() {
        dirs.push(local.join("Microsoft\\WindowsApps"));
    }
    dirs
}

const APPDATA_EXE_DEPTH: usize = 4;

fn program_dirs() -> Vec<(PathBuf, Option<usize>)> {
    let mut dirs: Vec<(PathBuf, Option<usize>)> =
        ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|d| (PathBuf::from(d), None))
            .collect();
    if let Some(local) = dirs::data_local_dir() {
        dirs.push((local.join("Programs"), None));
        dirs.push((local, Some(APPDATA_EXE_DEPTH)));
    }
    if let Some(roaming) = dirs::data_dir() {
        dirs.push((roaming, Some(APPDATA_EXE_DEPTH)));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|(d, _)| seen.insert(d.to_string_lossy().to_lowercase()));
    dirs
}

fn index_program_exes(
    entries: &mut Vec<SearchEntry>,
    dirs: &[(PathBuf, Option<usize>)],
    skip_dirs: &std::collections::HashSet<String>,
    disabled_drives: &[String],
) {
    for (dir, max_depth) in dirs {
        let on_disabled_drive = disabled_drives.iter().any(|d| {
            dir.to_string_lossy()
                .to_uppercase()
                .starts_with(&d.to_uppercase())
        });
        if on_disabled_drive || !dir.is_dir() {
            continue;
        }
        let walk = pruned_walk(dir, skip_dirs.clone()).max_depth(max_depth.unwrap_or(usize::MAX));
        for entry in walk.into_iter().filter_map(|e| e.ok()) {
            let is_exe = entry.file_type().is_file()
                && Path::new(&entry.file_name())
                    .extension()
                    .map_or(false, |ext| ext.eq_ignore_ascii_case("exe"));
            if !is_exe {
                continue;
            }
            let path_str = entry.path().to_string_lossy().to_string();
            entries.push(SearchEntry {
                name_lower: derive_display_name(&path_str, KIND_APP)
                    .to_lowercase()
                    .into_boxed_str(),
                path: path_str,
                kind: KIND_APP,
            });
        }
    }
}

fn index_system_tools(entries: &mut Vec<SearchEntry>, dirs: &[PathBuf]) {
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            let is_exe = path
                .extension()
                .map_or(false, |ext| ext.eq_ignore_ascii_case("exe"));
            if !is_exe || !entry.file_type().map_or(false, |t| t.is_file()) {
                continue;
            }
            let path_str = path.to_string_lossy().to_string();
            entries.push(SearchEntry {
                name_lower: derive_display_name(&path_str, KIND_APP)
                    .to_lowercase()
                    .into_boxed_str(),
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

fn is_inside_system_root(dir: &Path) -> bool {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    let root = root.to_string_lossy().trim_end_matches('\\').to_lowercase();
    let dir = dir.to_string_lossy().to_lowercase();
    dir == root || dir.starts_with(&format!("{root}\\"))
}

fn find_exe_in_dir(dir: &str, app_name: &str) -> Option<String> {
    let p = Path::new(dir);
    if !p.is_dir() || is_inside_system_root(p) {
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

#[derive(Default)]
struct UninstallEntry {
    name: Option<String>,
    icon: Option<String>,
    location: Option<String>,
    uninstall: Option<String>,
}

fn expand_env_vars(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) if !name.is_empty() => out.push_str(&v),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(target_os = "windows")]
mod registry {
    use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
    use windows_sys::Win32::System::Registry::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    impl Key {
        pub fn open(parent: HKEY, path: &str) -> Option<Key> {
            let mut hkey: HKEY = std::ptr::null_mut();
            let path = wide(path);
            let res = unsafe {
                RegOpenKeyExW(parent, path.as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut hkey)
            };
            (res == 0 && !hkey.is_null()).then_some(Key(hkey))
        }

        pub fn child(&self, name: &str) -> Option<Key> {
            Key::open(self.0, name)
        }

        pub fn subkey_names(&self) -> Vec<String> {
            let mut names = Vec::new();
            let mut index = 0;
            loop {
                let mut buf = [0u16; 256];
                let mut len = buf.len() as u32;
                let res = unsafe {
                    RegEnumKeyExW(
                        self.0,
                        index,
                        buf.as_mut_ptr(),
                        &mut len,
                        std::ptr::null(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                index += 1;
                match res {
                    0 => names.push(String::from_utf16_lossy(&buf[..len as usize])),
                    ERROR_MORE_DATA => continue,
                    _ => break,
                }
            }
            names
        }

        pub fn string(&self, name: &str) -> Option<String> {
            let name = wide(name);
            let mut kind: REG_VALUE_TYPE = 0;
            let mut size: u32 = 0;
            let res = unsafe {
                RegQueryValueExW(self.0, name.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size)
            };
            if res != 0 || (kind != REG_SZ && kind != REG_EXPAND_SZ) {
                return None;
            }
            let mut buf = vec![0u16; size as usize / 2 + 1];
            let mut bytes = (buf.len() * 2) as u32;
            let res = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    buf.as_mut_ptr() as *mut u8,
                    &mut bytes,
                )
            };
            if res != 0 {
                return None;
            }
            let chars = &buf[..(bytes as usize / 2).min(buf.len())];
            let end = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
            let value = String::from_utf16_lossy(&chars[..end]).trim().to_string();
            let value = if kind == REG_EXPAND_SZ {
                super::expand_env_vars(&value)
            } else {
                value
            };
            (!value.is_empty()).then_some(value)
        }
    }

    pub fn uninstall_entries() -> Vec<super::UninstallEntry> {
        const UNINSTALL: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
        const UNINSTALL_WOW: &str = "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
        let roots = [
            (HKEY_LOCAL_MACHINE, UNINSTALL),
            (HKEY_CURRENT_USER, UNINSTALL),
            (HKEY_LOCAL_MACHINE, UNINSTALL_WOW),
        ];
        let mut out = Vec::new();
        for (root, path) in roots {
            let Some(key) = Key::open(root, path) else {
                continue;
            };
            for sub in key.subkey_names() {
                let Some(app) = key.child(&sub) else {
                    continue;
                };
                out.push(super::UninstallEntry {
                    name: app.string("DisplayName"),
                    icon: app.string("DisplayIcon"),
                    location: app.string("InstallLocation"),
                    uninstall: app.string("UninstallString"),
                });
            }
        }
        out
    }
}

#[cfg(target_os = "windows")]
fn uninstall_entries() -> Vec<UninstallEntry> {
    registry::uninstall_entries()
}

#[cfg(not(target_os = "windows"))]
fn uninstall_entries() -> Vec<UninstallEntry> {
    Vec::new()
}

fn resolve_uninstall_entry(app: UninstallEntry) -> Option<(String, String)> {
    let app_name = app.name?;
    if app_name.len() < 2 {
        return None;
    }

    let mut resolved_path = app.icon.as_deref().and_then(clean_registry_path);

    if resolved_path.is_none() {
        if let Some(loc_path) = &app.location {
            let cleaned = loc_path.trim().replace('"', "");
            if !cleaned.is_empty() && Path::new(&cleaned).exists() {
                resolved_path = find_exe_in_dir(&cleaned, &app_name);
            }
        }
    }

    if resolved_path.is_none() {
        if let Some(cleaned) = app.uninstall.as_deref().and_then(clean_registry_path) {
            if let Some(parent) = Path::new(&cleaned).parent() {
                if parent.exists() {
                    resolved_path = find_exe_in_dir(&parent.to_string_lossy(), &app_name);
                }
            }
        }
    }

    let path = resolved_path?;
    Path::new(&path).is_file().then_some((app_name, path))
}

fn index_registry_apps(entries: &mut Vec<SearchEntry>) {
    let mut seen = std::collections::HashSet::new();
    let mut seen_paths = std::collections::HashSet::new();
    for app in uninstall_entries() {
        let Some(key) = app.name.as_ref().map(|n| n.to_lowercase()) else {
            continue;
        };
        if seen.contains(&key) {
            continue;
        }
        let Some((app_name, path)) = resolve_uninstall_entry(app) else {
            continue;
        };
        if !seen_paths.insert(path.to_lowercase()) {
            continue;
        }
        seen.insert(key);
        entries.push(SearchEntry {
            name_lower: app_name.to_lowercase().into_boxed_str(),
            path,
            kind: KIND_APP,
        });
    }
}

const SCAN_FROM: f64 = 5.0;
const SCAN_TO: f64 = 92.0;

const SCAN_SMOOTH: f64 = 40_000.0;

const EMIT_EVERY_MS: u128 = 150;
const EMIT_EVERY_FILES: usize = 1500;

fn is_skipped_name(name: &str, skip_dirs: &std::collections::HashSet<String>) -> bool {
    let name = name.to_lowercase();
    name.starts_with('.') || skip_dirs.contains(name.as_str())
}

fn pruned_walk(root: &Path, skip_dirs: std::collections::HashSet<String>) -> WalkDir {
    WalkDir::new(root)
        .follow_links(false)
        .skip_hidden(false)
        .process_read_dir(move |depth, _, _, children| {
            if depth.is_none() {
                return;
            }
            children.retain(|child| match child {
                Ok(c) => !is_skipped_name(&c.file_name().to_string_lossy(), &skip_dirs),
                Err(_) => true,
            });
        })
}

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

    for entry in pruned_walk(root, skip_dirs.clone()).into_iter().filter_map(|e| e.ok()) {
        
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("umbra-indexer-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: PathBuf) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn pruned_walk_skips_whole_excluded_subtrees() {
        let root = temp_dir("walk");
        touch(root.join("keep").join("a.txt"));
        touch(root.join("node_modules").join("pkg").join("index.js"));
        touch(root.join("Build").join("out").join("app.exe"));
        touch(root.join(".git").join("config"));
        touch(root.join("$Recycle.Bin").join("S-1-5").join("deleted.docx"));
        let skip: HashSet<String> = ["node_modules", "build", "$recycle.bin"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        let found: HashSet<String> = pruned_walk(&root, skip)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.depth() > 0)
            .map(|e| e.path().strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();

        let expected: HashSet<String> = ["keep", "keep/a.txt"].iter().map(|s| s.to_string()).collect();
        assert_eq!(found, expected);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn system_tools_are_indexed_without_recursing() {
        let root = temp_dir("tools");
        touch(root.join("notepad.exe"));
        touch(root.join("readme.txt"));
        touch(root.join("drivers").join("hidden.exe"));

        let mut entries = Vec::new();
        index_system_tools(&mut entries, &[root.clone(), root.join("missing")]);

        let names: Vec<&str> = entries.iter().map(|e| e.name_lower.as_ref()).collect();
        assert_eq!(names, vec!["notepad"]);
        assert!(entries.iter().all(|e| e.kind == KIND_APP));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn program_folders_contribute_only_exes() {
        let root = temp_dir("programs");
        touch(root.join("Portable Tool").join("tool.exe"));
        touch(root.join("Portable Tool").join("tool.dll"));
        touch(root.join("Vendor App").join("bin").join("app.EXE"));
        touch(root.join("Vendor App").join("node_modules").join("x").join("helper.exe"));
        let skip: HashSet<String> = HashSet::from(["node_modules".to_string()]);

        let mut entries = Vec::new();
        index_program_exes(&mut entries, &[(root.clone(), None), (root.join("missing"), None)], &skip, &[]);
        let mut names: Vec<&str> = entries.iter().map(|e| e.name_lower.as_ref()).collect();
        names.sort();
        assert_eq!(names, vec!["app", "tool"]);

        let mut shallow = Vec::new();
        index_program_exes(&mut shallow, &[(root.clone(), Some(2))], &skip, &[]);
        let names: Vec<&str> = shallow.iter().map(|e| e.name_lower.as_ref()).collect();
        assert_eq!(names, vec!["tool"], "max depth must stop before Vendor App/bin/app.EXE");

        let excluded_root = root.join("Program Files");
        touch(excluded_root.join("Vendor").join("vendor-app.exe"));
        let skip_root: HashSet<String> = HashSet::from(["program files".to_string()]);
        let mut from_root = Vec::new();
        index_program_exes(&mut from_root, &[(excluded_root, None)], &skip_root, &[]);
        assert_eq!(from_root.len(), 1, "a root named like an exclude must still be walked");

        let mut none = Vec::new();
        let drive = root.to_string_lossy()[..3].to_string();
        index_program_exes(&mut none, &[(root.clone(), None)], &skip, &[drive]);
        assert!(none.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_paths_reports_only_deleted_targets() {
        let root = temp_dir("missing");
        touch(root.join("alive.exe"));
        let alive = root.join("alive.exe").to_string_lossy().to_string();
        let gone = root.join("gone.lnk").to_string_lossy().to_string();

        let missing = missing_paths(vec![alive, gone.clone()]);
        assert_eq!(missing, HashSet::from([gone]));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn expands_environment_variables_like_reg_expand_sz() {
        std::env::set_var("UMBRA_TEST_DIR", "C:\\Tools");
        assert_eq!(expand_env_vars("%UMBRA_TEST_DIR%\\app.exe,0"), "C:\\Tools\\app.exe,0");
        assert_eq!(expand_env_vars("%UMBRA_MISSING_VAR%\\x"), "%UMBRA_MISSING_VAR%\\x");
        assert_eq!(expand_env_vars("100% done"), "100% done");
        assert_eq!(expand_env_vars("%%"), "%%");
        assert_eq!(expand_env_vars("plain"), "plain");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn registry_uninstall_entries_are_readable() {
        let entries = uninstall_entries();
        assert!(entries.iter().any(|e| e.name.is_some()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn app_exe_is_never_guessed_inside_windows_folder() {
        let system32 = system_tool_dirs().remove(0);
        assert!(is_inside_system_root(&system32));
        assert_eq!(find_exe_in_dir(&system32.to_string_lossy(), "Application Compatibility Database"), None);
        assert!(!is_inside_system_root(Path::new("C:\\Program Files\\WinRAR")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn common_windows_tools_are_found() {
        let mut entries = Vec::new();
        index_system_tools(&mut entries, &system_tool_dirs());
        let names: HashSet<&str> = entries.iter().map(|e| e.name_lower.as_ref()).collect();
        for tool in ["notepad", "cmd", "regedit", "taskmgr", "explorer", "calc", "control", "powershell"] {
            assert!(names.contains(tool), "{tool} missing");
        }
    }
}
