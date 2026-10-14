//! The search index on disk, so a start can search files right away instead of
//! waiting a minute for the drive walk. Written after every full walk and, while
//! Umbra runs, a while after the file watcher changed something.
//!
//! Format: "UMBRAIDX", u32 version, varint count, then per entry: kind byte,
//! varint bytes shared with the previous path, varint + bytes of the rest of the
//! path, and a name byte: 0 when the name is the usual one for that path, 1
//! followed by varint + bytes of a custom name (Start Menu / registry titles).
//! Neighbouring entries mostly share a folder, so paths shrink to their tails.
use crate::indexer::{derive_display_name, SearchEntry};
use std::path::PathBuf;
const MAGIC: &[u8; 8] = b"UMBRAIDX";
const VERSION: u32 = 1;
fn cache_path() -> PathBuf {
    crate::paths::config_dir().join("index.bin")
}
fn put_varint(out: &mut Vec<u8>, mut n: usize) {
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}
fn put_str(out: &mut Vec<u8>, s: &str) {
    put_varint(out, s.len());
    out.extend_from_slice(s.as_bytes());
}
/// Length of the common prefix of `a` and `b`, cut back to a char boundary.
fn shared_prefix(a: &str, b: &str) -> usize {
    let mut n = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    while !b.is_char_boundary(n) {
        n -= 1;
    }
    n
}
fn default_name(path: &str, kind: u8) -> String {
    derive_display_name(path, kind).to_lowercase()
}
pub(crate) fn encode(entries: &[SearchEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(entries.len() * 24 + 16);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    put_varint(&mut out, entries.len());
    let mut prev: &str = "";
    for e in entries {
        let shared = shared_prefix(prev, &e.path);
        out.push(e.kind);
        put_varint(&mut out, shared);
        put_str(&mut out, &e.path[shared..]);
        if *e.name_lower == *default_name(&e.path, e.kind) {
            out.push(0);
        } else {
            out.push(1);
            put_str(&mut out, &e.name_lower);
        }
        prev = &e.path;
    }
    out
}
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Option<u8> {
        let b = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }
    fn varint(&mut self) -> Option<usize> {
        let mut n = 0usize;
        for shift in (0..64).step_by(7) {
            let b = self.byte()?;
            n |= ((b & 0x7f) as usize) << shift;
            if b & 0x80 == 0 {
                return Some(n);
            }
        }
        None
    }
    fn str(&mut self) -> Option<&'a str> {
        let len = self.varint()?;
        let bytes = self.data.get(self.pos..self.pos.checked_add(len)?)?;
        self.pos += len;
        std::str::from_utf8(bytes).ok()
    }
}
/// None for anything that is not a complete, current-version index file.
pub(crate) fn decode(data: &[u8]) -> Option<Vec<SearchEntry>> {
    if data.len() < 12 || &data[..8] != MAGIC || data[8..12] != VERSION.to_le_bytes() {
        return None;
    }
    let mut r = Reader { data, pos: 12 };
    let count = r.varint()?;
    // A corrupt count must not reserve gigabytes up front.
    let mut entries = Vec::with_capacity(count.min(data.len() / 4));
    let mut prev = String::new();
    for _ in 0..count {
        let kind = r.byte()?;
        let shared = r.varint()?;
        let rest = r.str()?;
        if shared > prev.len() || !prev.is_char_boundary(shared) {
            return None;
        }
        let mut path = String::with_capacity(shared + rest.len());
        path.push_str(&prev[..shared]);
        path.push_str(rest);
        let name_lower = match r.byte()? {
            0 => default_name(&path, kind),
            1 => r.str()?.to_string(),
            _ => return None,
        };
        prev.clone_from(&path);
        entries.push(SearchEntry { name_lower: name_lower.into_boxed_str(), path, kind });
    }
    (r.pos == data.len()).then_some(entries)
}
pub(crate) fn load() -> Option<Vec<SearchEntry>> {
    decode(&std::fs::read(cache_path()).ok()?)
}
/// Encodes the live index under its read lock (searches keep running) and writes
/// the file after letting go of it.
pub(crate) fn save_live_index() {
    if let Some(bytes) = crate::indexer::with_entries(encode) {
        let _ = crate::storage::write_atomic(&cache_path(), bytes);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::{KIND_APP, KIND_FILE, KIND_FOLDER};
    fn entry(name: &str, path: &str, kind: u8) -> SearchEntry {
        SearchEntry { name_lower: name.to_lowercase().into_boxed_str(), path: path.to_string(), kind }
    }
    fn same(a: &[SearchEntry], b: &[SearchEntry]) -> bool {
        a.len() == b.len()
            && a.iter().zip(b).all(|(x, y)| x.path == y.path && x.kind == y.kind && x.name_lower == y.name_lower)
    }
    #[test]
    fn round_trips_paths_names_and_kinds() {
        let entries = vec![
            entry("Google Chrome", "C:\\ProgramData\\Start Menu\\Google Chrome.lnk", 1),
            entry("photos", "D:\\Фото\\photos", KIND_FOLDER),
            entry("отпуск.jpg", "D:\\Фото\\photos\\отпуск.jpg", 4),
            entry("отпуск (2).jpg", "D:\\Фото\\photos\\отпуск (2).jpg", 4),
            entry("Claude", "C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\claude.exe", KIND_APP),
            entry("readme", "C:\\readme", KIND_FILE),
        ];
        let bytes = encode(&entries);
        assert!(same(&decode(&bytes).unwrap(), &entries));
        // Shared folders are stored once: far smaller than the raw paths.
        let raw: usize = entries.iter().map(|e| e.path.len()).sum();
        assert!(bytes.len() < raw, "{} >= {}", bytes.len(), raw);
    }
    #[test]
    fn rejects_damaged_files() {
        let bytes = encode(&[entry("a.txt", "C:\\a.txt", KIND_FILE), entry("b.txt", "C:\\b.txt", KIND_FILE)]);
        assert!(decode(&bytes).is_some());
        assert!(decode(&bytes[..bytes.len() - 1]).is_none(), "truncated");
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode(&extra).is_none(), "trailing bytes");
        let mut version = bytes.clone();
        version[8] = 99;
        assert!(decode(&version).is_none(), "other version");
        assert!(decode(b"not an index").is_none());
        assert!(decode(&[]).is_none());
    }
}
