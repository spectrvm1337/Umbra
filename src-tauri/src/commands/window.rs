use crate::sync::LockExt;
use tauri::Manager;
/// Counts hides and wakes, so a sleep scheduled by a hide knows whether the window came back since.
static AWAKE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How long the page stays awake after the window is hidden. Asleep at once, a summon right after a
/// close found it trimmed to the bone and the window came up with a stutter.
const SLEEP_AFTER: std::time::Duration = std::time::Duration::from_secs(10);
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
        // The slide out stops, and the window goes back to where it rests, out of sight. A moment
        // later, not here: the slide's thread may be waiting on this very thread to apply its last
        // step, which then landed after the window had been put back and left it raised.
        stop_window_motion();
        let stopped = MOVE_GEN.load(std::sync::atomic::Ordering::SeqCst);
        if let Some(rest) = *REST.lock_or_recover() {
            let back = w.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(60));
                // Not if it was summoned again meanwhile (that starts a move of its own).
                if MOVE_GEN.load(std::sync::atomic::Ordering::SeqCst) == stopped && !back.is_visible().unwrap_or(true) {
                    set_window_xy(&back, rest.0, rest.1);
                }
            });
        }
        let gen = AWAKE_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let later = w.clone();
        std::thread::spawn(move || {
            // The Start Menu and the registry are looked at again while the window is away (at most
            // every few minutes, refresh_fast_index). Done on the summon, as before, the walk, the
            // disk checks and the write lock on the index fell on the window coming up and on the
            // first search, and after a long idle the summon stuttered behind them.
            std::thread::sleep(std::time::Duration::from_secs(2));
            if AWAKE_GEN.load(std::sync::atomic::Ordering::SeqCst) == gen && !later.is_visible().unwrap_or(true) {
                crate::indexer::refresh_fast_index();
            }
            std::thread::sleep(SLEEP_AFTER.saturating_sub(std::time::Duration::from_secs(2)));
            if AWAKE_GEN.load(std::sync::atomic::Ordering::SeqCst) == gen && !later.is_visible().unwrap_or(true) {
                set_webview_awake(&later, false);
            }
        });
        // The screen behind it, for the next summon, once DWM has taken the window off.
        crate::backdrop::refresh_later(&w, 300);
    }
}
/// The window is hidden nearly all the time. Asleep the page is told it is not on screen (hiding the
/// window alone does not tell it), so it stops rendering; `SetIsVisible(true)` on the next summon
/// wakes it before the window shows.
/// It is not suspended (TrySuspend): after a long idle a suspended page took long enough to come
/// back that the summon showed an empty window, the next press of the hotkey hid it again, and Umbra
/// seemed to open only at the fifth try. Nor is it asked for the low memory target any more: that
/// dropped its caches and let its memory go to the page file, and after a long idle every summon
/// paid for rebuilding them, the slow first open after a while away.
pub fn set_webview_awake(window: &tauri::WebviewWindow, awake: bool) {
    if awake {
        // A sleep a recent hide scheduled no longer applies.
        AWAKE_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(target_os = "windows")]
    let _ = window.with_webview(move |webview| unsafe {
        let _ = webview.controller().SetIsVisible(awake);
    });
}
use crate::config;
/// The window's normal size in logical px: what the resize grip last set, or
/// the tauri.conf default. Placement always aligns this size, so a window
/// stretched on the last summon never shifts where the next one lands.
static BASE_SIZE: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((660.0, 560.0));
fn base_size_physical(window: &tauri::WebviewWindow) -> (i32, i32) {
    let (w, h) = *BASE_SIZE.lock_or_recover();
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
/// Bumped by every new move. A move whose number is no longer the latest stops,
/// so two summons in a row (or the eyedropper's dock while the window is still
/// gliding in) never have two threads pulling the window different ways.
static MOVE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Moves the window to a monitor's spot (placement, the eyedropper's dock, recentring).
fn animate_window_to(window: tauri::WebviewWindow, target_x: i32, target_y: i32) {
    animate_window(window, (target_x, target_y), 320, [0.16, 1.0, 0.3, 1.0], (target_x, target_y));
}
/// Where the window comes to rest when the move under way ends, while one runs: for the slide out
/// on hide that is where it started, not where it is going (see window_slide_out).
static ANIM_REST: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);
/// Where the window rests while it is up, before the column's lift (LIFT); it goes back there,
/// hidden, after the slide out.
static REST: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);
/// How far the window sits below REST, in physical px: the page's column lifted to the middle of the
/// window (pinsfold.js), done by moving the whole window so the blur under the cards moves with it.
static LIFT: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
fn lift() -> i32 {
    LIFT.load(std::sync::atomic::Ordering::SeqCst)
}
/// The point on a CSS cubic-bezier(x1, y1, x2, y2) curve at progress `p` (0..1).
fn cubic_bezier(p: f64, [x1, y1, x2, y2]: [f64; 4]) -> f64 {
    if p <= 0.0 {
        return 0.0;
    }
    if p >= 1.0 {
        return 1.0;
    }
    let bez = |t: f64, a: f64, b: f64| {
        let u = 1.0 - t;
        3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
    };
    // t for which the curve's x is p, by bisection (x grows with t for every curve used here).
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..30 {
        let mid = (lo + hi) / 2.0;
        if bez(mid, x1, x2) < p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bez((lo + hi) / 2.0, y1, y2)
}
/// Puts the window at `(x, y)` (physical px) at once, keeping its size and place in the z-order.
/// Synchronous on purpose: posted (SWP_ASYNCWINDOWPOS), steps of a slide still queued behind a busy
/// window thread were applied after the window had been put back in place on hide, and left it raised.
/// Waiting for each step instead, the next one is taken from the clock, so a late frame is skipped,
/// not replayed.
fn set_window_xy(window: &tauri::WebviewWindow, x: i32, y: i32) {
    #[cfg(target_os = "windows")]
    if let Ok(h) = window.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};
        unsafe { SetWindowPos(h.0 as _, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) };
        return;
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}
/// Animates the window to `target` over `ms` along a CSS cubic-bezier curve, one step per
/// frame of the desktop compositor (DwmFlush), so it moves as evenly as a CSS transition.
/// `rest` is where it rests once done (see ANIM_REST).
fn animate_window(window: tauri::WebviewWindow, target: (i32, i32), ms: u64, curve: [f64; 4], rest: (i32, i32)) {
    use std::sync::atomic::Ordering;
    let gen = MOVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    *ANIM_REST.lock_or_recover() = Some(rest);
    std::thread::spawn(move || {
        let done = |gen: u64| {
            if MOVE_GEN.load(Ordering::SeqCst) == gen {
                *ANIM_REST.lock_or_recover() = None;
            }
        };
        let Ok(from) = window.outer_position() else { return done(gen) };
        let (from_x, from_y) = (from.x, from.y);
        if (from_x - target.0).abs() < 1 && (from_y - target.1).abs() < 1 || ms == 0 {
            set_window_xy(&window, target.0, target.1);
            return done(gen);
        }
        let started = std::time::Instant::now();
        loop {
            if MOVE_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            let p = (started.elapsed().as_secs_f64() * 1000.0 / ms as f64).min(1.0);
            let e = cubic_bezier(p, curve);
            let x = from_x as f64 + (target.0 - from_x) as f64 * e;
            let y = from_y as f64 + (target.1 - from_y) as f64 * e;
            set_window_xy(&window, x.round() as i32, y.round() as i32);
            if p >= 1.0 {
                return done(gen);
            }
            #[cfg(target_os = "windows")]
            {
                if unsafe { windows_sys::Win32::Graphics::Dwm::DwmFlush() } < 0 {
                    std::thread::sleep(std::time::Duration::from_millis(8));
                }
            }
            #[cfg(not(target_os = "windows"))]
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
    });
}
/// The show and hide slide, from Settings → Animations (set_window_motion): how far the window
/// travels (logical px with the zoom in) and for how long (Movement's length, 0 when it is off).
/// The whole window moves rather than the page inside it, so the blur under the cards -- drawn
/// in the window by Windows, not by the page -- moves with it instead of a frame or two behind.
static SLIDE: std::sync::Mutex<(f64, u64)> = std::sync::Mutex::new((24.0, 320));
/// The page's own curve for it (--ease-out-apple in styles.css).
const SLIDE_EASE: [f64; 4] = [0.32, 0.72, 0.0, 1.0];
#[tauri::command]
pub fn set_window_motion(px: f64, ms: u64) {
    *SLIDE.lock_or_recover() = (px.clamp(0.0, 200.0), ms.min(2000));
}
/// The slide's distance in physical px, and its length; (0, 0) when Movement is off.
fn slide(window: &tauri::WebviewWindow) -> (i32, u64) {
    let (px, ms) = *SLIDE.lock_or_recover();
    let scale = window.scale_factor().unwrap_or(1.0);
    let off = (px * scale).round() as i32;
    if off == 0 || ms == 0 { (0, 0) } else { (off, ms) }
}
/// Where the window belongs on this summon, its height fitted there: the pinned spot, or the
/// placement from Settings on the active monitor.
pub fn resting_place(window: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    if config::is_pinned() {
        let pos = window.outer_position().ok()?;
        if let Ok(Some(mon)) = window.current_monitor() {
            fit_height(window, pos.y, work_bottom(&mon));
        }
        return Some((pos.x, pos.y));
    }
    if let Some((tx, ty, bottom)) = placement_target(window) {
        fit_height(window, ty, bottom);
        return Some((tx, ty));
    }
    let mon = window.current_monitor().ok().flatten()?;
    let (mon_pos, mon_size) = (mon.position(), mon.size());
    let (w, h) = base_size_physical(window);
    let (left, right) = side_extents(window);
    let tx = window_left("c", mon_pos.x, mon_size.width as i32, w, left, right);
    let ty = mon_pos.y + ((mon_size.height as i32) - h) / 2;
    fit_height(window, ty, work_bottom(&mon));
    Some((tx, ty))
}
/// A slide in waiting for the page to start its fade (window_slide_in).
static SLIDE_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Before the window is shown: it goes to `rest`, raised by the slide. It comes down when the page
/// starts fading in (window_slide_in from the "window-shown" handler), so the two begin together as
/// the old transform did; if the page does not say so in time, it comes down anyway.
pub fn slide_in_start(window: &tauri::WebviewWindow, rest: (i32, i32)) {
    use std::sync::atomic::Ordering;
    MOVE_GEN.fetch_add(1, Ordering::SeqCst);
    *ANIM_REST.lock_or_recover() = None;
    *REST.lock_or_recover() = Some(rest);
    let (off, _) = slide(window);
    set_window_xy(window, rest.0, rest.1 + lift() - off);
    SLIDE_PENDING.store(true, Ordering::SeqCst);
    let later = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if SLIDE_PENDING.load(Ordering::SeqCst) {
            slide_in_finish(&later);
        }
    });
}
/// Down into the resting place, as the page fades in (or comes back from a fade out).
pub fn slide_in_finish(window: &tauri::WebviewWindow) {
    SLIDE_PENDING.store(false, std::sync::atomic::Ordering::SeqCst);
    let Some(rest) = *REST.lock_or_recover() else { return };
    let (_, ms) = slide(window);
    let to = (rest.0, rest.1 + lift());
    animate_window(window.clone(), to, ms, SLIDE_EASE, to);
}
/// The page starts hiding: up by the slide while it fades out. Where the window rests is taken now,
/// so a drag since the summon is kept (and a move still under way counts by where it ends).
#[tauri::command]
pub fn window_slide_out(app: tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let rest = ANIM_REST.lock_or_recover().or_else(|| window.outer_position().ok().map(|p| (p.x, p.y)));
    let Some(rest) = rest else { return };
    *REST.lock_or_recover() = Some((rest.0, rest.1 - lift()));
    let (off, ms) = slide(&window);
    if ms > 0 {
        animate_window(window, (rest.0, rest.1 - off), ms, SLIDE_EASE, rest);
    }
}
/// A summon while the window is already up: it glides to where it belongs, no slide.
pub fn glide_to(window: &tauri::WebviewWindow, rest: (i32, i32)) {
    *REST.lock_or_recover() = Some(rest);
    animate_window_to(window.clone(), rest.0, rest.1 + lift());
}
/// The page's column moves to `y` physical px below where the window rests (the middle of the
/// window for what is under the search box, pinsfold.js): the window itself moves there, over `ms`
/// on the page's curve. Moving the column inside the page left the blur, which Windows draws under
/// the window, a frame or two behind it. Taken from where the window is now, so a drag is kept.
#[tauri::command]
pub fn set_window_lift(app: tauri::AppHandle, y: f64, ms: u64) {
    use std::sync::atomic::Ordering;
    if !y.is_finite() {
        return;
    }
    let y = y.round() as i32;
    let old = LIFT.swap(y, Ordering::SeqCst);
    if old == y {
        return;
    }
    // Raised for a summon and not yet coming down: it comes down to the new place (slide_in_finish).
    if SLIDE_PENDING.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let at = ANIM_REST.lock_or_recover().or_else(|| window.outer_position().ok().map(|p| (p.x, p.y)));
    let Some(at) = at else { return };
    let rest = (at.0, at.1 - old);
    *REST.lock_or_recover() = Some(rest);
    let to = (rest.0, rest.1 + y);
    if !window.is_visible().unwrap_or(false) {
        set_window_xy(&window, to.0, to.1);
        return;
    }
    // A jump during a summon's slide would cut the slide off: it goes on to the new place instead.
    let ms = if ms == 0 && ANIM_REST.lock_or_recover().is_some() { slide(&window).1 } else { ms.min(2000) };
    animate_window(window, to, ms, SLIDE_EASE, to);
}
/// The page starts fading in (the "window-shown" handler), or the hotkey came while it was fading
/// out (cancelHide in main.js): down into place.
#[tauri::command]
pub fn window_slide_in(app: tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    slide_in_finish(&window);
}
/// A drag of the window starts: whatever move is under way stops, so the two do not pull at it.
#[tauri::command]
pub fn stop_window_motion() {
    MOVE_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *ANIM_REST.lock_or_recover() = None;
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
    let (panel, panel_left) = *THEME_PANEL.lock_or_recover();
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
            *REST.lock_or_recover() = Some((tx, ty));
            animate_window_to(window, tx, ty + lift());
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
        *THEME_PANEL.lock_or_recover() = (w.clamp(0.0, 1400.0), panel_left.unwrap_or(false));
    }
    let width = width.clamp(480.0, 1500.0);
    // Up to 1600 for the theme panel, which grows the window to fit its card (the page keeps it to
    // the screen's work area); the resize grip stops lower, at MAIN_MAX_H.
    let height = height.clamp(400.0, 1600.0);
    *BASE_SIZE.lock_or_recover() = (width, height);
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
    use super::{cubic_bezier, fitted_height, window_left, SLIDE_EASE};
    #[test]
    fn the_window_slide_follows_the_pages_curve() {
        // cubic-bezier(0.32, 0.72, 0, 1): starts at 0, ends at 1, never goes back, and is an ease-out
        // (most of the way done by the middle), like the CSS transition it replaces.
        assert_eq!(cubic_bezier(0.0, SLIDE_EASE), 0.0);
        assert_eq!(cubic_bezier(1.0, SLIDE_EASE), 1.0);
        let mut last = 0.0;
        for i in 1..=100 {
            let v = cubic_bezier(i as f64 / 100.0, SLIDE_EASE);
            assert!(v >= last - 1e-9, "monotonic at {i}");
            last = v;
        }
        let mid = cubic_bezier(0.5, SLIDE_EASE);
        assert!((0.94..0.97).contains(&mid), "ease-out, as the CSS one: {mid}");
    }
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
    *WELCOME.lock_or_recover() = Some(welcome);
    let _ = tauri::Emitter::emit(app, "welcome-ready", ());
}
/// Called by the page once it has loaded (an event sent from setup could arrive
/// before it listens): if this start has a welcome card, shows the window and
/// hands the card over, once.
#[tauri::command]
pub fn take_welcome(app: tauri::AppHandle) -> Option<Welcome> {
    let welcome = WELCOME.lock_or_recover().take()?;
    if let Some(window) = app.get_webview_window("main") {
        crate::show_window(&window);
    }
    Some(welcome)
}
