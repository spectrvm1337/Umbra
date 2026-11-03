//! Background blur under the cards (Appearance → Blur). The window is a transparent rectangle with
//! rounded cards in it, and Windows 10 blurs whole windows only. So the blur is drawn with
//! Windows.UI.Composition under the page: one sprite per card, painted with the HostBackdropBrush
//! (what is behind the window, already blurred by the system) and clipped to the card's rounded
//! rectangle. The strength is a Gaussian blur on top of the system's own. The page measures the
//! cards (blur.js) and sends them here as physical px relative to the window.
use crate::sync::LockExt;
use std::cell::RefCell;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use windows::core::{implement, Interface, HSTRING};
use windows::Graphics::Effects::{IGraphicsEffect, IGraphicsEffect_Impl, IGraphicsEffectSource, IGraphicsEffectSource_Impl};
use windows::UI::Composition::{CompositionBrush, CompositionEffectSourceParameter, Compositor, ContainerVisual};
use windows::Win32::System::WinRT::Graphics::Direct2D::{IGraphicsEffectD2D1Interop, IGraphicsEffectD2D1Interop_Impl, GRAPHICS_EFFECT_PROPERTY_MAPPING};
use windows_sys::Win32::Foundation::HWND;

/// A card: x, y, width, height, corner radius, and its opacity on the page (0..1), so its blur fades
/// in and out with it.
pub type Shape = [f64; 6];

static SHAPES: Mutex<Vec<Shape>> = Mutex::new(Vec::new());

struct Host {
    _queue: Option<windows::System::DispatcherQueueController>,
    compositor: Compositor,
    _target: windows::UI::Composition::Desktop::DesktopWindowTarget,
    root: ContainerVisual,
    brush: CompositionBrush,
    strength: u32,
}

thread_local! {
    // The composition objects belong to the window's thread.
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

fn main_hwnd(app: &AppHandle) -> Option<HWND> {
    let w = app.get_webview_window("main")?;
    w.hwnd().ok().map(|h| h.0 as HWND)
}

/// Applies the saved setting; called at start-up and after every theme save.
pub fn apply(app: &AppHandle) {
    let theme = crate::config::get_theme();
    let (on, strength) = (theme.blur_on, theme.blur_strength);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(hwnd) = main_hwnd(&handle) else { return };
        HOST.with(|h| {
            let mut h = h.borrow_mut();
            if !on {
                // A start with blur off has nothing to undo.
                if h.take().is_some() {
                    unsafe { set_accent(hwnd, 0) };
                }
                return;
            }
            if h.is_none() {
                unsafe { set_accent(hwnd, 5) }; // ACCENT_ENABLE_HOSTBACKDROP: lets the brush see behind the window
                *h = host_start(hwnd).map_err(|e| eprintln!("blur: {e}")).ok();
            }
            let Some(host) = h.as_mut() else { return };
            if host.strength != strength {
                match make_brush(&host.compositor, strength) {
                    Ok(b) => {
                        host.brush = b;
                        host.strength = strength;
                    }
                    Err(e) => eprintln!("blur strength: {e}"),
                }
            }
            draw(host);
        });
    });
}

fn draw(host: &Host) {
    let shapes = SHAPES.lock_or_recover().clone();
    if let Err(e) = host_draw(host, &shapes) {
        eprintln!("blur draw: {e}");
    }
}

#[tauri::command]
pub fn set_blur_shapes(app: AppHandle, shapes: Vec<Shape>) {
    let shapes: Vec<Shape> = shapes
        .into_iter()
        .filter(|s| s.iter().all(|v| v.is_finite()) && s[2] > 0.0 && s[3] > 0.0)
        .take(256)
        .collect();
    *SHAPES.lock_or_recover() = shapes;
    let _ = app.run_on_main_thread(|| HOST.with(|h| h.borrow().as_ref().map(draw)).unwrap_or(()));
}

/// Fades the blur with the page's own show / hide fade (blur.js), which otherwise leaves the blur
/// standing at full strength while the cards over it fade away.
#[tauri::command]
pub fn set_blur_fade(app: AppHandle, visible: bool, ms: f64) {
    let _ = app.run_on_main_thread(move || {
        HOST.with(|h| {
            if let Some(host) = h.borrow().as_ref() {
                if let Err(e) = host_fade(host, if visible { 1.0 } else { 0.0 }, ms) {
                    eprintln!("blur fade: {e}");
                }
            }
        });
    });
}

// ---- accent -----------------------------------------------------------------------------------

#[repr(C)]
struct AccentPolicy {
    state: u32,
    flags: u32,
    gradient: u32,
    animation: u32,
}
#[repr(C)]
struct CompositionAttribData {
    attrib: u32,
    data: *mut core::ffi::c_void,
    size: usize,
}
const WCA_ACCENT_POLICY: u32 = 19;

/// SetWindowCompositionAttribute is undocumented, so it is looked up rather than linked.
unsafe fn set_accent(hwnd: HWND, state: u32) {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    let user32 = GetModuleHandleA(b"user32.dll\0".as_ptr());
    let Some(f) = GetProcAddress(user32, b"SetWindowCompositionAttribute\0".as_ptr()) else { return };
    let f: unsafe extern "system" fn(HWND, *mut CompositionAttribData) -> i32 = std::mem::transmute(f);
    let mut policy = AccentPolicy { state, flags: 2, gradient: 0x0100_0000, animation: 0 };
    let mut data = CompositionAttribData {
        attrib: WCA_ACCENT_POLICY,
        data: &mut policy as *mut _ as _,
        size: std::mem::size_of::<AccentPolicy>(),
    };
    f(hwnd, &mut data);
}

// ---- composition ------------------------------------------------------------------------------

fn host_start(hwnd: HWND) -> windows::core::Result<Host> {
    use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
    use windows::Win32::System::WinRT::{CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT};
    // A compositor needs a dispatcher queue on its thread; if the thread already has one, that one does.
    let queue = unsafe {
        CreateDispatcherQueueController(DispatcherQueueOptions {
            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_NONE,
        })
    }
    .ok();
    let compositor = Compositor::new()?;
    let interop: ICompositorDesktopInterop = compositor.cast()?;
    // Not topmost: the sprites go under the page, which is drawn over them.
    let target = unsafe { interop.CreateDesktopWindowTarget(windows::Win32::Foundation::HWND(hwnd as _), false)? };
    let root = compositor.CreateContainerVisual()?;
    target.SetRoot(&root)?;
    let brush = make_brush(&compositor, 0)?;
    Ok(Host { _queue: queue, compositor, _target: target, root, brush, strength: 0 })
}

/// The system's blurred backdrop, blurred `strength` px more.
fn make_brush(c: &Compositor, strength: u32) -> windows::core::Result<CompositionBrush> {
    let backdrop: CompositionBrush = c.CreateHostBackdropBrush()?.cast()?;
    if strength == 0 {
        return Ok(backdrop);
    }
    let source: IGraphicsEffectSource = CompositionEffectSourceParameter::Create(&HSTRING::from("backdrop"))?.cast()?;
    let effect: IGraphicsEffect = GaussianBlur { amount: strength as f32, source }.into();
    let brush = c.CreateEffectFactory(&effect)?.CreateBrush()?;
    brush.SetSourceParameter(&HSTRING::from("backdrop"), &backdrop)?;
    brush.cast()
}

/// Moves the blur with the page's column (--lift in pinsfold.js, `y` in physical px). The page sends
/// the cards without that move, and the move itself runs here as the same transition the stylesheet
/// gives it, so the blur cannot trail behind a column gliding up or down.
#[tauri::command]
pub fn set_blur_lift(app: AppHandle, y: f64, ms: f64) {
    if !y.is_finite() {
        return;
    }
    let _ = app.run_on_main_thread(move || {
        HOST.with(|h| {
            if let Some(host) = h.borrow().as_ref() {
                // The column's curve: --ease-glide, cubic-bezier(0.32, 0.72, 0, 1). Even a jump is an
                // animation (1ms), so that it waits for the page the same way.
                if let Err(e) = animate(host, "Offset.Y", y as f32, ms.max(1.0), [0.32, 0.72, 0.0, 1.0], PAGE_LAG_MS) {
                    eprintln!("blur lift: {e}");
                }
            }
        });
    });
}

/// How much later the page's own transitions reach the screen than an animation started here: the
/// page goes through WebView2's renderer, this goes to DWM directly. Without the wait the blur ran a
/// frame or two ahead of a gliding column and showed as a second search box.
/// shortcut: a fixed two frames at 60Hz, estimated rather than measured; tune it if the blur still leads or trails.
const PAGE_LAG_MS: f64 = 33.0;

fn host_fade(host: &Host, to: f32, ms: f64) -> windows::core::Result<()> {
    // The page's fade curve: cubic-bezier(0.16, 1, 0.3, 1).
    animate(host, "Opacity", to, ms, [0.16, 1.0, 0.3, 1.0], 0.0)
}

/// Runs the root's `property` to `to` over `ms` on a CSS-style cubic bezier after `delay_ms`, or
/// sets it at once when `ms` is 0.
fn animate(host: &Host, property: &str, to: f32, ms: f64, bezier: [f32; 4], delay_ms: f64) -> windows::core::Result<()> {
    use windows_numerics::{Vector2, Vector3};
    let name = HSTRING::from(property);
    if !(ms.is_finite() && ms > 0.0) {
        host.root.StopAnimation(&name)?;
        return match property {
            "Opacity" => host.root.SetOpacity(to),
            _ => host.root.SetOffset(Vector3 { X: 0.0, Y: to, Z: 0.0 }),
        };
    }
    let c = &host.compositor;
    let anim = c.CreateScalarKeyFrameAnimation()?;
    let [x1, y1, x2, y2] = bezier;
    let ease = c.CreateCubicBezierEasingFunction(Vector2 { X: x1, Y: y1 }, Vector2 { X: x2, Y: y2 })?;
    anim.InsertKeyFrameWithEasingFunction(1.0, to, &ease)?;
    anim.SetDuration(windows::Foundation::TimeSpan { Duration: (ms.min(5000.0) * 10_000.0) as i64 })?;
    if delay_ms > 0.0 {
        anim.SetDelayTime(windows::Foundation::TimeSpan { Duration: (delay_ms * 10_000.0) as i64 })?;
    }
    host.root.StartAnimation(&name, &anim)
}

fn host_draw(host: &Host, shapes: &[Shape]) -> windows::core::Result<()> {
    use windows_numerics::{Vector2, Vector3};
    let kids = host.root.Children()?;
    kids.RemoveAll()?;
    for s in shapes {
        let [x, y, w, h, r, opacity] = s.map(|v| v as f32);
        let sprite = host.compositor.CreateSpriteVisual()?;
        sprite.SetBrush(&host.brush)?;
        sprite.SetOpacity(opacity.clamp(0.0, 1.0))?;
        sprite.SetOffset(Vector3 { X: x, Y: y, Z: 0.0 })?;
        sprite.SetSize(Vector2 { X: w, Y: h })?;
        let shape = host.compositor.CreateRoundedRectangleGeometry()?;
        shape.SetSize(Vector2 { X: w, Y: h })?;
        shape.SetCornerRadius(Vector2 { X: r, Y: r })?;
        sprite.SetClip(&host.compositor.CreateGeometricClipWithGeometry(&shape)?)?;
        kids.InsertAtTop(&sprite)?;
    }
    Ok(())
}

// ---- the Gaussian blur effect -----------------------------------------------------------------
// Composition takes effects as IGraphicsEffect objects that describe a Direct2D effect (what Win2D
// provides in C#). Only the one effect is needed, so it is described here.

/// CLSID_D2D1GaussianBlur.
const D2D1_GAUSSIAN_BLUR: windows::core::GUID = windows::core::GUID::from_u128(0x1feb6d69_2fe6_4ac9_8c58_1d7f93e7a6a5);
/// D2D1_BORDER_MODE_HARD: the edges of a card are not blurred into transparency.
const BORDER_MODE_HARD: u32 = 1;
/// D2D1_GAUSSIANBLUR_OPTIMIZATION_BALANCED.
const OPTIMIZATION_BALANCED: u32 = 1;

#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
struct GaussianBlur {
    amount: f32,
    source: IGraphicsEffectSource,
}

impl IGraphicsEffect_Impl for GaussianBlur_Impl {
    fn Name(&self) -> windows::core::Result<HSTRING> {
        Ok(HSTRING::from("blur"))
    }
    fn SetName(&self, _name: &HSTRING) -> windows::core::Result<()> {
        Ok(())
    }
}

impl IGraphicsEffectSource_Impl for GaussianBlur_Impl {}

impl IGraphicsEffectD2D1Interop_Impl for GaussianBlur_Impl {
    fn GetEffectId(&self) -> windows::core::Result<windows::core::GUID> {
        Ok(D2D1_GAUSSIAN_BLUR)
    }
    // No property is animated, so none is looked up by name.
    fn GetNamedPropertyMapping(&self, _: &windows::core::PCWSTR, _: *mut u32, _: *mut GRAPHICS_EFFECT_PROPERTY_MAPPING) -> windows::core::Result<()> {
        Err(windows::Win32::Foundation::E_INVALIDARG.into())
    }
    fn GetPropertyCount(&self) -> windows::core::Result<u32> {
        Ok(3)
    }
    // In D2D1_GAUSSIANBLUR_PROP order: standard deviation, optimization, border mode.
    fn GetProperty(&self, index: u32) -> windows::core::Result<windows::Foundation::IPropertyValue> {
        use windows::Foundation::PropertyValue;
        match index {
            0 => PropertyValue::CreateSingle(self.amount)?.cast(),
            1 => PropertyValue::CreateUInt32(OPTIMIZATION_BALANCED)?.cast(),
            2 => PropertyValue::CreateUInt32(BORDER_MODE_HARD)?.cast(),
            _ => Err(windows::Win32::Foundation::E_INVALIDARG.into()),
        }
    }
    fn GetSource(&self, index: u32) -> windows::core::Result<IGraphicsEffectSource> {
        if index == 0 {
            Ok(self.source.clone())
        } else {
            Err(windows::Win32::Foundation::E_INVALIDARG.into())
        }
    }
    fn GetSourceCount(&self) -> windows::core::Result<u32> {
        Ok(1)
    }
}
