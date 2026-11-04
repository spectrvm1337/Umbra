//! The version of the program a row opens: a shortcut's target, any other file itself. Used to pick
//! the newest of several copies of the same program (search.rs, newest_copies). Shortcut targets
//! and versions are read once and again only after the file changed, so a search never waits on
//! more than the few new duplicates it finds.
use crate::sync::LockExt;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// path -> (its modification time when read, what was read)
static TARGETS: LazyLock<Mutex<HashMap<String, (Option<SystemTime>, Option<String>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static VERSIONS: LazyLock<Mutex<HashMap<String, (Option<SystemTime>, Option<u64>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn modified(path: &str) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Looks `path` up in `cache`, reading it with `read` when it is new or its file changed.
fn cached<T: Clone>(cache: &Mutex<HashMap<String, (Option<SystemTime>, T)>>, path: &str, read: impl FnOnce() -> T) -> T {
    let stamp = modified(path);
    if let Some((when, value)) = cache.lock_or_recover().get(path) {
        if *when == stamp {
            return value.clone();
        }
    }
    let value = read();
    let mut cache = cache.lock_or_recover();
    // A cap rather than an eviction policy: these are only ever the duplicates among search results.
    if cache.len() > 4096 {
        cache.clear();
    }
    cache.insert(path.to_string(), (stamp, value.clone()));
    value
}

/// The program's product version as one number (major.minor.build.revision, 16 bits each), or None
/// for a shortcut to nothing or a file without a version.
pub fn of(path: &str) -> Option<u64> {
    let target = if path.to_lowercase().ends_with(".lnk") {
        cached(&TARGETS, path, || crate::icons::resolve_lnk_target(path))?
    } else {
        path.to_string()
    };
    cached(&VERSIONS, &target, || unsafe { file_version(&target) })
}

unsafe fn file_version(path: &str) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO};
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let size = GetFileVersionInfoSizeW(wide.as_ptr(), std::ptr::null_mut());
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    if GetFileVersionInfoW(wide.as_ptr(), 0, size, buf.as_mut_ptr() as _) == 0 {
        return None;
    }
    let root: [u16; 2] = [b'\\' as u16, 0];
    let mut info: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len = 0u32;
    if VerQueryValueW(buf.as_ptr() as _, root.as_ptr(), &mut info, &mut len) == 0 || info.is_null() {
        return None;
    }
    let fixed = &*(info as *const VS_FIXEDFILEINFO);
    Some(((fixed.dwProductVersionMS as u64) << 32) | fixed.dwProductVersionLS as u64)
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_version_of_a_windows_program_and_none_for_a_missing_one() {
        let notepad = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()) + r"\System32\notepad.exe";
        assert!(super::of(&notepad).is_some_and(|v| v > 0));
        assert_eq!(super::of(r"C:\definitely\not\here.exe"), None);
    }
}
