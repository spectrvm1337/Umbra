//! File previews for the search box.
//!
//! Everything here is best-effort: a preview that cannot be produced is not an
//! error, it is just an empty panel. Almost none of it needs a new dependency —
//! Windows already renders thumbnails for images, PDF, Office documents and
//! media, so `IShellItemImageFactory` gives us the same picture Explorer shows.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

/// Thumbnails are big enough that a count-based cache would evict the wrong
/// thing, so the budget is in bytes.
const THUMB_CACHE_BYTES: usize = 64 * 1024 * 1024;
/// How much of a text file to read before deciding what to show.
const TEXT_PROBE_BYTES: usize = 16 * 1024;
const TEXT_MAX_LINES: usize = 60;
const TEXT_MAX_LINE_CHARS: usize = 200;
/// Past this a "text" file is a database or a dump, not something to preview.
const TEXT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

const IMAGE: &[&str] = &[
    "png", "jpg", "jpeg", "jfif", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif", "heic",
    "avif",
];
const DOCUMENT: &[&str] = &[
    "pdf", "doc", "docx", "odt", "rtf", "epub", "xls", "xlsx", "ppt", "pptx", "wps", "one",
];
const AUDIO: &[&str] = &[
    "mp3", "wav", "ogg", "oga", "flac", "aac", "wma", "m4a", "opus", "mid",
];
const VIDEO: &[&str] = &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "3gp", "ts"];
const TEXT: &[&str] = &[
    "txt", "log", "md", "markdown", "csv", "tsv", "json", "xml", "yml", "yaml", "toml", "ini",
    "cfg", "conf", "env", "bat", "cmd", "ps1", "sh", "rs", "js", "mjs", "cjs", "ts", "tsx",
    "jsx", "py", "rb", "go", "java", "c", "h", "cpp", "hpp", "cs", "php", "css", "scss", "html",
    "htm", "sql", "lua", "vue", "svelte", "gitignore", "editorconfig", "diff", "patch", "srt",
];

/// What the panel should draw. `kind` decides which half of the layout is used.
#[derive(Serialize, Clone, Default)]
pub struct Preview {
    pub path: String,
    /// One of: image, document, text, media, url, folder, archive, other.
    pub kind: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
    pub modified_ms: Option<u64>,
    /// `data:image/png;base64,…` from the Shell thumbnail handler.
    pub thumb: Option<String>,
    pub thumb_w: u32,
    pub thumb_h: u32,
    pub text: Option<String>,
    pub encoding: Option<String>,
    /// More content existed than was read.
    pub truncated: bool,
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_url(path: &str) -> bool {
    let p = path.trim_start();
    // `get(..n)` hands back None when n is not on a character boundary, which a
    // Cyrillic folder name reaches almost immediately: in "D:\\Рабочий..." the
    // eighth byte is the middle of a two-byte character. Slicing panics there,
    // and since this ran for every path, one ordinary folder name took the whole
    // preview down.
    p.get(..7).is_some_and(|h| h.eq_ignore_ascii_case("http://"))
        || p.get(..8).is_some_and(|h| h.eq_ignore_ascii_case("https://"))
}

/// Classifies by extension. Folders and URLs are decided by the caller, which
/// knows whether the path exists on disk.
///
/// Audio and video stay separate because the panel gives them different
/// affordances: one is a poster with a duration, the other a player.
fn classify(ext: &str) -> &'static str {
    if IMAGE.contains(&ext) {
        "image"
    } else if DOCUMENT.contains(&ext) {
        "document"
    } else if AUDIO.contains(&ext) {
        "audio"
    } else if VIDEO.contains(&ext) {
        "video"
    } else if TEXT.contains(&ext) {
        "text"
    } else {
        "other"
    }
}

/// Whether the Shell has anything to show. Unknown types are worth asking about:
/// Explorer can have a handler registered for an extension we do not know.
///
/// Audio and video are deliberately absent. `IShellItemImageFactory` falls back
/// to the file's own icon whenever it cannot produce a real picture, and for
/// media that is what it does -- Windows cannot decode `.webm` or `.mkv` at all,
/// and asking for a video thumbnail reliably returns the icon you would see on
/// the Desktop. Showing that is worse than showing nothing, so the panel seeks
/// into the video itself instead and the Shell is not consulted.
fn wants_thumbnail(kind: &str) -> bool {
    matches!(kind, "image" | "document" | "archive" | "other")
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    let t = meta.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as u64)
}

/// Appends to panic.log next to the config. Used for the things that are worth
/// knowing about but are not worth interrupting anybody over -- a thumbnail
/// provider that declined, a DIB that would not copy. The window is compiled
/// with a windows subsystem, so there is no console to print to.
pub fn log_note(message: &str) {
    use std::io::Write;
    let path = crate::paths::config_dir().join("panic.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{stamp}  {message}");
    }
}

/// Panics in a GUI build go nowhere by default: there is no console, and the
/// default hook writes to stderr. Recording it means the next report can say
/// what actually happened instead of guessing.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "no message".to_string());
        log_note(&format!("PANIC at {where_}: {msg}"));
        previous(info);
    }));
}

/// A preview is decoration. Nothing about it is worth ending the process over,
/// so the whole build runs inside `catch_unwind`: a Shell thumbnail handler or a
/// malformed file that trips a panic inside a dependency comes back as an error
/// the panel can show, and the launcher keeps running.
#[tauri::command]
pub async fn get_preview(path: String, size: Option<u32>) -> Result<Preview, String> {
    let size = size.unwrap_or(320).clamp(64, 1024);
    tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            build_preview(&path, size)
        }))
        .map_err(|_| "the preview handler panicked".to_string())
    })
    .await
    .map_err(|e| format!("preview worker failed: {e}"))?
}

pub fn build_preview(path: &str, thumb_size: u32) -> Preview {
    let mut pv = Preview {
        path: path.to_string(),
        ..Default::default()
    };

    if is_url(path) {
        pv.kind = "url".into();
        return pv;
    }

    let ext = extension_of(path);
    // A directory answers for itself; nothing else in here makes sense for one.
    if std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
        pv.kind = "folder".into();
        pv.is_dir = true;
        return pv;
    }

    pv.kind = classify(&ext).to_string();

    if let Ok(meta) = std::fs::metadata(path) {
        if !meta.is_file() {
            pv.kind = "other".into();
            return pv;
        }
        pv.size_bytes = Some(meta.len());
        pv.modified_ms = modified_ms(&meta);
    }

    if pv.kind == "text" {
        let size_ok = pv.size_bytes.map(|s| s <= TEXT_MAX_FILE_BYTES).unwrap_or(false);
        if size_ok {
            let (text, encoding, truncated) = read_text_head(path);
            pv.text = text;
            pv.encoding = encoding;
            pv.truncated = truncated;
        }
    }

    if wants_thumbnail(&pv.kind) {
        // A shortcut's own icon carries the arrow overlay; the program it opens has the real one.
        let source = if ext == "lnk" {
            crate::icons::resolve_lnk_target(path).unwrap_or_else(|| path.to_string())
        } else {
            path.to_string()
        };
        if let Some((png, w, h)) = thumbnail(&source, thumb_size) {
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
            pv.thumb = Some(format!("data:image/png;base64,{b64}"));
            pv.thumb_w = w;
            pv.thumb_h = h;
        }
    }

    pv
}

/// Picks the encoding of a text file.
///
/// A BOM wins outright, then strict UTF-8 validation, then the zero-byte pattern
/// of BOM-less UTF-16. What is left is the genuinely ambiguous legacy case, and
/// this is a heuristic rather than a language detector: `encoding_rs` ships the
/// decoders but no content sniffer, and a wrong guess is visible in the panel
/// rather than silent, so the caller gets told which encoding was used.
fn detect_encoding(bytes: &[u8]) -> &'static encoding_rs::Encoding {
    use encoding_rs::{Encoding, UTF_8};
    if let Some((enc, _)) = Encoding::for_bom(bytes) {
        return enc;
    }
    // Before the UTF-8 check, not after: BOM-less UTF-16 is *valid* UTF-8 (the
    // NUL halves are legal codepoints), so the null pattern has to win the race.
    if let Some(enc) = looks_like_utf16(bytes) {
        return enc;
    }
    if bytes.is_empty() || std::str::from_utf8(bytes).is_ok() {
        return UTF_8;
    }
    legacy_fallback()
}

/// BOM-less UTF-16 keeps one NUL per character, in the high byte for LE ASCII
/// and the low byte for BE.
fn looks_like_utf16(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    use encoding_rs::{UTF_16BE, UTF_16LE};
    if bytes.len() < 4 || bytes.len() % 2 != 0 {
        return None;
    }
    let sample = &bytes[..bytes.len().min(512)];
    let half = sample.len() / 2;
    if half == 0 {
        return None;
    }
    let even_zero = sample.iter().step_by(2).filter(|b| **b == 0).count();
    let odd_zero = sample.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    let ratio = |n: usize| n as f32 / half as f32;
    if ratio(odd_zero) > 0.3 && even_zero * 3 < odd_zero {
        return Some(UTF_16LE);
    }
    if ratio(even_zero) > 0.3 && odd_zero * 3 < even_zero {
        return Some(UTF_16BE);
    }
    None
}

/// Last resort, and the weakest part of this file.
///
/// Once it is clear the file is not UTF-8 and not UTF-16, there is no reliable
/// way to tell the legacy single-byte encodings apart: Cyrillic in windows-1251
/// occupies 0xC0-0xFF, which is exactly where windows-1252 keeps its accented
/// Latin, and the GBK lead-byte range overlaps the Cyrillic block as well.
/// `encoding_rs` ships the decoders but no content sniffer, and guessing between
/// them by byte statistics only trades one wrong answer for another.
///
/// So it does not guess: everything left over is read as windows-1251. That is
/// the right single choice here — the app ships English, Russian, German and
/// Japanese, a BOM-less legacy file is overwhelmingly likely to come from
/// Russian Windows, and windows-1251 still renders ASCII and unaccented Latin
/// correctly, so the failure mode for a Western file is a few odd accents
/// rather than an unreadable file. The encoding actually used is reported back
/// to the panel rather than hidden.
fn legacy_fallback() -> &'static encoding_rs::Encoding {
    encoding_rs::WINDOWS_1251
}

/// Reads the head of a text file. Anything the decoder cannot map becomes U+FFFD
/// rather than an error, so a misdetected file is still shown, just imperfectly.
fn read_text_head(path: &str) -> (Option<String>, Option<String>, bool) {
    let Ok(file) = std::fs::File::open(path) else {
        return (None, None, false);
    };
    // One byte past the probe proves the file was cut off.
    let mut buf = vec![0u8; TEXT_PROBE_BYTES + 1];
    let Ok(read) = file.take(TEXT_PROBE_BYTES as u64 + 1).read(&mut buf) else {
        return (None, None, false);
    };
    let hit_limit = read > TEXT_PROBE_BYTES;
    buf.truncate(read.min(TEXT_PROBE_BYTES));

    let encoding = detect_encoding(&buf);
    let (decoded, _, _) = encoding.decode(&buf);

    let mut out = String::new();
    let mut lines = 0usize;
    for line in decoded.lines() {
        if lines >= TEXT_MAX_LINES {
            return (
                Some(out.trim_end().to_string()),
                Some(encoding.name().to_string()),
                true,
            );
        }
        let trimmed = line.trim_end();
        let clipped: String = trimmed.chars().take(TEXT_MAX_LINE_CHARS).collect();
        out.push_str(&clipped);
        out.push('\n');
        lines += 1;
    }
    (
        Some(out.trim_end().to_string()),
        Some(encoding.name().to_string()),
        hit_limit,
    )
}

// ---- thumbnail cache ----

static THUMB_CACHE: LazyLock<Mutex<ThumbCache>> =
    LazyLock::new(|| Mutex::new(ThumbCache::new()));

struct ThumbCache {
    map: HashMap<String, (Vec<u8>, u32, u32)>,
    order: VecDeque<String>,
    bytes: usize,
    budget: usize,
}

impl ThumbCache {
    fn new() -> Self {
        Self::with_budget(THUMB_CACHE_BYTES)
    }
    fn with_budget(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            budget,
        }
    }
    fn key(path: &str, size: u32) -> String {
        format!("{size}|{path}")
    }
    fn get(&mut self, key: &str) -> Option<(Vec<u8>, u32, u32)> {
        let hit = self.map.get(key).cloned();
        if hit.is_some() {
            self.order.retain(|k| k != key);
            self.order.push_front(key.to_string());
        }
        hit
    }
    fn insert(&mut self, key: String, value: (Vec<u8>, u32, u32)) {
        let incoming = value.0.len();
        // One thumbnail over budget on its own must not wipe the whole cache.
        if incoming > self.budget {
            return;
        }
        if let Some(old) = self.map.get(&key) {
            self.bytes = self.bytes.saturating_sub(old.0.len());
            self.order.retain(|k| k != &key);
        }
        // Room is made before the new entry joins, so the counter never counts
        // an item that is not in the map.
        while self.bytes + incoming > self.budget {
            match self.order.pop_back() {
                Some(old) => {
                    if let Some(dropped) = self.map.remove(&old) {
                        self.bytes = self.bytes.saturating_sub(dropped.0.len());
                    }
                }
                None => return,
            }
        }
        self.bytes += incoming;
        self.map.insert(key.clone(), value);
        self.order.push_front(key);
    }
}

// A panic inside the worker must not make the next preview panic again on the
// poisoned lock; the cached bytes are still fine to hand out.
fn lock_cache() -> std::sync::MutexGuard<'static, ThumbCache> {
    THUMB_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn thumbnail(path: &str, size: u32) -> Option<(Vec<u8>, u32, u32)> {
    let key = ThumbCache::key(path, size);
    if let Some(hit) = lock_cache().get(&key) {
        return Some(hit);
    }
    let made = shell_thumbnail(path, size);
    if let Some(bytes) = &made {
        lock_cache().insert(key, bytes.clone());
    }
    made
}

#[cfg(target_os = "windows")]
fn shell_thumbnail(path: &str, size: u32) -> Option<(Vec<u8>, u32, u32)> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF};

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        // S_FALSE (already initialised here) still needs the matching uninit.
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let bitmap = (|| -> windows::core::Result<windows::Win32::Graphics::Gdi::HBITMAP> {
            let factory: IShellItemImageFactory =
                SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>)?;
            factory.GetImage(SIZE { cx: size as i32, cy: size as i32 }, SIIGBF(0))
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        if let Err(e) = &bitmap {
            log_note(&format!("Shell gave no thumbnail for {path}: {e:?}"));
        }
        // Read the pixels before releasing the bitmap.
        let hbitmap = match bitmap {
            Ok(b) if !b.is_invalid() => b,
            _ => return None,
        };
        let out = hbitmap_to_png(hbitmap);
        let _ = windows::Win32::Graphics::Gdi::DeleteObject(hbitmap.into());
        out
    }
}

#[cfg(target_os = "windows")]
fn hbitmap_to_png(
    hbitmap: windows::Win32::Graphics::Gdi::HBITMAP,
) -> Option<(Vec<u8>, u32, u32)> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS,
    };
    unsafe {
        // GetObject reports the bitmap's own dimensions. Asking GetDIBits for
        // them instead does not work: the probe call comes back zero and leaves
        // the header untouched, so there is nothing to size the buffer from.
        let mut bm: BITMAP = std::mem::zeroed();
        if GetObjectW(hbitmap.into(), std::mem::size_of::<BITMAP>() as i32, Some(
            (&mut bm as *mut BITMAP).cast()
        )) == 0
        {
            return None;
        }
        let width = bm.bmWidth.unsigned_abs();
        let height = bm.bmHeight.unsigned_abs();
        // A Shell thumbnail is a screen-sized picture, not a texture; anything
        // this large is a provider misbehaving rather than an image worth showing.
        if width == 0 || height == 0 || width > 4096 || height > 4096 {
            return None;
        }
        let buf_size = width as usize * 4 * height as usize;

        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mut raw = vec![0u8; buf_size];
        let mut copy: BITMAPINFO = std::mem::zeroed();
        copy.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        copy.bmiHeader.biWidth = width as i32;
        copy.bmiHeader.biHeight = -(height as i32); // top-down
        copy.bmiHeader.biPlanes = 1;
        copy.bmiHeader.biBitCount = 32;
        copy.bmiHeader.biCompression = 0;
        let got = GetDIBits(
            screen,
            hbitmap,
            0,
            height,
            Some(raw.as_mut_ptr().cast()),
            &mut copy,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, screen);
        if got == 0 {
            log_note(&format!("GetDIBits returned 0 for {width}x{height}"));
            return None;
        }

        // Shell thumbnails come back as 32bpp BGRA with the alpha channel often
        // left at zero; a fully transparent image would be invisible, so that
        // case is treated as opaque.
        let has_alpha = raw.chunks_exact(4).any(|c| c[3] != 0);
        let mut rgba = Vec::with_capacity(buf_size);
        for c in raw.chunks_exact(4) {
            rgba.push(c[2]);
            rgba.push(c[1]);
            rgba.push(c[0]);
            rgba.push(if has_alpha { c[3] } else { 255 });
        }

        let mut png_data: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_data, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            if let Ok(mut writer) = encoder.write_header() {
                let _ = writer.write_image_data(&rgba);
            }
        }
        if png_data.is_empty() {
            return None;
        }
        Some((png_data, width, height))
    }
}

#[cfg(not(target_os = "windows"))]
fn shell_thumbnail(_path: &str, _size: u32) -> Option<(Vec<u8>, u32, u32)> {
    None
}

#[cfg(all(test, target_os = "windows"))]
mod shell_tests {
    use super::*;

    /// A real file with a registered thumbnail handler. The repo ships one, so
    /// the test needs no fixtures and exercises exactly the Shell path the panel
    /// uses. This is where a bad HRESULT or a mis-sized DIB shows up, and with
    /// panic = "abort" in the release profile it would take the whole app with
    /// it -- so it is worth a test that calls the real thing.
    #[test]
    fn shell_thumbnail_returns_a_png_for_a_real_image() {
        let icon = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("Umbra-icon.png");
        let got = shell_thumbnail(&icon.to_string_lossy(), 128);
        assert!(got.is_some(), "the Shell produced no thumbnail for a PNG");
        let (png, w, h) = got.unwrap();
        assert!(w > 0 && h > 0, "degenerate dimensions {w}x{h}");
        assert!(!png.is_empty(), "empty png");
        assert_eq!(
            &png[1..4],
            b"PNG",
            "not a PNG: {:?}",
            &png[1..4.min(png.len())]
        );
    }

    #[test]
    fn what_the_shell_actually_gives_for_media() {
        // Diagnostic: the panel shows whatever the Shell returns, so it matters
        // what that is for a video. Finds a real one and prints the result.
        let media = ["mp4", "mkv", "avi", "mov", "webm", "mp3", "wav"];
        let mut found = None;
        for root in ["C:\\", "D:\\"] {
            let root = Path::new(root);
            if !root.is_dir() {
                continue;
            }
            for dir in walkdir::WalkDir::new(root)
                .max_depth(4)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
            {
                let ext = dir
                    .path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if media.contains(&ext.as_str()) {
                    found = Some(dir.path().to_path_buf());
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        let Some(path) = found else {
            println!("pv: no media file on this machine to test with");
            return;
        };
        let p = path.to_string_lossy().to_string();
        println!("pv: media sample {}", p);
        let kind = classify(&extension_of(&p));
        println!("pv: classified as {kind}, wants thumbnail {}", wants_thumbnail(kind));
        match shell_thumbnail(&p, 320) {
            Some((png, w, h)) => println!("pv: thumbnail {w}x{h}, {} png bytes", png.len()),
            None => println!("pv: NO THUMBNAIL"),
        }
        let pv = build_preview(&p, 320);
        println!("pv: Preview kind={} thumb={} text={}", pv.kind, pv.thumb.is_some(), pv.text.is_some());
        assert!(matches!(
            pv.kind.as_str(),
            "video" | "audio" | "other" | "document"
        ));
    }

    #[test]
    fn a_missing_file_produces_nothing_rather_than_panicking() {
        // A directory is deliberately not asserted here: folders do have a Shell
        // thumbnail handler, and whether one is registered is the machine's
        // business. The frontend refuses them by kind before asking.
        assert!(shell_thumbnail("C:\\nope\\nope.png", 128).is_none());
        // An empty path is not something the app can produce; all that matters is
        // that the Shell answering oddly does not take the process with it.
        let _ = shell_thumbnail("", 128);
    }

    #[test]
    fn build_preview_is_catchable_rather_than_fatal() {
        // The release profile unwinds so this wrapper is real; with abort it would
        // be decoration.
        let caught = std::panic::catch_unwind(|| {
            build_preview("C:\\nope\\nope.txt", 128);
        });
        assert!(caught.is_ok(), "a missing file must not unwind anything");
    }

    #[test]
    fn a_locked_cache_survives_a_poisoned_lock() {
        // A panic anywhere inside the worker would leave the mutex poisoned; the
        // next preview must still work rather than panic again on unwrap.
        let mut c = ThumbCache::with_budget(4096);
        c.insert("k".into(), (vec![1, 2, 3], 1, 1));
        assert_eq!(c.bytes, 3);
        assert_eq!(c.get("k").map(|v| v.1), Some(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1251};
    use std::io::Write;

    #[test]
    fn classifies_the_kinds_the_panel_draws_differently() {
        assert_eq!(classify("png"), "image");
        assert_eq!(classify("pdf"), "document");
        assert_eq!(classify("mp4"), "video");
        assert_eq!(classify("mkv"), "video");
        assert_eq!(classify("webm"), "video");
        assert_eq!(classify("mp3"), "audio");
        assert_eq!(classify("flac"), "audio");
        assert_eq!(classify("rs"), "text");
        assert_eq!(classify("csv"), "text");
        assert_eq!(classify("xyz"), "other");
        assert_eq!(extension_of("C:\\a\\B.PNG"), "png");
        assert_eq!(extension_of("C:\\a\\noext"), "");
    }

    #[test]
    fn text_kinds_want_no_thumbnail_and_others_do() {
        assert!(!wants_thumbnail("text"));
        assert!(!wants_thumbnail("folder"));
        assert!(wants_thumbnail("image"));
        assert!(wants_thumbnail("document"));
        assert!(!wants_thumbnail("video"));
        assert!(!wants_thumbnail("audio"));
        // A handler can exist for anything we do not recognise.
        assert!(wants_thumbnail("other"));
    }

    #[test]
    fn urls_are_detected_before_the_file_system_is_touched() {
        assert!(is_url("http://example.com"));
        assert!(is_url("HTTPS://example.com"));
        assert!(is_url("  https://example.com/a b"));
        assert!(!is_url("C:\\Users\\x\\http.txt"));
        assert!(!is_url("https:"));
    }

    #[test]
    fn a_cyrillic_path_does_not_panic_url_detection() {
        // The eighth byte of "D:\\Рабочий" is the middle of a two-byte character.
        // Slicing by byte index panicked on this, and is_url ran for every path,
        // so any folder name in the user's own language killed the preview.
        for path in [
            "D:\\Рабочий стол\\фото.png",
            "D:\\Рабочий стол\\notes.txt",
            "C:\\Users\\Иван\\Downloads\\a.pdf",
        ] {
            assert!(!is_url(path), "{path} is a local path");
            assert_eq!(extension_of(path).len(), 3, "the extension still reads");
            // Classified from the extension, and the whole thing survives.
            let kind = build_preview(path, 64).kind;
            assert!(matches!(kind.as_str(), "image" | "text" | "document"), "{kind}");
        }
        for path in ["https://пример.рф/страница", "http://пример.рф"] {
            assert!(is_url(path), "{path} is a URL");
            assert_eq!(build_preview(path, 64).kind, "url");
        }
        assert_eq!(build_preview("C:\\x\\photo.png", 64).kind, "image");
    }

    #[test]
    fn a_bom_beats_every_other_guess() {
        assert_eq!(
            detect_encoding(&[0xEF, 0xBB, 0xBF, b'x']),
            encoding_rs::UTF_8
        );
        assert_eq!(detect_encoding(&[0xFF, 0xFE, b'a', 0]), UTF_16LE);
        assert_eq!(detect_encoding(&[0xFE, 0xFF, 0, b'a']), UTF_16BE);
    }

    #[test]
    fn plain_ascii_and_utf8_are_recognised_without_a_bom() {
        assert_eq!(detect_encoding(b"hello world"), encoding_rs::UTF_8);
        assert_eq!(
            detect_encoding("Привет мир, как дела".as_bytes()),
            encoding_rs::UTF_8
        );
        assert_eq!(detect_encoding(b""), encoding_rs::UTF_8);
    }

    #[test]
    fn bomless_utf16_is_found_by_its_null_pattern() {
        let le: Vec<u8> = "hello there".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(detect_encoding(&le), UTF_16LE);
        let be: Vec<u8> = "hello there".encode_utf16().flat_map(u16::to_be_bytes).collect();
        assert_eq!(detect_encoding(&be), UTF_16BE);
    }

    #[test]
    fn cyrillic_without_a_bom_lands_on_windows_1251() {
        // Russian text in windows-1251: not valid UTF-8, and mostly high bytes.
        let mut cyr = Vec::new();
        for ch in "Привет мир, второй тестовый файл".chars() {
            // windows-1251 puts А-Я at 0xC0-0xFF and а-я at 0xE0-0xFF; the
            // uppercase Cyrillic block is contiguous there.
            let code = ch as u32;
            if (0x410..=0x42F).contains(&code) {
                cyr.push((0xC0 + (code - 0x410)) as u8);
            } else if (0x430..=0x44F).contains(&code) {
                cyr.push((0xE0 + (code - 0x430)) as u8);
            } else if ch == ' ' {
                cyr.push(b' ');
            } else if ch == ',' {
                cyr.push(b',');
            }
        }
        assert!(std::str::from_utf8(&cyr).is_err(), "must not be valid UTF-8");
        assert_eq!(detect_encoding(&cyr), WINDOWS_1251);
        let (decoded, errors) = WINDOWS_1251.decode_without_bom_handling(&cyr);
        assert!(!errors);
        assert!(decoded.starts_with("Привет"), "got {decoded:?}");

        // Windows-1251 is the legacy fallback, so an unaccented Latin file reads
        // fine through it too — which is why it is the fallback and not 1252.
        let latin = b"resume: le cafe est ferme, resume a 9h\n".to_vec();
        assert_eq!(detect_encoding(&latin), encoding_rs::UTF_8);
        let (decoded, errors) = WINDOWS_1251.decode_without_bom_handling(&latin);
        assert!(!errors);
        assert!(decoded.starts_with("resume: le cafe"));
    }

    fn write_temp(name: &str, bytes: &[u8]) -> String {
        let path = std::env::temp_dir().join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn reads_plain_utf8_text() {
        let path = write_temp("umbra-prev-utf8.txt", "first\nsecond\nthird\n".as_bytes());
        let pv = build_preview(&path, 128);
        assert_eq!(pv.kind, "text");
        assert_eq!(pv.text.as_deref(), Some("first\nsecond\nthird"));
        assert_eq!(pv.encoding.as_deref(), Some("UTF-8"));
        assert!(!pv.truncated);
        assert_eq!(pv.size_bytes, Some(19));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn windows_1251_without_a_bom_stays_readable() {
        // "Привет" in windows-1251. Read as UTF-8 this would be mojibake.
        let cp = [b'\xCF', b'\xF0', b'\xE8', b'\xE2', b'\xE5', b'\xF2'];
        let path = write_temp("umbra-prev-cp1251.txt", &cp);
        let pv = build_preview(&path, 128);
        let text = pv.text.expect("text");
        assert!(text.starts_with("Привет"), "got {text:?}");
        assert_eq!(pv.encoding.as_deref(), Some("windows-1251"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_utf8_bom_is_stripped_from_the_text() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("bom".as_bytes());
        let path = write_temp("umbra-prev-bom.txt", &bytes);
        let pv = build_preview(&path, 128);
        assert_eq!(pv.encoding.as_deref(), Some("UTF-8"));
        assert_eq!(pv.text.as_deref(), Some("bom"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn long_lines_are_clipped_and_long_files_marked_truncated() {
        let line = "x".repeat(TEXT_MAX_LINE_CHARS + 50);
        let mut body = line;
        for _ in 0..TEXT_MAX_LINES + 5 {
            body.push('\n');
            body.push('y');
        }
        let path = write_temp("umbra-prev-long.txt", body.as_bytes());
        let pv = build_preview(&path, 128);
        let text = pv.text.expect("text");
        assert!(text.lines().count() <= TEXT_MAX_LINES, "too many lines");
        assert_eq!(
            text.lines().next().unwrap().chars().count(),
            TEXT_MAX_LINE_CHARS,
            "line not clipped"
        );
        assert!(pv.truncated);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_files_still_get_a_kind() {
        let pv = build_preview("C:\\definitely\\not\\here.png", 128);
        assert_eq!(pv.kind, "image");
        assert_eq!(pv.size_bytes, None);
        assert!(pv.text.is_none());
    }

    #[test]
    fn directories_short_circuit_before_metadata() {
        let dir = std::env::temp_dir();
        let pv = build_preview(&dir.to_string_lossy(), 128);
        assert_eq!(pv.kind, "folder");
        assert!(pv.is_dir);
        assert!(pv.thumb.is_none());
        assert!(pv.text.is_none());
    }

    #[test]
    fn urls_get_no_filesystem_access() {
        let pv = build_preview("https://example.com/a.pdf", 128);
        assert_eq!(pv.kind, "url");
        assert!(pv.thumb.is_none());
    }

    #[test]
    fn the_cache_evicts_by_bytes_not_by_count() {
        let mut c = ThumbCache::with_budget(10 * 1024);
        let kb = vec![0u8; 1024];
        for i in 0..5 {
            c.insert(format!("k{i}"), (kb.clone(), 1, 1));
        }
        // Five 1 KiB items fit in a 10 KiB budget, and the counter agrees.
        assert_eq!(c.map.len(), 5);
        assert_eq!(c.bytes, 5120);

        // A 6 KiB thumbnail must push the oldest ones out to make room, and the
        // byte counter must still match what is actually stored.
        c.insert("big".into(), (vec![0u8; 6144], 6, 6));
        assert!(c.map.contains_key("big"));
        assert_eq!(c.bytes, c.map.values().map(|v| v.0.len()).sum::<usize>());
        assert!(c.bytes <= 10 * 1024);
        assert_eq!(c.map.len(), 5, "the 6 KiB one replaced two 1 KiB ones");
        assert_eq!(c.get("big").map(|v| v.1), Some(6));

        // Replacing an existing key must not double-count it.
        let before = c.bytes;
        c.insert("big".into(), (vec![0u8; 6144], 6, 6));
        assert_eq!(c.bytes, before);

        // An item bigger than the whole budget is refused rather than
        // evicting everything to make room for it.
        c.insert("huge".into(), (vec![0u8; 10 * 1024 + 1], 1, 1));
        assert!(!c.map.contains_key("huge"));
        assert_eq!(c.bytes, c.map.values().map(|v| v.0.len()).sum::<usize>());

        // Cache keys must not collide across sizes for the same path.
        assert_ne!(
            ThumbCache::key("C:\\a.png", 256),
            ThumbCache::key("C:\\a.png", 512)
        );
    }
}