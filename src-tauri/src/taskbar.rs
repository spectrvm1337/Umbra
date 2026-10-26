use windows_sys::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABS_AUTOHIDE, APPBARDATA};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
};
/// With an auto-hiding taskbar, brings it up while Umbra is shown.
pub fn show_if_autohide() {
    let class_name: Vec<u16> = "Shell_TrayWnd".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let tray = FindWindowW(class_name.as_ptr(), std::ptr::null());
        if tray.is_null() {
            return;
        }
        let mut data: APPBARDATA = std::mem::zeroed();
        data.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        let state = SHAppBarMessage(ABM_GETSTATE, &mut data);
        if state & ABS_AUTOHIDE as usize == 0 {
            return;
        }
        SetWindowPos(tray, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    }
}
