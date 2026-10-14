use std::path::PathBuf;
/// Name of the folder that holds every piece of Umbra state:
/// config.json, pins.json, frecency_stats.json and the themes/ folder.
const CONFIG_DIR_NAME: &str = ".Umbra-config";
/// Pre-0.1.3 name, kept only so existing installs can be migrated once.
const LEGACY_CONFIG_DIR_NAME: &str = "SpotlightSearch";
/// 0.1.2 kept custom themes in Tauri's own app-config folder rather than
/// beside the rest of the state, so upgrades need both sources.
const LEGACY_THEMES_DIR_NAME: &str = "com.umbra.search";
fn base_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
}
/// `%APPDATA%\.Umbra-config` — created the first time it is asked for, not on
/// every call (write_atomic recreates parent folders if they go missing later).
pub fn config_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let dir = base_dir().join(CONFIG_DIR_NAME);
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
    .clone()
}
pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}
pub fn pins_file() -> PathBuf {
    config_dir().join("pins.json")
}
pub fn frecency_file() -> PathBuf {
    config_dir().join("frecency_stats.json")
}
pub fn themes_dir() -> PathBuf {
    let dir = config_dir().join("themes");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
/// Files that used to live in the legacy folder.
const MIGRATED_FILES: &[&str] = &["config.json", "pins.json", "frecency_stats.json"];
/// Moves pre-0.1.3 state into the new folder. Existing files are never
/// overwritten, so re-running is harmless.
pub fn migrate_legacy_config_dir() {
    let legacy = base_dir().join(LEGACY_CONFIG_DIR_NAME);
    if !legacy.is_dir() {
        return;
    }
    for name in MIGRATED_FILES {
        let from = legacy.join(name);
        let to = config_dir().join(name);
        if from.is_file() && !to.exists() {
            let _ = std::fs::copy(&from, &to);
        }
    }
    let legacy_themes = legacy.join("themes");
    let target_themes = themes_dir();
    migrate_themes_from(&legacy_themes, &target_themes);
    // 0.1.2 stored custom themes under Tauri's app-config folder, which is a
    // different directory from the one it used for config/pins/frecency.
    let tauri_themes = base_dir().join(LEGACY_THEMES_DIR_NAME).join("themes");
    migrate_themes_from(&tauri_themes, &target_themes);
}
/// Copies every `.css` file across, never overwriting, so running the
/// migration again after a reinstall cannot clobber newer themes.
fn migrate_themes_from(from: &std::path::Path, to: &std::path::Path) {
    if !from.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_css = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("css"));
        let name = entry.file_name();
        let target = to.join(&name);
        if is_css && path.is_file() && !target.exists() {
            let _ = std::fs::copy(&path, target);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn theme_migration_copies_css_and_never_overwrites() {
        let src = std::env::temp_dir().join(format!("umbra-mig-src-{}", std::process::id()));
        let dst = std::env::temp_dir().join(format!("umbra-mig-dst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("fresh.css"), "from-legacy").unwrap();
        std::fs::write(src.join("notes.txt"), "ignored").unwrap();
        std::fs::write(dst.join("fresh.css"), "already-here").unwrap();
        migrate_themes_from(&src, &dst);
        // .css files are carried over, other files are not
        assert_eq!(std::fs::read_to_string(dst.join("fresh.css")).unwrap(), "already-here");
        assert!(!dst.join("notes.txt").exists());
        std::fs::write(src.join("extra.css"), "second").unwrap();
        migrate_themes_from(&src, &dst);
        assert_eq!(std::fs::read_to_string(dst.join("extra.css")).unwrap(), "second");
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }
    #[test]
    fn every_state_file_lives_in_the_same_config_dir() {
        let dir = config_dir();
        for path in [config_file(), pins_file(), frecency_file(), themes_dir()] {
            assert_eq!(path.parent().unwrap(), dir);
            assert!(
                path.to_string_lossy().contains(CONFIG_DIR_NAME),
                "{path:?} is outside {CONFIG_DIR_NAME}"
            );
        }
    }
}