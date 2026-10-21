//! Minimal WinHTTP client: enough to query the GitHub releases API and to
//! stream an installer to disk. Windows-only; no extra crates required.
#![cfg(target_os = "windows")]
use std::ffi::c_void;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::ptr;
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
};
const USER_AGENT: &str = concat!("Umbra/", env!("CARGO_PKG_VERSION"));
/// WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER — without the flag
/// the code comes back as a string and does not fit in the u32 buffer.
const QUERY_STATUS_CODE: u32 = 19 | 0x2000_0000;
const CHUNK: usize = 64 * 1024;
fn last_error() -> String {
    let err = std::io::Error::last_os_error();
    format!("{} (os error {})", err, err.raw_os_error().unwrap_or(0))
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
struct Handle(*mut c_void);
impl Handle {
    fn new(handle: *mut c_void) -> Result<Self, String> {
        if handle.is_null() {
            Err(last_error())
        } else {
            Ok(Handle(handle))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { WinHttpCloseHandle(self.0) };
    }
}
pub struct Url {
    pub host: String,
    pub port: u16,
    pub path: String,
    pub secure: bool,
}
pub fn parse_url(url: &str) -> Result<Url, String> {
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(format!("unsupported URL scheme: {url}"));
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port))
            if !host.is_empty()
                && !port.is_empty()
                && port.chars().all(|c| c.is_ascii_digit()) =>
        {
            let port = port
                .parse::<u16>()
                .map_err(|_| format!("bad port in URL: {url}"))?;
            (host.to_string(), port)
        }
        _ => (authority.to_string(), if secure { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err(format!("missing host in URL: {url}"));
    }
    Ok(Url {
        host,
        port,
        path: if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        },
        secure,
    })
}
pub struct Response {
    /// Kept alive for as long as the request handle lives.
    _session: Handle,
    request: Handle,
}
impl Response {
    pub fn get(url: &str, headers: &str) -> Result<Self, String> {
        let parsed = parse_url(url)?;
        unsafe {
            let agent = wide(USER_AGENT);
            let session = Handle::new(WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                ptr::null(),
                ptr::null(),
                0,
            ))?;
            let host = wide(&parsed.host);
            let connect = Handle::new(WinHttpConnect(session.0, host.as_ptr(), parsed.port, 0))?;
            let method = wide("GET");
            let path = wide(&parsed.path);
            let version = wide("HTTP/1.1");
            let request = Handle::new(WinHttpOpenRequest(
                connect.0,
                method.as_ptr(),
                path.as_ptr(),
                version.as_ptr(),
                ptr::null(),
                ptr::null(),
                if parsed.secure {
                    WINHTTP_FLAG_SECURE
                } else {
                    0
                },
            ))?;
            drop(connect);
            let header_block = wide(headers);
            // Length in UTF-16 units, not bytes, and without the trailing NUL.
            let header_len = (header_block.len() - 1) as u32;
            if WinHttpSendRequest(
                request.0,
                header_block.as_ptr(),
                header_len,
                ptr::null(),
                0,
                0,
                0,
            ) == 0
            {
                return Err(last_error());
            }
            if WinHttpReceiveResponse(request.0, ptr::null_mut()) == 0 {
                return Err(last_error());
            }
            Ok(Response {
                _session: session,
                request,
            })
        }
    }
    pub fn status(&self) -> Result<u32, String> {
        unsafe {
            let mut code: u32 = 0;
            let mut len = std::mem::size_of::<u32>() as u32;
            if WinHttpQueryHeaders(
                self.request.0,
                QUERY_STATUS_CODE,
                ptr::null(),
                &mut code as *mut u32 as *mut c_void,
                &mut len,
                ptr::null_mut(),
            ) == 0
            {
                return Err(last_error());
            }
            Ok(code)
        }
    }
    pub fn read_to_vec(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let mut buf = vec![0u8; CHUNK];
        loop {
            let mut read = 0u32;
            let ok = unsafe {
                WinHttpReadData(
                    self.request.0,
                    buf.as_mut_ptr() as *mut c_void,
                    CHUNK as u32,
                    &mut read,
                )
            };
            if ok == 0 {
                return Err(last_error());
            }
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
        }
        Ok(out)
    }
    /// Like `read_to_vec`, but stops after `max` bytes: for pages that are only skimmed.
    pub fn read_limited(&self, max: usize) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let mut buf = vec![0u8; CHUNK];
        while out.len() < max {
            let mut read = 0u32;
            let ok = unsafe {
                WinHttpReadData(
                    self.request.0,
                    buf.as_mut_ptr() as *mut c_void,
                    CHUNK as u32,
                    &mut read,
                )
            };
            if ok == 0 {
                return Err(last_error());
            }
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
        }
        out.truncate(max);
        Ok(out)
    }
    /// Streams the body into `dest`, reporting (downloaded, total) as it goes.
    /// `total` is only a hint — pass 0 when the size is unknown.
    pub fn write_to_file<F>(&self, dest: &Path, total: u64, mut progress: F) -> Result<u64, String>
    where
        F: FnMut(u64, u64),
    {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = File::create(dest).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; CHUNK];
        let mut written: u64 = 0;
        loop {
            let mut available = 0u32;
            let has_data =
                unsafe { WinHttpQueryDataAvailable(self.request.0, &mut available) };
            if has_data == 0 {
                return Err(last_error());
            }
            if available == 0 {
                break;
            }
            let want = (available as usize).min(CHUNK);
            let mut read = 0u32;
            let ok = unsafe {
                WinHttpReadData(
                    self.request.0,
                    buf.as_mut_ptr() as *mut c_void,
                    want as u32,
                    &mut read,
                )
            };
            if ok == 0 {
                return Err(last_error());
            }
            if read == 0 {
                break;
            }
            file.write_all(&buf[..read as usize]).map_err(|e| e.to_string())?;
            written += read as u64;
            progress(written, total);
        }
        file.flush().map_err(|e| e.to_string())?;
        Ok(written)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_hosts_ports_and_paths() {
        let u = parse_url("https://api.github.com/repos/a/b/releases/latest").unwrap();
        assert!(u.secure);
        assert_eq!(u.host, "api.github.com");
        assert_eq!(u.port, 443);
        assert_eq!(u.path, "/repos/a/b/releases/latest");
        let u = parse_url("http://127.0.0.1:8080").unwrap();
        assert!(!u.secure);
        assert_eq!(u.port, 8080);
        assert_eq!(u.path, "/");
        let u = parse_url("https://github.com/a/b?x=1").unwrap();
        assert_eq!(u.path, "/a/b?x=1");
        assert!(parse_url("ftp://example.com").is_err());
        assert!(parse_url("https://").is_err());
    }
}