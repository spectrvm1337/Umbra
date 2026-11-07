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
    #[cfg(target_os = "windows")]
    shell_execute(&path, "open").map_err(|e| format!("Failed to open: {}", e))?;
    #[cfg(not(target_os = "windows"))]
    open::that_detached(&path).map_err(|e| format!("Failed to open: {}", e))?;
    Ok(path)
}
/// The folder a program starts in, the one Explorer would give it: the folder of the file opened,
/// or for a shortcut, of what it points at (a shortcut's own "Start in" still wins). Opened without
/// one, everything ran in Umbra's own folder (System32 when started with Windows), and whatever a
/// program looks for beside itself was not found: gradlew.bat next to a batch file, an app's files.
#[cfg(target_os = "windows")]
fn start_folder(path: &str) -> Option<String> {
    if path.starts_with("http://") || path.starts_with("https://") || std::path::Path::new(path).is_dir() {
        return None;
    }
    let target = if path.to_lowercase().ends_with(".lnk") {
        crate::icons::resolve_lnk_target(path)?
    } else {
        path.to_string()
    };
    std::path::Path::new(&target)
        .parent()
        .filter(|d| d.is_dir())
        .map(|d| d.to_string_lossy().into_owned())
}
/// Opens `path` with the shell `verb` ("open", "runas") the way Explorer does, in its own folder.
#[cfg(target_os = "windows")]
fn shell_execute(path: &str, verb: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let folder = start_folder(path).map(|d| HSTRING::from(d.as_str()));
    let (verb, file) = (HSTRING::from(verb), HSTRING::from(path));
    unsafe {
        // The shell asks for COM on the calling thread (shell extensions, shortcuts).
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let result = ShellExecuteW(
            None,
            &verb,
            &file,
            windows::core::PCWSTR::null(),
            folder.as_ref().map_or(windows::core::PCWSTR::null(), |d| windows::core::PCWSTR(d.as_ptr())),
            SW_SHOWNORMAL,
        );
        if init.is_ok() {
            CoUninitialize();
        }
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW failed with code {:?}", result))
        }
    }
}
/// Remembers which result was opened for the typed query (picks.rs).
#[tauri::command]
pub fn record_pick(query: String, path: String) {
    crate::picks::record(&query, &path);
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
    shell_execute(&path, "runas")?;
    frecency::record_usage(&path);
    Ok(path)
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
    /// The image name the typed one was taken to mean ("spot" -> "Spotify.exe"); what the card
    /// shows and what `kill_process` is then given. None when nothing running matches.
    pub exe: Option<String>,
}
/// Which running image `typed` means: the exact name, else the shortest one starting with it, else
/// the shortest one containing it. Partial matches need three letters, so "kill a" does not pick
/// some random program. The kill still waits for a click on a card that names the program.
pub(crate) fn pick_exe<'a>(running: &[&'a str], typed: &str) -> Option<&'a str> {
    let typed = typed.to_ascii_lowercase();
    if let Some(exact) = running.iter().find(|r| r.eq_ignore_ascii_case(&typed)) {
        return Some(exact);
    }
    let stem = typed.strip_suffix(".exe").unwrap_or(&typed);
    if stem.chars().count() < 3 {
        return None;
    }
    let shortest = |pred: &dyn Fn(&str) -> bool| {
        running
            .iter()
            .copied()
            .filter(|r| pred(&r.to_ascii_lowercase()))
            .min_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)))
    };
    shortest(&|r| r.starts_with(stem)).or_else(|| shortest(&|r| r.contains(stem)))
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
    let mut found = RunningProcess { count: 0, path: None, exe: None };
    // Every running image and its process id, then the one the typed name means.
    let mut all: Vec<(String, u32)> = Vec::new();
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
            all.push((String::from_utf16_lossy(&entry.szExeFile[..len]), entry.th32ProcessID));
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    let names: Vec<&str> = all.iter().map(|(n, _)| n.as_str()).collect();
    let Some(exe) = pick_exe(&names, exe_name).map(str::to_string) else {
        return found;
    };
    for (name, pid) in &all {
        if !name.eq_ignore_ascii_case(&exe) {
            continue;
        }
        found.count += 1;
        if found.path.is_none() {
            unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid);
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
    }
    found.exe = Some(exe);
    found
}
#[cfg(not(target_os = "windows"))]
fn running_processes(_exe_name: &str) -> RunningProcess {
    RunningProcess { count: 0, path: None, exe: None }
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
    fn a_partial_process_name_finds_the_program() {
        let running = ["svchost.exe", "Spotify.exe", "SpotifyWebHelper.exe", "chrome.exe", "Discord.exe"];
        assert_eq!(pick_exe(&running, "chrome.exe"), Some("chrome.exe"));
        assert_eq!(pick_exe(&running, "CHROME.EXE"), Some("chrome.exe"));
        // the shortest name that starts with it, then one that contains it
        assert_eq!(pick_exe(&running, "spot.exe"), Some("Spotify.exe"));
        assert_eq!(pick_exe(&running, "cord.exe"), Some("Discord.exe"));
        // too short to guess, or nothing like it
        assert_eq!(pick_exe(&running, "sp.exe"), None);
        assert_eq!(pick_exe(&running, "firefox.exe"), None);
    }
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
    #[cfg(target_os = "windows")]
    #[test]
    fn a_file_starts_in_its_own_folder_and_folders_and_links_in_none() {
        let dir = std::env::temp_dir().join(format!("umbra-start-folder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bat = dir.join("start.bat");
        std::fs::write(&bat, b"@echo off").unwrap();
        assert_eq!(start_folder(&bat.to_string_lossy()).as_deref(), Some(dir.to_string_lossy().as_ref()));
        assert_eq!(start_folder(&dir.to_string_lossy()), None);
        assert_eq!(start_folder("https://example.com/"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
