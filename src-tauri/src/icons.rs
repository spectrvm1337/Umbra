use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::{LazyLock, Mutex, OnceLock};

const ICON_SIZE: i32 = 64;
const MAX_ICON_CACHE_SIZE: usize = 100;

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

static PRECACHE_DONE: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();

pub fn is_precache_done() -> bool {
    PRECACHE_DONE
        .get()
        .map(|v| v.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
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

type HResult = i32;

#[cfg(target_os = "windows")]
fn resolve_lnk_target(path: &str) -> Option<String> {
    type GUID = [u32; 4];

    const CLSID_SHELL_LINK: GUID = [0x00021401, 0x00000000, 0x000000C0, 0x46000000];
    
    const IID_ISHELL_LINKW: GUID = [0x000214F9, 0x00000000, 0x000000C0, 0x46000000];
    
    const IID_IPERSIST_FILE: GUID = [0x0000010B, 0x00000000, 0x000000C0, 0x46000000];
    const CLSCTX_INPROC_SERVER: u32 = 0x1;

    extern "system" {
        fn CoInitialize(pv_reserved: *mut c_void) -> HResult;
        fn CoUninitialize();
        fn CoCreateInstance(
            rclsid: *const GUID,
            p_unk_outer: *mut c_void,
            dw_cls_context: u32,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> HResult;
    }

    let co_hr = unsafe { CoInitialize(std::ptr::null_mut()) };
    let should_uninit = co_hr >= 0;

    let release_com = |ptr: *mut c_void| {
        if !ptr.is_null() {
            unsafe {
                let vtable = *(ptr as *const *const *const c_void);
                let release_fn: extern "system" fn(*mut c_void) -> u32 =
                    std::mem::transmute(*vtable.add(2));
                release_fn(ptr);
            }
        }
    };

    let mut obj: *mut c_void = std::ptr::null_mut();
    let hr = unsafe {
        CoCreateInstance(
            &CLSID_SHELL_LINK,
            std::ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_ISHELL_LINKW,
            &mut obj,
        )
    };
    if hr < 0 || obj.is_null() {
        if should_uninit { unsafe { CoUninitialize() }; }
        return None;
    }

    let mut persist: *mut c_void = std::ptr::null_mut();
    let hr = unsafe {
        let vtable = *(obj as *const *const *const c_void);
        let qi_fn: extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HResult =
            std::mem::transmute(*vtable);
        qi_fn(obj, &IID_IPERSIST_FILE, &mut persist)
    };
    if hr < 0 || persist.is_null() {
        release_com(obj);
        if should_uninit { unsafe { CoUninitialize() }; }
        return None;
    }

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let hr = unsafe {
        let vtable = *(persist as *const *const *const c_void);
        let load_fn: extern "system" fn(*mut c_void, *const u16, u32) -> HResult =
            std::mem::transmute(*vtable.add(5));
        load_fn(persist, wide_path.as_ptr(), 0)
    };
    if hr < 0 {
        release_com(persist);
        release_com(obj);
        if should_uninit { unsafe { CoUninitialize() }; }
        return None;
    }

    let mut target_buf = [0u16; 1024];
    let hr = unsafe {
        let vtable = *(obj as *const *const *const c_void);
        let get_path_fn: extern "system" fn(*mut c_void, *mut u16, i32, *mut c_void, u32) -> HResult =
            std::mem::transmute(*vtable.add(3));
        get_path_fn(obj, target_buf.as_mut_ptr(), 1024, std::ptr::null_mut(), 0)
    };

    release_com(persist);
    release_com(obj);
    if should_uninit { unsafe { CoUninitialize() }; }

    if hr < 0 {
        return None;
    }

    let target = String::from_utf16_lossy(&target_buf);
    let target = target.trim_end_matches('\0');
    if target.is_empty() {
        return None;
    }
    Some(target.to_string())
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
