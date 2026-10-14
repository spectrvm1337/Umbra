//! Small safe wrapper over the Win32 registry API: open a key, list its
//! subkeys, read string values, and (for the Run key) write or delete one.
#![cfg(target_os = "windows")]
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
    fn open_with(parent: HKEY, path: &str, access: REG_SAM_FLAGS) -> Option<Key> {
        let mut hkey: HKEY = std::ptr::null_mut();
        let path = wide(path);
        let res = unsafe { RegOpenKeyExW(parent, path.as_ptr(), 0, access, &mut hkey) };
        (res == 0 && !hkey.is_null()).then_some(Key(hkey))
    }
    pub fn open(parent: HKEY, path: &str) -> Option<Key> {
        Key::open_with(parent, path, KEY_READ | KEY_WOW64_64KEY)
    }
    /// Opened for reading and for setting / deleting values.
    pub fn open_writable(parent: HKEY, path: &str) -> Option<Key> {
        Key::open_with(parent, path, KEY_READ | KEY_SET_VALUE)
    }
    pub fn set_string(&self, name: &str, value: &str) -> bool {
        let name = wide(name);
        let value = wide(value);
        let res = unsafe {
            RegSetValueExW(self.0, name.as_ptr(), 0, REG_SZ, value.as_ptr() as *const u8, (value.len() * 2) as u32)
        };
        res == 0
    }
    pub fn delete_value(&self, name: &str) {
        let name = wide(name);
        unsafe { RegDeleteValueW(self.0, name.as_ptr()) };
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
    pub fn dword(&self, name: &str) -> Option<u32> {
        let name = wide(name);
        let mut kind: REG_VALUE_TYPE = 0;
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let res = unsafe {
            RegQueryValueExW(self.0, name.as_ptr(), std::ptr::null(), &mut kind, &mut value as *mut u32 as *mut u8, &mut size)
        };
        (res == 0 && kind == REG_DWORD).then_some(value)
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
            crate::indexer::expand_env_vars(&value)
        } else {
            value
        };
        (!value.is_empty()).then_some(value)
    }
}
