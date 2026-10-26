//! The site icon shown next to a link typed into the search box. Fetched straight from the
//! site itself (no third-party favicon service, so a typed address is never handed to anyone
//! else), once per host, and kept for the session.
use base64::Engine;
use std::collections::HashMap;
use std::sync::Mutex;

/// An icon bigger than this is not an icon.
const MAX_ICON_BYTES: usize = 256 * 1024;
/// How much of the page is skimmed for a `<link rel="icon">`.
const MAX_PAGE_BYTES: usize = 128 * 1024;

static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// A host worth asking: a public-looking name. Local names and bare addresses are skipped, so
/// typing `192.168.0.1` or `localhost` never sends a request into the user's own network.
fn host_ok(host: &str) -> bool {
    let h = host.trim_end_matches('.');
    if h.is_empty() || !h.contains('.') || h.ends_with(".local") || h.ends_with(".internal") {
        return false;
    }
    if h.contains(':') || h.contains('@') || h.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    // A dotted number is an address, not a site.
    !h.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// The image type from the first bytes; `None` for anything that is not an image.
fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if b.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The `href` of the best icon `<link>` in a page's markup: a plain `icon` or `shortcut icon`,
/// not an `apple-touch-icon` or a mask.
fn find_icon_href(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let end = lower[start..].find('>').map(|e| start + e)?;
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        from = end;
        let rel = attr(tag, tag_lower, "rel").unwrap_or_default().to_ascii_lowercase();
        let is_icon = rel.split_whitespace().any(|r| r == "icon");
        if !is_icon || rel.contains("mask") {
            continue;
        }
        if let Some(href) = attr(tag, tag_lower, "href") {
            if !href.is_empty() {
                return Some(href);
            }
        }
    }
    None
}

/// The value of `name="…"` (or `'…'`) inside one tag.
fn attr(tag: &str, tag_lower: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = tag_lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        let before_ok = at == 0 || tag_lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let rest = rest[1..].trim_start();
        let quote = rest.chars().next()?;
        if quote == '"' || quote == '\'' {
            let body = &rest[1..];
            return body.find(quote).map(|e| body[..e].to_string());
        }
        let e = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
        return Some(rest[..e].to_string());
    }
    None
}

/// Makes a link found on the page at `base` (`https://host/…`) absolute.
fn resolve(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with("https://") || href.starts_with("http://") {
        return Some(href.to_string());
    }
    if href.starts_with("data:") {
        return None;
    }
    let (scheme, rest) = base.split_once("://")?;
    let authority = rest.split('/').next()?;
    if let Some(r) = href.strip_prefix("//") {
        return Some(format!("{scheme}://{r}"));
    }
    if href.starts_with('/') {
        return Some(format!("{scheme}://{authority}{href}"));
    }
    Some(format!("{scheme}://{authority}/{href}"))
}

#[cfg(target_os = "windows")]
fn download(url: &str, max: usize) -> Option<Vec<u8>> {
    let resp = crate::winhttp::Response::get(url, "Accept: */*\r\n").ok()?;
    if resp.status().ok()? != 200 {
        return None;
    }
    resp.read_limited(max).ok()
}

#[cfg(target_os = "windows")]
fn fetch_icon_bytes(base: &str) -> Option<Vec<u8>> {
    let direct = download(&format!("{base}/favicon.ico"), MAX_ICON_BYTES);
    if let Some(bytes) = direct.filter(|b| sniff_mime(b).is_some()) {
        return Some(bytes);
    }
    // No /favicon.ico: ask the page which icon it uses.
    let page = download(&format!("{base}/"), MAX_PAGE_BYTES)?;
    let href = find_icon_href(&String::from_utf8_lossy(&page))?;
    let url = resolve(base, &href)?;
    // The page picks this address, not the user: it gets the same check as a
    // typed one, so a site cannot point Umbra at 192.168.0.1 or localhost.
    let host = crate::winhttp::parse_url(&url).ok()?.host.to_ascii_lowercase();
    if !host_ok(&host) {
        return None;
    }
    download(&url, MAX_ICON_BYTES).filter(|b| sniff_mime(b).is_some())
}

#[cfg(not(target_os = "windows"))]
fn fetch_icon_bytes(_base: &str) -> Option<Vec<u8>> {
    None
}

/// The icon of the site behind `url` as a data URI, or `None` when there is none.
#[tauri::command]
pub async fn fetch_favicon(url: String) -> Option<String> {
    #[cfg(target_os = "windows")]
    let parsed = crate::winhttp::parse_url(&url).ok()?;
    #[cfg(not(target_os = "windows"))]
    return None;
    #[cfg(target_os = "windows")]
    {
        let host = parsed.host.to_ascii_lowercase();
        if !host_ok(&host) {
            return None;
        }
        let key = format!("{}://{}:{}", if parsed.secure { "https" } else { "http" }, host, parsed.port);
        if let Some(hit) = CACHE.lock().ok()?.as_ref().and_then(|m| m.get(&key)) {
            return hit.clone();
        }
        let base = key.clone();
        let icon = tauri::async_runtime::spawn_blocking(move || {
            let bytes = fetch_icon_bytes(&base)?;
            let mime = sniff_mime(&bytes)?;
            Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
        })
        .await
        .ok()
        .flatten();
        if let Ok(mut cache) = CACHE.lock() {
            cache.get_or_insert_with(HashMap::new).insert(key, icon.clone());
        }
        icon
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_looking_hosts() {
        assert!(host_ok("github.com"));
        assert!(host_ok("www.пример.рф"));
        assert!(!host_ok("localhost"));
        assert!(!host_ok("192.168.0.1"));
        assert!(!host_ok("printer.local"));
        assert!(!host_ok(""));
    }

    #[test]
    fn sniffs_images_by_their_first_bytes() {
        assert_eq!(sniff_mime(&[0x89, b'P', b'N', b'G', 1, 2]), Some("image/png"));
        assert_eq!(sniff_mime(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(sniff_mime(b"<!DOCTYPE html>"), None);
    }

    #[test]
    fn finds_the_icon_link() {
        let html = r#"<head><link rel="apple-touch-icon" href="/a.png"><LINK REL='shortcut icon' HREF='/f.png?v=2'></head>"#;
        assert_eq!(find_icon_href(html).as_deref(), Some("/f.png?v=2"));
        assert_eq!(find_icon_href("<link rel=icon href=x.ico>").as_deref(), Some("x.ico"));
        assert_eq!(find_icon_href("<link rel=\"mask-icon\" href=\"m.svg\">"), None);
        assert_eq!(find_icon_href("<p>no icon</p>"), None);
    }

    #[test]
    fn resolves_icon_links() {
        let base = "https://example.com:8080";
        assert_eq!(resolve(base, "/f.ico").as_deref(), Some("https://example.com:8080/f.ico"));
        assert_eq!(resolve(base, "f.ico").as_deref(), Some("https://example.com:8080/f.ico"));
        assert_eq!(resolve(base, "//cdn.x.com/f.ico").as_deref(), Some("https://cdn.x.com/f.ico"));
        assert_eq!(resolve(base, "https://a.b/f.ico").as_deref(), Some("https://a.b/f.ico"));
        assert_eq!(resolve(base, "data:image/png;base64,AA"), None);
    }
}
