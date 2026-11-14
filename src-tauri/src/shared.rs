//! Values Rust and the page both need, kept here once. The page reads them as `window.UMBRA`, set by
//! an init script before any of its own scripts run (`init_script`), so a value changed here changes
//! everywhere. The window's normal size comes from tauri.conf.json and goes the same way.

/// The app's version, from package.json (build.rs).
pub const VERSION: &str = env!("UMBRA_VERSION");
/// GitHub `owner/name`: updates come from its releases, and Settings links to it.
pub const REPO: &str = "spectrvm1337/Umbra";
pub const DEFAULT_HOTKEY: &str = "Alt+Space";
/// The top of Settings → Appearance → Blur.
pub const MAX_BLUR_STRENGTH: u32 = 40;
/// Logical width the pinned-apps dock adds to the window.
pub const DOCK_RESERVE: f64 = 168.0;
/// The interface languages, by code and by their own name. A new one also needs its strings in
/// i18n.js and the tray's labels in tray.rs.
pub const LANGUAGES: &[(&str, &str)] = &[("en", "English"), ("ru", "Русский"), ("de", "Deutsch"), ("ja", "日本語")];
/// The page's one easing curve, --ease-out-apple in styles.css: the window's slide and the blur's
/// fade run on it so they move with the page.
pub const EASE: [f32; 4] = [0.32, 0.72, 0.0, 1.0];

pub fn is_language(code: &str) -> bool {
    LANGUAGES.iter().any(|(c, _)| *c == code)
}

/// `window.UMBRA` for the page, frozen. `window_size` is the window's normal size in logical px.
pub fn init_script(window_size: (f64, f64)) -> String {
    let shared = serde_json::json!({
        "version": VERSION,
        "repo": REPO,
        "defaultHotkey": DEFAULT_HOTKEY,
        "maxBlurStrength": MAX_BLUR_STRENGTH,
        "dockReserve": DOCK_RESERVE,
        "languages": LANGUAGES,
        "windowWidth": window_size.0,
        "windowHeight": window_size.1,
    });
    format!("Object.defineProperty(window, \"UMBRA\", {{ value: Object.freeze({shared}) }});")
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_page_gets_every_shared_value() {
        let script = super::init_script((660.0, 560.0));
        for key in ["version", "repo", "defaultHotkey", "maxBlurStrength", "dockReserve", "languages", "windowWidth", "windowHeight"] {
            assert!(script.contains(&format!("\"{key}\":")), "{key}");
        }
        assert!(script.contains("[\"ru\",\"Русский\"]"));
    }
}
