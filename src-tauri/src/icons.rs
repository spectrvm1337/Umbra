use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::{LazyLock, Mutex};
const ICON_SIZE: i32 = 64;
const MAX_ICON_CACHE_SIZE: usize = 500;
static ICON_CACHE: LazyLock<Mutex<IconCache>> =
    LazyLock::new(|| Mutex::new(IconCache::new()));
struct IconCache {
    map: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
}
impl IconCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }
    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        if let Some(value) = self.map.get(key) {

            self.order.retain(|k| k != key);
            self.order.push_front(key.to_string());
            Some(value.clone())
        } else {
            None
        }
    }
    fn insert(&mut self, key: String, value: Vec<u8>) {

        if self.map.contains_key(&key) {
            self.order.retain(|k| k != &key);
        } else if self.map.len() >= MAX_ICON_CACHE_SIZE {

            if let Some(lru) = self.order.pop_back() {
                self.map.remove(&lru);
            }
        }
        self.map.insert(key.clone(), value);
        self.order.push_front(key);
    }
}
pub fn get_icon_png_data(path: &str) -> Option<Vec<u8>> {
    let p = std::path::Path::new(path);
    let ext = p.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext != "exe" && ext != "lnk" {
        return None;
    }
    {
        let mut cache = ICON_CACHE.lock().unwrap();
        if let Some(cached) = cache.get(path) {
            return Some(cached);
        }
    }
    let result = hicon_to_png(path);
    if let Some(bytes) = &result {
        let mut cache = ICON_CACHE.lock().unwrap();
        cache.insert(path.to_string(), bytes.clone());
    }
    result
}
/// Target of a .lnk shortcut, so the icon comes from the program it opens.
#[cfg(target_os = "windows")]
fn resolve_lnk_target(path: &str) -> Option<String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    unsafe {
        // S_FALSE (already initialised on this thread) also needs the matching uninit.
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // The COM objects live only inside this closure, so they are released
        // before CoUninitialize.
        let target = (|| -> windows::core::Result<String> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.cast::<IPersistFile>()?.Load(&HSTRING::from(path), STGM_READ)?;
            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), 0)?;
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Ok(String::from_utf16_lossy(&buf[..len]))
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        target.ok().filter(|t| !t.is_empty())
    }
}
#[cfg(target_os = "windows")]
fn hicon_to_png(path: &str) -> Option<Vec<u8>> {
    let icon_path = if path.to_lowercase().ends_with(".lnk") {
        resolve_lnk_target(path).unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        SelectObject, SetBkColor, DIB_RGB_COLORS, BITMAPINFO, BITMAPINFOHEADER,
    };
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL};
    let wide: Vec<u16> = icon_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut shfi: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let result = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            0x80,
            &mut shfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || shfi.hIcon.is_null() {
        return None;
    }
    let hicon = shfi.hIcon;
    let mut bi: BITMAPINFOHEADER = unsafe { std::mem::zeroed() };
    bi.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.biWidth = ICON_SIZE;
    bi.biHeight = -ICON_SIZE;
    bi.biPlanes = 1;
    bi.biBitCount = 32;
    bi.biCompression = 0;
    let mut bitmap_info: BITMAPINFO = unsafe { std::mem::zeroed() };
    bitmap_info.bmiHeader = bi;
    let mut pixels_ptr: *mut u8 = std::ptr::null_mut();
    let hdc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
    if hdc.is_null() {
        unsafe { DestroyIcon(hicon) };
        return None;
    }
    let hbm = unsafe {
        CreateDIBSection(
            hdc,
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut pixels_ptr as *mut *mut u8 as *mut *mut c_void,
            std::ptr::null_mut(),
            0,
        )
    };
    if hbm.is_null() || pixels_ptr.is_null() {
        unsafe { DeleteDC(hdc) };
        unsafe { DestroyIcon(hicon) };
        return None;
    }
    let pixel_count = (ICON_SIZE * ICON_SIZE) as usize;
    let buf_size = pixel_count * 4;
    unsafe { std::ptr::write_bytes(pixels_ptr, 0, buf_size) };
    let old = unsafe { SelectObject(hdc, hbm) };
    unsafe { SetBkColor(hdc, 0x00000000) };
    unsafe {
        DrawIconEx(hdc, 0, 0, hicon, ICON_SIZE, ICON_SIZE, 0, std::ptr::null_mut(), DI_NORMAL);
    }
    unsafe {
        SelectObject(hdc, old);
        DeleteDC(hdc);
        DestroyIcon(hicon);
    }
    let raw = unsafe { std::slice::from_raw_parts(pixels_ptr, buf_size) };
    let raw_bytes: Vec<u8> = raw.to_vec();
    unsafe { DeleteObject(hbm); }
    let mut has_nonzero_alpha = false;
    for i in (3..buf_size).step_by(4) {
        if raw_bytes[i] != 0 {
            has_nonzero_alpha = true;
            break;
        }
    }
    let mut rgba: Vec<u8> = Vec::with_capacity(pixel_count * 4);
    for chunk in raw_bytes.chunks(4) {
        let b = chunk[0];
        let g = chunk[1];
        let r = chunk[2];
        let a = if has_nonzero_alpha { chunk[3] } else { 255 };
        rgba.push(r);
        rgba.push(g);
        rgba.push(b);
        rgba.push(a);
    }
    let mut png_data: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_data, ICON_SIZE as u32, ICON_SIZE as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        if let Ok(mut writer) = encoder.write_header() {
            let _ = writer.write_image_data(&rgba);
        }
    }
    Some(png_data)
}
#[cfg(not(target_os = "windows"))]
fn hicon_to_png(_path: &str) -> Option<Vec<u8>> {
    None
}
#[cfg(not(target_os = "windows"))]
fn resolve_lnk_target(_path: &str) -> Option<String> {
    None
}
#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    #[test]
    fn resolves_a_shortcut_to_its_target() {
        use windows::core::{Interface, HSTRING};
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
        let windir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let target = format!("{windir}\\notepad.exe");
        let lnk = std::env::temp_dir().join("umbra-test-notepad.lnk");
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                link.SetPath(&HSTRING::from(target.as_str())).unwrap();
                link.cast::<IPersistFile>().unwrap().Save(&HSTRING::from(lnk.to_string_lossy().as_ref()), true).unwrap();
            }
            if init.is_ok() {
                CoUninitialize();
            }
        }
        let resolved = resolve_lnk_target(&lnk.to_string_lossy()).unwrap();
        assert!(resolved.eq_ignore_ascii_case(&target), "{resolved} != {target}");
        assert_eq!(resolve_lnk_target("C:\\no\\such\\file.lnk"), None);
        let _ = std::fs::remove_file(&lnk);
    }
}
