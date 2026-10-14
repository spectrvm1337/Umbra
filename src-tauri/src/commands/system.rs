use crate::frecency;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[tauri::command]
pub async fn launch_item(path: String) -> Result<String, String> {
    if !path.starts_with("http://") && !path.starts_with("https://") {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("Path not found: {}", path));
        }
    }
    frecency::record_usage(&path);
    open::that_detached(&path).map_err(|e| format!("Failed to open: {}", e))?;
    Ok(path)
}
/// Opens the folder that holds `path` in Explorer with that file (or folder)
/// selected, instead of leaving the user to find it in the listing.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Path not found: {}", path));
    }
    // Explorer parses its own command line: the path goes in quotes right after
    // the comma, and Windows paths cannot contain a quote themselves.
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Explorer: {}", e))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let parent = std::path::Path::new(&path).parent().ok_or("no parent folder")?;
    open::that_detached(parent).map_err(|e| e.to_string())
}
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn launch_admin(path: String) -> Result<String, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide_path: Vec<u16> = OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let result = ShellExecuteW(
            None,
            PCWSTR::from_raw(verb.as_ptr()),
            PCWSTR::from_raw(wide_path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if result.0 as isize > 32 {
            frecency::record_usage(&path);
            Ok(path)
        } else {

            Err(format!("ShellExecuteW failed with code {:?}", result))
        }
    }
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn launch_admin(path: String) -> Result<String, String> {
    Err("Not supported on this platform".to_string())
}
/// `chrome` -> `chrome.exe`. taskkill treats `*` and `?` in /IM as wildcards
/// (`kill *` would close every program), so those, path separators and quotes
/// are refused instead of being passed through.
pub(crate) fn process_exe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("no process name".to_string());
    }
    if name.contains(['*', '?', '\\', '/', '"']) {
        return Err("wildcards and paths are not allowed".to_string());
    }
    if name.to_ascii_lowercase().ends_with(".exe") {
        Ok(name.to_string())
    } else {
        Ok(format!("{name}.exe"))
    }
}
#[derive(serde::Serialize)]
pub struct RunningProcess {
    /// How many processes have this image name.
    pub count: usize,
    /// Full path of the first one we may query (None for elevated or
    /// protected processes), used for the icon on the kill card.
    pub path: Option<String>,
}
#[cfg(target_os = "windows")]
fn running_processes(exe_name: &str) -> RunningProcess {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut found = RunningProcess { count: 0, path: None };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry);
        while ok != 0 {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(260);
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if exe.eq_ignore_ascii_case(exe_name) {
                found.count += 1;
                if found.path.is_none() {
                    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if !process.is_null() {
                        let mut buf = [0u16; 1024];
                        let mut size = buf.len() as u32;
                        if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0 {
                            found.path = Some(String::from_utf16_lossy(&buf[..size as usize]));
                        }
                        CloseHandle(process);
                    }
                }
            }
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    found
}
#[cfg(not(target_os = "windows"))]
fn running_processes(_exe_name: &str) -> RunningProcess {
    RunningProcess { count: 0, path: None }
}
/// What the `kill` card shows before the user confirms.
#[tauri::command]
pub fn find_process(name: String) -> Result<RunningProcess, String> {
    Ok(running_processes(&process_exe_name(&name)?))
}
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn kill_process(name: String) -> Result<String, String> {
    let process_name = process_exe_name(&name)?;
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/F", "/IM", &process_name]);
    cmd.creation_flags(0x08000000); 
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;
    if output.status.success() {
        Ok(format!("Killed {}", process_name))
    } else {
        Err("Failed to kill process".to_string())
    }
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn kill_process(name: String) -> Result<String, String> {
    process_exe_name(&name)?;
    let output = std::process::Command::new("killall")
        .arg(&name)
        .output()
        .map_err(|e| format!("Failed to run killall: {}", e))?;
    if output.status.success() {
        Ok(format!("Killed {}", name))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
#[cfg(target_os = "windows")]
fn suspend_to_sleep() {
    #[link(name = "powrprof")]
    extern "system" {
        fn SetSuspendState(hibernate: u8, force: u8, wakeup_events_disabled: u8) -> u8;
    }
    std::thread::spawn(|| {
        if unsafe { SetSuspendState(0, 0, 0) } == 0 {
            let _ = std::process::Command::new("rundll32.exe")
                .args(["powrprof.dll,SetSuspendState", "0,1,0"])
                .creation_flags(0x08000000)
                .spawn();
        }
    });
}
#[tauri::command]
pub fn exec_power_command(command: String) -> Result<String, String> {
    let cmd = command.trim().to_lowercase();
    #[cfg(target_os = "windows")]
    if cmd == "sleep" {
        suspend_to_sleep();
        return Ok(format!("Executed: {}", cmd));
    }
    let args: Vec<&str> = match cmd.as_str() {
        "shutdown" => vec!["shutdown", "/s", "/t", "0"],
        "restart" => vec!["shutdown", "/r", "/t", "0"],
        "sleep" => vec!["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"],
        _ => return Err(format!("Unknown power command: {}", command)),
    };
    let mut proc_cmd = std::process::Command::new(&args[0]);
    proc_cmd.args(&args[1..]);
    #[cfg(target_os = "windows")]
    proc_cmd.creation_flags(0x08000000); 
    let output = proc_cmd
        .output()
        .map_err(|e| format!("Failed to execute: {}", e))?;
    if output.status.success() {
        Ok(format!("Executed: {}", cmd))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_names_without_wildcards_get_an_exe_suffix() {
        assert_eq!(process_exe_name(" chrome ").unwrap(), "chrome.exe");
        assert_eq!(process_exe_name("Code.EXE").unwrap(), "Code.EXE");
        for bad in ["", "   ", "*", "*.exe", "chr?me", "C:\\x\\a.exe", "a/b", "\"x\""] {
            assert!(process_exe_name(bad).is_err(), "{bad:?} accepted");
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn finds_its_own_process() {
        let me = std::env::current_exe().unwrap();
        let name = me.file_name().unwrap().to_string_lossy().to_string();
        let found = running_processes(&name);
        assert!(found.count >= 1);
        assert!(found.path.unwrap().eq_ignore_ascii_case(&me.to_string_lossy()));
        assert_eq!(running_processes("umbra-no-such-process.exe").count, 0);
    }
}
