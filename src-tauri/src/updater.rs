//! "Check for updates": reads the newest GitHub release, compares it with the
//! running build and can fetch the installer in the background.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
const REPO_OWNER: &str = "spectrvm1337";
const REPO_NAME: &str = "Umbra";
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/spectrvm1337/Umbra/releases/latest";
#[derive(Clone, Debug, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
    pub notes: String,
    pub html_url: String,
    pub published_at: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: u64,
}
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
#[derive(Deserialize)]
struct Release {
    tag_name: Option<String>,
    body: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    /// `sha256:<hex>` on releases uploaded since mid-2025.
    #[serde(default)]
    digest: Option<String>,
}
/// Picks the installer we can actually run: prefer the NSIS setup, then the
/// portable build (named `_x64_portable` up to 0.1.5, `_x64-portable` since),
/// then any .exe.
fn pick_asset(assets: &[Asset]) -> Option<&Asset> {
    assets
        .iter()
        .find(|a| a.name.ends_with("_x64-setup.exe"))
        .or_else(|| {
            assets.iter().find(|a| {
                a.name.ends_with("_x64-portable.exe") || a.name.ends_with("_x64_portable.exe")
            })
        })
        .or_else(|| assets.iter().find(|a| a.name.ends_with(".exe")))
}
/// The lowercase hex of a `sha256:…` digest, or None for any other algorithm.
fn sha256_hex(digest: &str) -> Option<String> {
    let hex = digest.strip_prefix("sha256:")?;
    if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}
/// What the last update check said the installer should look like, so the
/// download is verified against GitHub's numbers, not the frontend's.
struct Expected {
    url: String,
    size: u64,
    sha256: Option<String>,
}
static EXPECTED: OnceLock<Mutex<Option<Expected>>> = OnceLock::new();
fn expected_slot() -> &'static Mutex<Option<Expected>> {
    EXPECTED.get_or_init(|| Mutex::new(None))
}
fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}
/// Keeps remote release notes from exploding into a huge one-line string.
fn condense_notes(body: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in decode_entities(body).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let line = line.trim_start_matches(['-', '*', '•']).trim();
        if out.len() >= 8 {
            break;
        }
        out.push(line.chars().take(160).collect());
    }
    out.join("\n")
}
/// (major, minor, patch, pre_release) — `v0.1.2-beta` -> (0, 1, 2, Some("beta")).
fn parse_version(raw: &str) -> (u64, u64, u64, Option<String>) {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let (core, suffix) = match trimmed.split_once(['-', '+']) {
        Some((core, suffix)) => (core, Some(suffix.to_ascii_lowercase())),
        None => (trimmed, None),
    };
    let mut parts = core.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        suffix,
    )
}
/// Strictly greater, semver-style: on equal version numbers a pre-release
/// (`0.1.3-beta`) ranks *below* the final release (`0.1.3`).
fn is_newer(latest: &str, current: &str) -> bool {
    let (lm, ln, lp, ls) = parse_version(latest);
    let (cm, cn, cp, cs) = parse_version(current);
    match (lm, ln, lp).cmp(&(cm, cn, cp)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => match (&ls, &cs) {
            (None, Some(_)) => true,
            (Some(_), None) => false,
            (Some(a), Some(b)) => a > b,
            (None, None) => false,
        },
    }
}
pub fn check() -> Result<UpdateInfo, String> {
    let current = current_version().to_string();
    #[cfg(target_os = "windows")]
    {
        let headers = format!("Accept: application/vnd.github+json\r\nUser-Agent: Umbra\r\n");
        let response = crate::winhttp::Response::get(LATEST_RELEASE_API, &headers)
            .map_err(|e| format!("network error: {e}"))?;
        let status = response.status()?;
        let body = response.read_to_vec()?;
        if status != 200 {
            return Err(format!(
                "GitHub API returned {}{}",
                status,
                if status == 403 {
                    " (rate limit exceeded — try again later)"
                } else {
                    ""
                }
            ));
        }
        let release: Release = serde_json::from_slice(&body)
            .map_err(|e| format!("could not read release info: {e}"))?;
        let latest = release.tag_name.unwrap_or_default();
        let asset = pick_asset(&release.assets);
        *expected_slot().lock().unwrap() = asset.map(|a| Expected {
            url: a.browser_download_url.clone(),
            size: a.size,
            sha256: a.digest.as_deref().and_then(sha256_hex),
        });
        Ok(UpdateInfo {
            update_available: !latest.is_empty() && is_newer(&latest, &current),
            latest,
            notes: condense_notes(&release.body.unwrap_or_default()),
            html_url: release.html_url.unwrap_or_else(|| {
                format!("https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/latest")
            }),
            published_at: release.published_at.unwrap_or_default(),
            asset_name: asset.map(|a| a.name.clone()),
            asset_url: asset.map(|a| a.browser_download_url.clone()),
            asset_size: asset.map(|a| a.size).unwrap_or(0),
            current,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("updates are only supported on Windows".to_string())
    }
}
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub pct: u8,
}
#[derive(Clone, Serialize)]
pub struct Downloaded {
    pub path: String,
    pub file_name: String,
    pub size: u64,
}
static READY: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
fn ready_slot() -> &'static Mutex<Option<PathBuf>> {
    READY.get_or_init(|| Mutex::new(None))
}
/// Strips anything that could escape the download directory.
pub(crate) fn safe_file_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let cleaned = cleaned.trim_start_matches('.').to_string();
    if cleaned.is_empty() || !cleaned.to_ascii_lowercase().ends_with(".exe") {
        None
    } else {
        Some(cleaned)
    }
}
/// Host of an `https://…` URL, without pulling in the HTTP client.
fn url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = match rest.find(['/', '?', '#']) {
        Some(i) => &rest[..i],
        None => rest,
    };
    // Credentials are not used by the updater, but strip them defensively.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}
pub(crate) fn is_trusted_host(url: &str) -> bool {
    match url_host(url) {
        Some(host) => {
            host == "github.com"
                || host.ends_with(".github.com")
                || host == "githubusercontent.com"
                || host.ends_with(".githubusercontent.com")
        }
        None => false,
    }
}
fn download_dir() -> PathBuf {
    std::env::temp_dir().join("Umbra")
}
#[cfg(target_os = "windows")]
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
/// Rejects a truncated or corrupted installer before it can be launched.
#[cfg(target_os = "windows")]
fn verify_download(
    path: &std::path::Path,
    size: u64,
    expected_size: u64,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    if size == 0 {
        return Err("downloaded file was empty".to_string());
    }
    if expected_size > 0 && size != expected_size {
        return Err(format!(
            "download was cut off ({size} of {expected_size} bytes)"
        ));
    }
    if let Some(want) = expected_sha256 {
        if sha256_file(path)? != want {
            return Err("downloaded file is corrupted (checksum mismatch)".to_string());
        }
    }
    Ok(())
}
/// Spawns the transfer on its own thread; progress arrives as events.
pub fn start_download(app: tauri::AppHandle, url: String, file_name: String, total: u64) {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &url, &file_name, total);
        let _ = tauri::Emitter::emit(
            &app,
            "update-error",
            "updates are only supported on Windows",
        );
    }
    #[cfg(target_os = "windows")]
    {
        *ready_slot().lock().unwrap() = None;
        let (total, expected_sha256) = match expected_slot().lock().unwrap().as_ref() {
            Some(e) if e.url == url => (if e.size > 0 { e.size } else { total }, e.sha256.clone()),
            _ => (total, None),
        };
        std::thread::spawn(move || {
        let emit = |downloaded: u64, total: u64| {
            let pct = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as u8
            } else {
                0
            };
            let _ = tauri::Emitter::emit(
                &app,
                "update-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    pct,
                },
            );
        };
        emit(0, total);
        let result = (|| -> Result<Downloaded, String> {
            if !is_trusted_host(&url) {
                return Err("refusing to download from an untrusted host".to_string());
            }
            let file_name = safe_file_name(&file_name)
                .ok_or_else(|| "unusable asset name".to_string())?;
            let dest = download_dir().join(&file_name);
            let headers = "User-Agent: Umbra\r\nAccept: application/octet-stream\r\n";
            let response = crate::winhttp::Response::get(&url, &headers)
                .map_err(|e| format!("network error: {e}"))?;
            let status = response.status()?;
            if status != 200 {
                return Err(format!("download failed with HTTP {status}"));
            }
            let mut last_emit = std::time::Instant::now();
            let size = response.write_to_file(&dest, total, |downloaded, total| {
                if last_emit.elapsed().as_millis() >= 120 || downloaded == total {
                    emit(downloaded, total);
                    last_emit = std::time::Instant::now();
                }
            })?;
            if let Err(err) = verify_download(&dest, size, total, expected_sha256.as_deref()) {
                let _ = std::fs::remove_file(&dest);
                return Err(err);
            }
            *ready_slot().lock().unwrap() = Some(dest.clone());
            Ok(Downloaded {
                path: dest.to_string_lossy().to_string(),
                file_name,
                size,
            })
        })();
        match result {
            Ok(done) => {
                let _ = tauri::Emitter::emit(&app, "update-downloaded", done);
            }
            Err(err) => {
                *ready_slot().lock().unwrap() = None;
                let _ = tauri::Emitter::emit(&app, "update-error", err);
            }
        }
        });
    }
}
/// Runs the downloaded installer. The path is never taken from the frontend —
/// only the file we fetched ourselves is ever launched.
pub fn install(app: tauri::AppHandle) -> Result<(), String> {
    let path = ready_slot().lock().unwrap().clone();
    let Some(path) = path else {
        return Err("nothing has been downloaded yet".to_string());
    };
    if !path.is_file() {
        *ready_slot().lock().unwrap() = None;
        return Err("the downloaded installer is gone".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        // The installer cannot replace umbra.exe while we are still holding
        // it, so hand the launch to a detached cmd and quit. `ping` is the
        // delay because `timeout` refuses to run without a console.
        // The path goes in through an environment variable and the command
        // line is passed raw: std would escape the quotes as \" (which cmd
        // does not understand), and a path pasted into the line would have
        // its %…% and & interpreted by cmd.
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .env("UMBRA_INSTALLER", &path)
            .raw_arg("/D /C ping -n 3 127.0.0.1 >NUL & start \"\" \"%UMBRA_INSTALLER%\"")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("could not start the installer: {e}"))?;
        exit_soon(app);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        open::that_detached(&path).map_err(|e| e.to_string())?;
        exit_soon(app);
        Ok(())
    }
}
/// Quits on a short delay so the detached launcher is running before the
/// executable is released.
fn exit_soon(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        crate::storage::flush_pending();
        app.exit(0);
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_versions_semver_style() {
        assert!(is_newer("v0.1.3", "0.1.2"));
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("v0.1.2-beta", "0.1.2"));
        assert!(!is_newer("v0.1.3", "0.1.3"));
        assert!(!is_newer("v0.1.2", "0.1.3"));
        assert!(!is_newer("", "0.1.3"));
    }
    #[test]
    fn parses_release_tags() {
        assert_eq!(parse_version("v0.1.2-beta"), (0, 1, 2, Some("beta".into())));
        assert_eq!(parse_version("1.2"), (1, 2, 0, None));
        assert_eq!(parse_version("2"), (2, 0, 0, None));
    }
    fn asset(name: &str) -> Asset {
        Asset {
            name: name.to_string(),
            browser_download_url: format!("https://github.com/x/y/releases/download/{name}"),
            size: 10,
            digest: None,
        }
    }
    #[test]
    fn accepts_both_portable_names() {
        for name in ["Umbra_0.1.7_x64-portable.exe", "Umbra_0.1.5_x64_portable.exe"] {
            let assets = vec![asset("readme.exe"), asset(name)];
            assert_eq!(pick_asset(&assets).unwrap().name, name);
        }
    }
    #[test]
    fn reads_sha256_digests() {
        let hex = "ab37d1ee46f625b6dc49dedceae58c28a0b5b1fbca798cd572bf8ff74e40a86a";
        assert_eq!(sha256_hex(&format!("sha256:{hex}")).as_deref(), Some(hex));
        assert_eq!(
            sha256_hex(&format!("sha256:{}", hex.to_uppercase())).as_deref(),
            Some(hex)
        );
        assert_eq!(sha256_hex(&format!("sha512:{hex}")), None);
        assert_eq!(sha256_hex("sha256:xyz"), None);
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_truncated_or_corrupted_downloads() {
        let path = std::env::temp_dir().join("umbra-verify-test.bin");
        std::fs::write(&path, b"abc").unwrap();
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_download(&path, 3, 3, Some(abc)).is_ok());
        assert!(verify_download(&path, 3, 0, None).is_ok());
        assert!(verify_download(&path, 3, 10, None).is_err());
        assert!(verify_download(&path, 0, 0, None).is_err());
        assert!(verify_download(&path, 3, 3, Some(&"0".repeat(64))).is_err());
        let _ = std::fs::remove_file(&path);
    }
    #[test]
    fn prefers_the_installer_over_the_portable_build() {
        let assets = vec![
            asset("Umbra_0.1.3_x64_portable.exe"),
            asset("Umbra_0.1.3_x64-setup.exe"),
        ];
        assert_eq!(
            pick_asset(&assets).unwrap().name,
            "Umbra_0.1.3_x64-setup.exe"
        );
        assert_eq!(
            pick_asset(&assets[..1]).unwrap().name,
            "Umbra_0.1.3_x64_portable.exe"
        );
        assert!(pick_asset(&[]).is_none());
    }
    #[test]
    fn only_trusted_hosts_are_downloaded() {
        assert!(is_trusted_host(
            "https://github.com/spectrvm1337/Umbra/releases/download/v1/Umbra_x64-setup.exe"
        ));
        assert!(is_trusted_host(
            "https://objects.githubusercontent.com/github-production-release-asset"
        ));
        assert!(!is_trusted_host("https://evil.example.com/Umbra.exe"));
        assert!(!is_trusted_host("https://github.com.evil.test/Umbra.exe"));
        assert!(!is_trusted_host("not-a-url"));
    }
    #[test]
    fn sanitises_remote_asset_names() {
        assert_eq!(
            safe_file_name("Umbra_0.1.3_x64-setup.exe").as_deref(),
            Some("Umbra_0.1.3_x64-setup.exe")
        );
        assert_eq!(
            safe_file_name("../../evil.exe").as_deref(),
            Some("evil.exe")
        );
        // Spaces are dropped rather than rejected.
        assert_eq!(safe_file_name("Umbra Setup.exe").as_deref(), Some("UmbraSetup.exe"));
        // Anything that is not an .exe never reaches the filesystem.
        assert_eq!(safe_file_name("notes.txt"), None);
        assert_eq!(safe_file_name(".."), None);
        assert_eq!(safe_file_name(""), None);
    }
    #[test]
    fn condenses_release_notes() {
        let notes = condense_notes("## What's new\r\n\r\n- faster search\r\n- &lt;b&gt;bold&lt;/b&gt;\r\n");
        assert_eq!(notes, "## What's new\nfaster search\n<b>bold</b>");
        assert!(condense_notes("").is_empty());
    }
}