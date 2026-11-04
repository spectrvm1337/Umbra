//! A coarse brightness map of the screen behind the window. The drag bar and the favourites arrow
//! sit on the wallpaper rather than on a card, so the page (contrast.js) draws each of them dark over
//! a light background and white over a dark one. Nothing of the picture is kept: one brightness byte
//! per 16×16 block.
//!
//! It is taken while the window is away (after a hide, and at start-up), on a thread of its own, and
//! handed over on the next summon. Taken on the summon itself it held the window back, and under load
//! (indexing) long enough that Windows no longer let it come to the front: it showed without focus,
//! counted as clicked away, and hid again at once.
use crate::sync::LockExt;
use base64::Engine;
use std::sync::Mutex;

static LATEST: Mutex<Option<Backdrop>> = Mutex::new(None);

/// The last map taken, for the summon that is happening now.
pub fn latest() -> Option<Backdrop> {
    LATEST.lock_or_recover().clone()
}

/// Takes a fresh map once the window has had a moment to leave the screen.
pub fn refresh_later(window: &tauri::WebviewWindow, delay_ms: u64) {
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if let Some(map) = sample(&window) {
            *LATEST.lock_or_recover() = Some(map);
        }
    });
}

/// Screen pixels per map cell on each side.
const STEP: i32 = 16;

#[derive(serde::Serialize, Clone)]
pub struct Backdrop {
    /// The monitor sampled, in physical screen px.
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    cols: i32,
    rows: i32,
    /// `cols * rows` brightness bytes (0 black … 255 white), row by row, base64.
    luma: String,
}

/// None while the window is on screen: it would be in its own picture.
fn sample(window: &tauri::WebviewWindow) -> Option<Backdrop> {
    if window.is_visible().unwrap_or(true) {
        return None;
    }
    let mon = window.current_monitor().ok()??;
    let (x, y) = (mon.position().x, mon.position().y);
    let (w, h) = (mon.size().width as i32, mon.size().height as i32);
    let (cols, rows) = (w / STEP, h / STEP);
    let bgra = unsafe { grab(x, y, w, h, cols, rows)? };
    let luma = base64::engine::general_purpose::STANDARD.encode(to_luma(&bgra));
    Some(Backdrop { x, y, w, h, cols, rows, luma })
}

/// Rec. 601 brightness of each BGRA pixel.
fn to_luma(bgra: &[u8]) -> Vec<u8> {
    bgra.chunks_exact(4)
        .map(|p| ((p[2] as u32 * 299 + p[1] as u32 * 587 + p[0] as u32 * 114) / 1000) as u8)
        .collect()
}

/// The screen rect (x, y, w, h) shrunk to cols × rows with averaging, as BGRA rows top-down.
unsafe fn grab(x: i32, y: i32, w: i32, h: i32, cols: i32, rows: i32) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::*;
    if cols <= 0 || rows <= 0 {
        return None;
    }
    let screen = GetDC(std::ptr::null_mut());
    if screen.is_null() {
        return None;
    }
    let mem = CreateCompatibleDC(screen);
    let bmp = CreateCompatibleBitmap(screen, cols, rows);
    let old = SelectObject(mem, bmp as HGDIOBJ);
    SetStretchBltMode(mem, HALFTONE);
    SetBrushOrgEx(mem, 0, 0, std::ptr::null_mut());
    StretchBlt(mem, 0, 0, cols, rows, screen, x, y, w, h, SRCCOPY);
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = cols;
    info.bmiHeader.biHeight = -rows; // top-down rows
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    let mut buf = vec![0u8; (cols * rows * 4) as usize];
    let lines = GetDIBits(mem, bmp, 0, rows as u32, buf.as_mut_ptr() as _, &mut info, DIB_RGB_COLORS);
    SelectObject(mem, old);
    DeleteObject(bmp as HGDIOBJ);
    DeleteDC(mem);
    ReleaseDC(std::ptr::null_mut(), screen);
    (lines > 0).then_some(buf)
}

#[cfg(test)]
mod tests {
    use super::to_luma;
    #[test]
    fn brightness_weighs_green_most() {
        // BGRA: black, white, pure blue, pure green.
        let px = [0, 0, 0, 0, 255, 255, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0];
        assert_eq!(to_luma(&px), vec![0, 255, 29, 149]);
    }
}
