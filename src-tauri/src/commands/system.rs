

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

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn kill_process(name: String) -> Result<String, String> {
    let mut process_name = name.trim().to_string();
    if !process_name.to_lowercase().ends_with(".exe") {
        process_name.push_str(".exe");
    }

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
