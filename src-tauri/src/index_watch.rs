//! Keeps the search index current while Umbra runs. One thread per fixed drive
//! waits in ReadDirectoryChangesW on the whole drive (no admin rights needed,
//! unlike the NTFS change journal); another collects what they report and
//! applies it to the index in batches. What changed while Umbra was closed is
//! picked up by the drive walk at the next start.
use crate::sync::LockExt;
use crate::indexer::{self, SearchEntry};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
/// A path that appeared (created, or the new name of a rename / move) or went
/// away (deleted, or the old name).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Change {
    Added(String),
    Removed(String),
}
enum Event {
    Changes(Vec<Change>),
    /// The drive reported more than the buffer could hold; some changes are lost.
    Overflow,
}
/// Batches applied while a full walk runs are collected here and applied again
/// to the walk's result when it replaces the index, so none of them get lost.
/// They are kept already prepared: re-reading the disk for them here would
/// happen under the write lock.
static SCAN_JOURNAL: Mutex<Option<Vec<Batch>>> = Mutex::new(None);
pub(crate) fn begin_scan_journal() {
    *SCAN_JOURNAL.lock_or_recover() = Some(Vec::new());
}
/// Call with the index write lock held, right after the walk's result went in.
pub(crate) fn finish_scan_journal(entries: &mut Vec<SearchEntry>) {
    if let Some(batches) = SCAN_JOURNAL.lock_or_recover().take() {
        for batch in &batches {
            commit(entries, batch);
        }
    }
}
fn skip_set() -> HashSet<String> {
    crate::config::index_skip_set()
}
fn disabled_drives() -> Vec<String> {
    crate::config::get_disabled_drives()
}
/// Same rule as the drive walk: a hidden (dot) or excluded name anywhere below
/// the drive root keeps the path out of the index.
fn is_excluded(path: &str, skip: &HashSet<String>) -> bool {
    path.split('\\').skip(1).any(|part| !part.is_empty() && indexer::is_skipped_name(part, skip))
}
fn on_disabled_drive(path: &str, disabled: &[String]) -> bool {
    // Compared as bytes, never as a string slice. `path[..d.len()]` panics when
    // the cut lands inside a multi-byte character, which a drive letter
    // followed by a Cyrillic folder name reaches at once -- and this runs under
    // the index's write lock, so the panic would poison it and take the search
    // down with it.
    disabled.iter().any(|d| {
        let d = d.trim_end_matches('\\');
        !d.is_empty()
            && path.len() >= d.len()
            && path.as_bytes()[..d.len()].eq_ignore_ascii_case(d.as_bytes())
    })
}
fn entry_for(path: &str, is_dir: bool) -> SearchEntry {
    let file_name = Path::new(path).file_name().unwrap_or_default().to_string_lossy();
    let kind = indexer::kind_from_file(&file_name, is_dir);
    SearchEntry {
        name_lower: indexer::derive_display_name(path, kind).to_lowercase().into_boxed_str(),
        path: path.to_string(),
        kind,
    }
}
/// A set of changes worked out against the disk, ready to go into the index.
#[derive(Clone, Default)]
pub(crate) struct Batch {
    removed: HashSet<String>,
    added: Vec<SearchEntry>,
}
/// Applies a batch of changes in one go (tests and callers that hold no lock).
pub(crate) fn apply_changes(
    entries: &mut Vec<SearchEntry>,
    changes: &[Change],
    skip: &HashSet<String>,
    disabled: &[String],
) {
    commit(entries, &prepare(changes, skip, disabled));
}
/// Everything that touches the disk: only the last change per path counts, and
/// an added folder is walked, because a folder moved in is reported as one name.
/// Runs without the index lock -- a folder of fifty thousand files dropped in
/// takes a while to walk, and the search must not wait for it.
pub(crate) fn prepare(changes: &[Change], skip: &HashSet<String>, disabled: &[String]) -> Batch {
    let mut last: HashMap<&str, bool> = HashMap::new(); // path -> exists
    for c in changes {
        match c {
            Change::Added(p) => last.insert(p.as_str(), true),
            Change::Removed(p) => last.insert(p.as_str(), false),
        };
    }
    let removed: HashSet<String> = last.iter().filter(|(_, &added)| !added).map(|(p, _)| p.to_string()).collect();
    let mut added: Vec<SearchEntry> = Vec::new();
    for (path, _) in last.iter().filter(|(_, &added)| added) {
        if is_excluded(path, skip) || on_disabled_drive(path, disabled) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            continue; // already gone again
        };
        added.push(entry_for(path, meta.is_dir()));
        if meta.is_dir() {
            for child in indexer::pruned_walk(Path::new(path), skip.clone()).into_iter().filter_map(|e| e.ok()) {
                if child.depth() == 0 {
                    continue;
                }
                let child_path = child.path().to_string_lossy().to_string();
                added.push(entry_for(&child_path, child.file_type().is_dir()));
            }
        }
    }
    Batch { removed, added }
}
/// Puts a prepared batch into the index: a removed path also takes everything
/// below it (a deleted or renamed folder). No disk access, so it is safe under
/// the write lock.
pub(crate) fn commit(entries: &mut Vec<SearchEntry>, batch: &Batch) {
    let removed = &batch.removed;
    let added_paths: HashSet<&str> = batch.added.iter().map(|e| e.path.as_str()).collect();
    if !removed.is_empty() || !added_paths.is_empty() {
        // This runs under the index's write lock, so its cost is everyone's wait:
        // one hash lookup per entry, nothing more. Only a folder can have
        // anything below it, so the removed folders are noted in this pass and
        // matched by prefix in a second one that is skipped when there are none.
        // (Walking every entry's chain of parent folders here took seconds on a
        // large index, for a batch of a dozen changes.)
        let mut removed_dirs: Vec<String> = Vec::new();
        entries.retain(|e| {
            if added_paths.contains(e.path.as_str()) {
                return false; // replaced by the fresh entry below
            }
            if removed.contains(e.path.as_str()) {
                if e.kind == indexer::KIND_FOLDER {
                    removed_dirs.push(format!("{}\\", e.path.trim_end_matches('\\')));
                }
                return false;
            }
            true
        });
        if !removed_dirs.is_empty() {
            entries.retain(|e| !removed_dirs.iter().any(|d| e.path.starts_with(d.as_str())));
        }
    }
    entries.extend(batch.added.iter().cloned());
}
/// Watches every fixed drive that is indexed. Removable drives are left alone so
/// an open handle never blocks ejecting them.
#[cfg(target_os = "windows")]
pub fn start(app: tauri::AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<Event>();
    for drive in indexer::get_available_drives() {
        if is_fixed_drive(&drive) {
            let tx = tx.clone();
            std::thread::Builder::new()
                .name(format!("umbra-watch-{}", &drive[..1]))
                .spawn(move || watch_drive(&drive, tx))
                .ok();
        }
    }
    std::thread::Builder::new()
        .name("umbra-watch-apply".into())
        .spawn(move || apply_loop(app, rx))
        .ok();
}
#[cfg(target_os = "windows")]
fn is_fixed_drive(drive: &str) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(wide.as_ptr()) == 3 } // DRIVE_FIXED
}
/// Blocks in ReadDirectoryChangesW for the whole drive and forwards the names.
#[cfg(target_os = "windows")]
fn watch_drive(root: &str, tx: Sender<Event>) {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_ACTION_ADDED, FILE_ACTION_REMOVED,
        FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return;
    }
    // u32-aligned, as the records require; local drives accept more than 64 KB.
    let mut buf = vec![0u32; 128 * 1024];
    let prefix = root.trim_end_matches('\\');
    loop {
        let mut bytes = 0u32;
        let ok = unsafe {
            ReadDirectoryChangesW(
                handle,
                buf.as_mut_ptr() as *mut _,
                (buf.len() * 4) as u32,
                1,
                FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME,
                &mut bytes,
                std::ptr::null_mut(),
                None,
            )
        };
        if ok == 0 {
            break; // the drive went away or the handle broke
        }
        if bytes == 0 {
            if tx.send(Event::Overflow).is_err() {
                break;
            }
            continue;
        }
        let data = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, bytes as usize) };
        let mut changes = Vec::new();
        let mut offset = 0usize;
        while offset + 12 <= data.len() {
            let field = |at: usize| u32::from_le_bytes(data[offset + at..offset + at + 4].try_into().unwrap());
            let (next, action, name_len) = (field(0) as usize, field(4), field(8) as usize);
            let end = (offset + 12 + name_len).min(data.len());
            let name: Vec<u16> = data[offset + 12..end]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let path = format!("{}\\{}", prefix, String::from_utf16_lossy(&name));
            match action {
                FILE_ACTION_ADDED | FILE_ACTION_RENAMED_NEW_NAME => changes.push(Change::Added(path)),
                FILE_ACTION_REMOVED | FILE_ACTION_RENAMED_OLD_NAME => changes.push(Change::Removed(path)),
                _ => {}
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
        if !changes.is_empty() && tx.send(Event::Changes(changes)).is_err() {
            break;
        }
    }
    unsafe { CloseHandle(handle) };
}
const BATCH_QUIET: Duration = Duration::from_millis(400);
const SAVE_AFTER: Duration = Duration::from_secs(60);
const OVERFLOW_RESCAN_EVERY: Duration = Duration::from_secs(30 * 60);
/// Gathers changes until the drives are quiet for a moment, applies them, and
/// saves the index to disk a minute after the last applied change.
fn apply_loop(app: tauri::AppHandle, rx: Receiver<Event>) {
    let mut pending: Vec<Change> = Vec::new();
    let mut dirty_since: Option<Instant> = None;
    let mut last_overflow_rescan: Option<Instant> = None;
    loop {
        let timeout = if pending.is_empty() { Duration::from_secs(10) } else { BATCH_QUIET };
        match rx.recv_timeout(timeout) {
            Ok(Event::Changes(changes)) => {
                pending.extend(changes);
                continue;
            }
            Ok(Event::Overflow) => {
                if last_overflow_rescan.map_or(true, |t| t.elapsed() >= OVERFLOW_RESCAN_EVERY) {
                    last_overflow_rescan = Some(Instant::now());
                    indexer::init_index_with_progress(app.clone());
                }
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if !pending.is_empty() {
            let changes = std::mem::take(&mut pending);
            let batch = prepare(&changes, &skip_set(), &disabled_drives());
            if let Some(mut w) = indexer::write_index() {
                commit(&mut w, &batch);
                if let Some(journal) = SCAN_JOURNAL.lock_or_recover().as_mut() {
                    journal.push(batch);
                }
            }
            dirty_since.get_or_insert_with(Instant::now);
        }
        if dirty_since.is_some_and(|t| t.elapsed() >= SAVE_AFTER) {
            dirty_since = None;
            crate::index_cache::save_live_index();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("umbra-watch-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn paths(entries: &[SearchEntry]) -> Vec<String> {
        let mut v: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
        v.sort();
        v
    }
    #[test]
    fn adds_removes_and_follows_folder_moves() {
        let root = temp_root("apply");
        let r = root.to_string_lossy().to_string();
        let skip: HashSet<String> = ["node_modules".to_string(), ".*".to_string()].into_iter().collect();
        let mut entries = vec![
            entry_for(&format!("{r}\\old"), true),
            entry_for(&format!("{r}\\old\\a.txt"), false),
            entry_for(&format!("{r}\\keep.txt"), false),
        ];
        // A new file, a file inside an excluded folder, a hidden file.
        fs::write(root.join("new.pdf"), b"").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("x.js"), b"").unwrap();
        fs::write(root.join(".secret"), b"").unwrap();
        // "old" renamed to "moved" (with its file), as Windows reports it.
        fs::create_dir_all(root.join("moved")).unwrap();
        fs::write(root.join("moved").join("a.txt"), b"").unwrap();
        apply_changes(
            &mut entries,
            &[
                Change::Added(format!("{r}\\new.pdf")),
                Change::Added(format!("{r}\\node_modules\\x.js")),
                Change::Added(format!("{r}\\.secret")),
                Change::Removed(format!("{r}\\old")),
                Change::Added(format!("{r}\\moved")),
                Change::Added(format!("{r}\\ghost.txt")), // created and gone again
            ],
            &skip,
            &[],
        );
        assert_eq!(
            paths(&entries),
            vec![
                format!("{r}\\keep.txt"),
                format!("{r}\\moved"),
                format!("{r}\\moved\\a.txt"),
                format!("{r}\\new.pdf"),
            ]
        );
        // Deleted again later: the last change for a path wins.
        apply_changes(
            &mut entries,
            &[Change::Added(format!("{r}\\keep.txt")), Change::Removed(format!("{r}\\keep.txt"))],
            &skip,
            &[],
        );
        assert!(!paths(&entries).contains(&format!("{r}\\keep.txt")));
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn disabled_drives_and_excluded_parts_stay_out() {
        let skip: HashSet<String> = ["appdata".to_string(), ".*".to_string()].into_iter().collect();
        assert!(is_excluded("C:\\Users\\x\\AppData\\Local\\tmp.txt", &skip));
        assert!(is_excluded("C:\\code\\.git\\HEAD", &skip));
        // With the hidden-folders switch on, the marker is gone and only the plain list applies.
        let hidden_on: HashSet<String> = ["appdata".to_string()].into_iter().collect();
        assert!(!is_excluded("C:\\Users\\x\\.config\\a.txt", &hidden_on));
        assert!(!is_excluded("C:\\Users\\x\\Documents\\report.docx", &skip));
        assert!(on_disabled_drive("d:\\photos\\a.jpg", &["D:\\".to_string()]));
        assert!(!on_disabled_drive("C:\\a.jpg", &["D:\\".to_string()]));
    }
}
