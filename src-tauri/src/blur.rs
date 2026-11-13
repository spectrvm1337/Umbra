//! Background blur under the cards (Appearance → Blur), drawn by Haze (github.com/spectrvm1337/Haze-blur).
//! The window is a transparent rectangle with rounded cards in it, and Windows 10 blurs whole windows
//! only; Haze keeps one blurred sprite per card, clipped to the card's rounded or squircle corners.
//! The page measures the cards (blur.js) and sends them here as physical px relative to the window.
//!
//! Haze updates the sprites in place and skips the ones that did not change, and calls from any
//! thread are merged into one round on the window's thread. The blur this replaced rebuilt every
//! sprite and clip on the UI thread for each change, i.e. every frame of a scroll or a glide, and
//! the page stuttered behind it.
use crate::sync::LockExt;
use haze::{Corner, Easing, Haze, Region, Style, Transition};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// A card: x, y, width, height, corner radius, its opacity on the page (0..1) so its blur fades in
/// and out with it, and its corner curve as the K of CSS `superellipse(K)` (1 round, 2 squircle).
pub type Shape = [f64; 7];

/// The cards last sent, for a blur attached after them (turned on in Settings).
static SHAPES: Mutex<Vec<Region>> = Mutex::new(Vec::new());
/// The blur while it is on. A handle: cheap to clone, usable from any thread.
static HAZE: Mutex<Option<Haze>> = Mutex::new(None);

/// The page's one easing curve, --ease-out-apple in styles.css: the window's fade runs on it, and
/// the blur fades with it.
const PAGE_EASE: Easing = Easing::CubicBezier([0.32, 0.72, 0.0, 1.0]);

fn style(strength: u32) -> Style {
    // No tint: the cards draw their own colour over the blur.
    Style::default().strength(strength as f32).tint(0.0)
}

fn haze() -> Option<Haze> {
    HAZE.lock_or_recover().clone()
}

/// Applies the saved setting; called at start-up and after every theme save.
pub fn apply(app: &AppHandle) {
    let theme = crate::config::get_theme();
    let (on, strength) = (theme.blur_on, theme.blur_strength);
    let handle = app.clone();
    // Attaching has to happen on the thread that owns the window.
    let _ = app.run_on_main_thread(move || {
        let mut slot = HAZE.lock_or_recover();
        if !on {
            if let Some(h) = slot.take() {
                h.detach();
            }
            return;
        }
        if let Some(h) = slot.as_ref().filter(|h| h.is_attached()) {
            h.set_style(style(strength));
            return;
        }
        let Some(hwnd) = handle.get_webview_window("main").and_then(|w| w.hwnd().ok()) else { return };
        match Haze::attach_hwnd(hwnd.0, style(strength)) {
            Ok(h) => {
                // The page sends physical px.
                h.set_scale(Some(1.0));
                h.set_regions(&SHAPES.lock_or_recover());
                *slot = Some(h);
            }
            Err(e) => eprintln!("blur: {e}"),
        }
    });
}

fn region([x, y, w, h, r, opacity, k]: Shape) -> Region {
    let corner = if (k - 1.0).abs() > 0.01 { Corner::Superellipse(k as f32) } else { Corner::Round };
    Region::new(x as f32, y as f32, w as f32, h as f32).radius(r as f32).corner(corner).opacity(opacity as f32)
}

#[tauri::command]
pub fn set_blur_shapes(shapes: Vec<Shape>) {
    let regions: Vec<Region> = shapes
        .into_iter()
        .filter(|s| s.iter().all(|v| v.is_finite()) && s[2] > 0.0 && s[3] > 0.0)
        .take(256)
        .map(region)
        .collect();
    if let Some(h) = haze() {
        h.set_regions(&regions);
    }
    *SHAPES.lock_or_recover() = regions;
}

/// Fades the blur with the page's own show / hide fade (blur.js), which otherwise leaves the blur
/// standing at full strength while the cards over it fade away.
#[tauri::command]
pub fn set_blur_fade(visible: bool, ms: f64) {
    if let Some(h) = haze() {
        let ms = if ms.is_finite() { ms.clamp(0.0, 5000.0) } else { 0.0 };
        h.fade(visible, Transition::new(Duration::from_secs_f64(ms / 1000.0)).easing(PAGE_EASE));
    }
}

#[cfg(test)]
mod tests {
    use super::region;
    use haze::Corner;
    #[test]
    fn a_card_becomes_a_region_with_its_corner_curve() {
        let round = region([10.0, 20.0, 300.0, 48.0, 12.0, 0.5, 1.0]);
        assert_eq!((round.x, round.y, round.width, round.height), (10.0, 20.0, 300.0, 48.0));
        assert_eq!(round.radius, Some(12.0));
        assert_eq!(round.corner, Some(Corner::Round));
        assert_eq!(round.opacity, 0.5);
        assert_eq!(region([0.0, 0.0, 1.0, 1.0, 4.0, 1.0, 2.0]).corner, Some(Corner::Superellipse(2.0)));
    }
}
