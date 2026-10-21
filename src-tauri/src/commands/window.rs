use tauri::Manager;
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}
use crate::config;
/// The window's normal size in logical px: what the resize grip last set, or
/// the tauri.conf default. Placement always aligns this size, so a window
/// stretched on the last summon never shifts where the next one lands.
static BASE_SIZE: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((660.0, 560.0));
fn base_size_physical(window: &tauri::WebviewWindow) -> (i32, i32) {
    let (w, h) = *BASE_SIZE.lock().unwrap();
    let scale = window.scale_factor().unwrap_or(1.0);
    ((w * scale).round() as i32, (h * scale).round() as i32)
}
/// Height for a window whose top edge is at `top`: the normal height, or with
/// the experimental "results to screen bottom" option, down to the bottom of
/// the work area (never shorter than normal).
fn fitted_height(base_h: i32, top: i32, work_bottom: i32, stretch: bool) -> i32 {
    if stretch {
        base_h.max(work_bottom - top)
    } else {
        base_h
    }
}
fn work_bottom(mon: &tauri::Monitor) -> i32 {
    let area = mon.work_area();
    area.position.y + area.size.height as i32
}
fn fit_height(window: &tauri::WebviewWindow, top: i32, work_bottom: i32) {
    let (w, h) = base_size_physical(window);
    let h = fitted_height(h, top, work_bottom, config::get_theme().tall_results);
    let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
}
/// Re-applies the size for wherever the window sits now: a pinned position,
/// after a manual resize, or when the setting is toggled.
pub fn refit_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let top = window.outer_position().map(|p| p.y);
        let mon = window.current_monitor().ok().flatten();
        if let (Ok(top), Some(mon)) = (top, mon) {
            fit_height(&window, top, work_bottom(&mon));
        }
    }
}
fn animate_window_to(window: tauri::WebviewWindow, target_x: i32, target_y: i32) {
    std::thread::spawn(move || {
        let start = window.outer_position().ok();
        let (from_x, from_y) = match start {
            Some(p) => (p.x, p.y),
            None => return,
        };
        if (from_x - target_x).abs() < 2 && (from_y - target_y).abs() < 2 {
            return;
        }
        const BX1: f64 = 0.16;
        const BY1: f64 = 1.0;
        const BX2: f64 = 0.3;
        const BY2: f64 = 1.0;
        fn bez(t: f64, p1: f64, p2: f64) -> f64 {

            let u = 1.0 - t;
            3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t
        }
        fn bez_deriv_x(t: f64) -> f64 {
            let u = 1.0 - t;
            3.0 * u * u * BX1 + 6.0 * u * t * (BX2 - BX1) + 3.0 * t * t * (1.0 - BX2)
        }
        let ease = |p: f64| -> f64 {
            if p <= 0.0 {
                return 0.0;
            }
            if p >= 1.0 {
                return 1.0;
            }

            let mut t = p;
            for _ in 0..8 {
                let x = bez(t, BX1, BX2) - p;
                if x.abs() < 1e-6 {
                    return bez(t, BY1, BY2);
                }
                let d = bez_deriv_x(t);
                if d.abs() < 1e-6 {
                    break;
                }
                t -= x / d;
                if t < 0.0 {
                    t = 0.0;
                }
                if t > 1.0 {
                    t = 1.0;
                }
            }
            let (mut lo, mut hi) = (0.0f64, 1.0f64);
            for _ in 0..24 {
                let mid = (lo + hi) / 2.0;
                if bez(mid, BX1, BX2) < p {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            bez((lo + hi) / 2.0, BY1, BY2)
        };
        let duration_ms = 320u64;
        let started = std::time::Instant::now();
        loop {
            let p = (started.elapsed().as_millis() as f64 / duration_ms as f64).min(1.0);
            let e = ease(p);
            let x = from_x as f64 + (target_x - from_x) as f64 * e;
            let y = from_y as f64 + (target_y - from_y) as f64 * e;
            let _ = window.set_position(tauri::PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            ));
            if p >= 1.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
    });
}
/// Logical width the pinned-apps dock adds to the window (DOCK_RESERVE in dock.js).
const DOCK_RESERVE: f64 = 168.0;
/// Width in logical px of the theme panel beside the window and whether it is on the left
/// (0 while it is closed); set by the page with `resize_main_window`.
static THEME_PANEL: std::sync::Mutex<(f64, bool)> = std::sync::Mutex::new((0.0, false));
/// What the pinned-apps dock and the theme panel add to the window's left and right, in
/// physical px (0 without them).
fn side_extents(window: &tauri::WebviewWindow) -> (i32, i32) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let px = |logical: f64| (logical * scale).round() as i32;
    let (mut left, mut right) = (0, 0);
    match config::get_theme().pins_style.as_str() {
        "left" => left += px(DOCK_RESERVE),
        "right" => right += px(DOCK_RESERVE),
        _ => {}
    }
    let (panel, panel_left) = *THEME_PANEL.lock().unwrap();
    if panel_left {
        left += px(panel);
    } else {
        right += px(panel);
    }
    (left, right)
}
/// Left edge for a window `w` wide on a monitor spanning `mx..mx+mw`, aligned (`l`, `r`
/// or centre) by its search panel, i.e. the part that isn't the `left` or `right` extra
/// (dock, theme panel). Those hang off the panel's sides, and the window is nudged back
/// only if they would leave the monitor.
fn window_left(ha: &str, mx: i32, mw: i32, w: i32, left: i32, right: i32) -> i32 {
    let panel = w - left - right;
    let panel_x = match ha {
        "l" => mx,
        "r" => mx + mw - panel,
        _ => mx + (mw - panel) / 2,
    };
    (panel_x - left).clamp(mx, (mx + mw - w).max(mx))
}
/// Where the window's top-left corner goes, plus the bottom edge of that
/// monitor's work area.
fn placement_target(window: &tauri::WebviewWindow) -> Option<(i32, i32, i32)> {
    let (align, mon_idx) = config::get_placement();
    let monitors = window.available_monitors().ok()?;
    let mon = if mon_idx >= 0 {
        monitors.get(mon_idx as usize).cloned()
    } else {
        None
    }
    .or_else(|| window.current_monitor().ok().flatten())
    .or_else(|| window.primary_monitor().ok().flatten())?;
    let (mx, my) = (mon.position().x, mon.position().y);
    let (mw, mh) = (mon.size().width as i32, mon.size().height as i32);
    let (w, h) = base_size_physical(window);
    let (va, ha) = align.split_at(1);
    let (left, right) = side_extents(window);
    let tx = window_left(ha, mx, mw, w, left, right);
    let ty = match va {
        "t" => my,
        "b" => my + mh - h,
        _ => my + (mh - h) / 2,
    };
    Some((tx, ty, work_bottom(&mon)))
}
pub fn place_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match placement_target(&window) {
            Some((tx, ty, bottom)) => {
                fit_height(&window, ty, bottom);
                animate_window_to(window, tx, ty)
            }
            None => animate_recenter(app),
        }
    }
}
static DOCK_RETURN: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);

/// While the eyedropper runs the window folds into a bar; this moves the window so the bar
/// (its centre x and top, in physical px relative to the window) sits at the top centre of
/// the monitor, and `on = false` brings the window back to where it was.
#[tauri::command]
pub fn dock_window_for_pick(app: tauri::AppHandle, on: bool, bar_cx: f64, bar_top: f64, margin: f64) {
    let Some(window) = app.get_webview_window("main") else { return };
    if !on {
        let back = DOCK_RETURN.lock().ok().and_then(|mut g| g.take());
        if let Some((x, y)) = back {
            animate_window_to(window, x, y);
        }
        return;
    }
    let (Ok(pos), Ok(Some(mon))) = (window.outer_position(), window.current_monitor()) else { return };
    if let Ok(mut g) = DOCK_RETURN.lock() {
        if g.is_none() {
            *g = Some((pos.x, pos.y));
        }
    }
    let tx = mon.position().x + (mon.size().width as f64 / 2.0 - bar_cx).round() as i32;
    let ty = mon.position().y + (margin - bar_top).round() as i32;
    animate_window_to(window, tx, ty);
}

pub fn animate_recenter(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let target = window.current_monitor().ok().flatten().map(|mon| {
            let (mon_pos, mon_size) = (mon.position(), mon.size());
            let (w, h) = base_size_physical(&window);
            let (left, right) = side_extents(&window);
            (
                window_left("c", mon_pos.x, mon_size.width as i32, w, left, right),
                mon_pos.y + ((mon_size.height as i32) - h) / 2,
                work_bottom(&mon),
            )
        });
        if let Some((tx, ty, bottom)) = target {
            fit_height(&window, ty, bottom);
            animate_window_to(window, tx, ty);
        }
    }
}
#[tauri::command]
pub fn recenter_window(app: tauri::AppHandle) {
    animate_recenter(&app);
}
/// Applies the new base size and moves the window's left edge by `shift` logical px
/// (positive = further left) in one call. A dock on the left grows the window
/// leftwards; doing the size and the position as two calls showed the panel
/// jumping in between, so on Windows they go out together as one `SetWindowPos`.
fn resize_and_shift(app: &tauri::AppHandle, shift: f64) {
    let Some(window) = app.get_webview_window("main") else { return };
    let (Ok(pos), Some(mon)) = (window.outer_position(), window.current_monitor().ok().flatten()) else {
        refit_window(app);
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, base_h) = base_size_physical(&window);
    let h = fitted_height(base_h, pos.y, work_bottom(&mon), config::get_theme().tall_results);
    let x = pos.x - (shift * scale).round() as i32;
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        unsafe {
            SetWindowPos(hwnd.0 as windows_sys::Win32::Foundation::HWND, 0 as _, x, pos.y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        return;
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(x, pos.y));
    let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
}
#[tauri::command]
pub fn resize_main_window(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    shift_x: Option<f64>,
    panel_width: Option<f64>,
    panel_left: Option<bool>,
) {
    // Callers that only resize (the grip) leave the panel as it was.
    if let Some(w) = panel_width {
        *THEME_PANEL.lock().unwrap() = (w.clamp(0.0, 1400.0), panel_left.unwrap_or(false));
    }
    let width = width.clamp(480.0, 1500.0);
    let height = height.clamp(400.0, 900.0);
    *BASE_SIZE.lock().unwrap() = (width, height);
    match shift_x {
        Some(shift) if shift != 0.0 => resize_and_shift(&app, shift),
        _ => refit_window(&app),
    }
}
#[tauri::command]
pub fn set_window_pin(app: tauri::AppHandle, pinned: bool) -> bool {
    if pinned {
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(p) = w.outer_position() {
                crate::config::set_pinned(true, p.x, p.y);
                return true;
            }
        }
        return false;
    }
    crate::config::set_pinned(false, 0, 0);
    false
}
#[tauri::command]
pub fn get_window_pin() -> bool {
    crate::config::is_pinned()
}
#[cfg(test)]
mod tests {
    use super::{fitted_height, window_left};
    // 1920px monitor at x=0, a 660px panel, a 168px dock or a 380px theme panel.
    #[test]
    fn centres_the_window_when_there_is_no_dock() {
        assert_eq!(window_left("c", 0, 1920, 660, 0, 0), 630);
    }
    #[test]
    fn centres_the_search_panel_not_the_whole_window_with_a_dock() {
        // Panel 630..1290 either way; the dock hangs off the left or the right.
        assert_eq!(window_left("c", 0, 1920, 828, 168, 0), 462);
        assert_eq!(window_left("c", 0, 1920, 828, 0, 168), 630);
    }
    #[test]
    fn keeps_the_dock_on_screen_at_the_edges() {
        assert_eq!(window_left("l", 0, 1920, 828, 168, 0), 0);
        assert_eq!(window_left("r", 0, 1920, 828, 0, 168), 1092);
        assert_eq!(window_left("r", 1920, 1920, 828, 168, 0), 3012);
    }
    #[test]
    fn keeps_the_search_panel_put_with_a_dock_and_a_theme_panel() {
        // Dock 168 on the left, theme panel 380 on the right: panel 630..1290 as before.
        assert_eq!(window_left("c", 0, 1920, 1208, 168, 380), 462);
    }
    #[test]
    fn keeps_the_normal_height_when_not_stretching() {
        assert_eq!(fitted_height(560, 200, 1032, false), 560);
    }
    #[test]
    fn stretches_down_to_the_work_area_bottom() {
        assert_eq!(fitted_height(560, 200, 1032, true), 832);
    }
    #[test]
    fn never_shrinks_below_the_normal_height() {
        // Bottom-aligned window: its top is already within 560px of the edge.
        assert_eq!(fitted_height(560, 600, 1032, true), 560);
    }
}
/// The card shown when Umbra starts for the first time, or when the hotkey hook
/// could not be installed (the hotkey then does nothing, so say so).
#[derive(Clone, serde::Serialize)]
pub struct Welcome {
    pub hotkey: String,
    pub hook_ok: bool,
    pub first_run: bool,
}
static WELCOME: std::sync::Mutex<Option<Welcome>> = std::sync::Mutex::new(None);
/// Queues the card and tells the page; whichever comes first, this event or the
/// page asking on load, gets it (take_welcome hands it out once).
pub fn set_welcome(app: &tauri::AppHandle, welcome: Welcome) {
    *WELCOME.lock().unwrap() = Some(welcome);
    let _ = tauri::Emitter::emit(app, "welcome-ready", ());
}
/// Called by the page once it has loaded (an event sent from setup could arrive
/// before it listens): if this start has a welcome card, shows the window and
/// hands the card over, once.
#[tauri::command]
pub fn take_welcome(app: tauri::AppHandle) -> Option<Welcome> {
    let welcome = WELCOME.lock().unwrap().take()?;
    if let Some(window) = app.get_webview_window("main") {
        crate::show_window(&window);
    }
    Some(welcome)
}
