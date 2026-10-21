use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    #[serde(default)]
    pub theme: ThemeConfig,

    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub pin_x: i32,
    #[serde(default)]
    pub pin_y: i32,

    #[serde(default = "default_align")]
    pub align: String,

    #[serde(default)]
    pub monitor: i32,

    #[serde(default = "default_index_excludes")]
    pub index_excludes: Vec<String>,

    /// Index folders whose name starts with a dot (`.rustup`, `.config`, ...). Off by default.
    #[serde(default)]
    pub index_hidden: bool,

    /// Index the user's `AppData` folder. Off by default.
    #[serde(default)]
    pub index_appdata: bool,

    #[serde(default)]
    pub disabled_kinds: Vec<u8>,

    #[serde(default)]
    pub disabled_drives: Vec<String>,
#[serde(default = "default_language")]
    pub language: String,

    /// Kinds of motion switched off in Settings > Animations. Anything not in
    /// `ANIM_KINDS` is ignored, so an old or hand-edited config cannot make the
    /// frontend set a variable it does not know.
    #[serde(default)]
    pub anim_off: Vec<String>,

    #[serde(default = "default_true")]
    pub autostart: bool,

    /// The first-run setup has been finished (or skipped). A config from before the setup existed
    /// has no such key and counts as done, so an update never starts it; a fresh install starts
    /// with it unfinished, and one that was closed half way shows it again on the next start.
    #[serde(default = "default_true")]
    pub setup_done: bool,

    /// How the preview panel presents itself: `overlay` takes over the results
    /// area, `popup` is a small card by the cursor. A behaviour preference, not
    /// a theme one, so it lives here rather than in `ThemeConfig`.
    #[serde(default = "default_preview_style")]
    pub preview_style: String,

    /// Key combinations the user has changed in Settings > Keybinds, by action id. An action that
    /// is not here keeps the default the frontend declares; the global hotkey has its own field.
    #[serde(default)]
    pub keybinds: std::collections::BTreeMap<String, String>,
}
impl Default for Config {
    fn default() -> Self {
        Config {
            hotkey: default_hotkey(),
            zoom: default_zoom(),
            theme: ThemeConfig::default(),
            pinned: false,
            pin_x: 0,
            pin_y: 0,
            align: default_align(),
            monitor: 0,
            index_excludes: default_index_excludes(),
            index_hidden: false,
            index_appdata: false,
            disabled_kinds: vec![],
            disabled_drives: vec![],
            language: default_language(),
            anim_off: vec![],
            // Off until the setup has asked: nothing registers itself with Windows unasked.
            autostart: false,
            setup_done: false,
            preview_style: default_preview_style(),
            keybinds: Default::default(),
        }
    }
}
fn default_preview_style() -> String {
    "overlay".into()
}
fn default_language() -> String {
    "en".into()
}
pub(crate) const DEFAULT_HOTKEY: &str = "Alt+Space";
fn default_hotkey() -> String {
    DEFAULT_HOTKEY.into()
}
fn default_zoom() -> f64 {
    1.0
}
fn default_true() -> bool {
    true
}
/// Folders that are noise by name wherever they appear. `AppData` and the dot folders are not here:
/// they are the two switches in Settings (`index_appdata`, `index_hidden`). Names as ordinary as
/// `build`, `dist`, `target` or `vendor` are not here either -- they are real folders of real people.
pub(crate) const DEFAULT_INDEX_EXCLUDES: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "$recycle.bin",
    "system volume information",
    "recovery",
    "perflogs",
    "boot",
    "efi",
    "msocache",
    "programdata",
    "node_modules",
    ".git",
];
/// The list that was the default up to 0.2.0. A config that still holds exactly this was never
/// edited by hand, so it moves to the current default instead of keeping the old, wider one.
const OLD_DEFAULT_INDEX_EXCLUDES: &[&str] = &[
    "windows", "program files", "program files (x86)", "$recycle.bin", "system volume information",
    "recovery", "perflogs", "boot", "efi", "msocache", "programdata", "appdata", "node_modules",
    ".git", ".github", "target", "build", "dist", ".vscode", ".idea", "vendor",
];
fn migrate_index_excludes(config: &mut Config) {
    let mut have: Vec<String> = config.index_excludes.iter().map(|s| s.to_lowercase()).collect();
    have.sort();
    let mut old: Vec<String> = OLD_DEFAULT_INDEX_EXCLUDES.iter().map(|s| s.to_string()).collect();
    old.sort();
    if have == old {
        config.index_excludes = default_index_excludes();
    }
}
fn default_index_excludes() -> Vec<String> {
    DEFAULT_INDEX_EXCLUDES
        .iter()
        .map(|s| s.to_string())
        .collect()
}
fn default_align() -> String {
    "cc".into()
}
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeConfig {
    pub accent: String,
    pub card_bg: String,
    pub card_alpha: f64,
    pub radius: u32,
    #[serde(default = "default_density")]
    pub density: String,
    /// The interface font: `wix`, `sn-pro` or `montserrat`, or `sys:<name>` for a font picked with `!font`.
    #[serde(default = "default_font")]
    pub font: String,
    /// Fonts installed on the PC that the user picked with `!font <name>`; each is a choice in
    /// Settings, and `font` is `sys:<name>` while one of them is in use.
    #[serde(default)]
    pub system_fonts: Vec<String>,
    /// Space between result rows and between sections. The density presets set
    /// this too, but the slider writes it inline afterwards, so a chosen value
    /// wins over the density it came from.
    #[serde(default = "default_gap")]
    pub gap: u32,
    /// Experimental: stretch the window down to the bottom of the screen's work area.
    #[serde(default)]
    pub tall_results: bool,
    /// The selected result is always opened up into a large preview card.
    #[serde(default)]
    pub side_preview: bool,
    pub text: String,
    pub glow: bool,
    pub glow_strength: u32,
    /// `#rrggbb` or `#rrggbbaa`; empty means the accent colour.
    #[serde(default)]
    pub glow_color: String,
    #[serde(default = "default_border_on")]
    pub border_on: bool,
    #[serde(default = "default_border_w")]
    pub border_w: f64,
    #[serde(default = "default_border_pos")]
    pub border_pos: String,
    /// `#rrggbb` or `#rrggbbaa`; empty means the theme's own border colour.
    #[serde(default)]
    pub border_color: String,
    /// Where pinned apps live: `list` (under the empty search box) or a dock
    /// column on the `left` / `right` of the window.
    #[serde(default = "default_pins_style")]
    pub pins_style: String,

    #[serde(default)]
    pub light_mode: bool,
    /// Light / dark and the accent colour follow Windows instead of the
    /// colours above (which are kept for when this is turned off).
    #[serde(default)]
    pub follow_system: bool,
    #[serde(default)]
    pub custom_theme: Option<String>,
}
fn default_border_on() -> bool {
    true
}
fn default_border_w() -> f64 {
    1.0
}
fn default_border_pos() -> String {
    "inner".into()
}
fn default_pins_style() -> String {
    "list".into()
}
/// Density presets: `full`, `compact-results`, `compact-full`.
fn default_density() -> String {
    "full".into()
}
fn default_font() -> String {
    "wix".into()
}
/// How many fonts picked with `!font` are kept as choices.
const MAX_SYSTEM_FONTS: usize = 6;
/// A family name that is safe to put inside a CSS `font-family: '…'`: letters, digits, spaces
/// and a few joiners, so it can never close the quote or add a rule.
fn valid_font_family(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n.chars().count() <= 64
        && n.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '+'))
}
fn default_gap() -> u32 {
    12
}
impl Default for ThemeConfig {
    fn default() -> Self {
        ThemeConfig {
            accent: "#507090".into(),
            card_bg: "#1e1e1e".into(),
            card_alpha: 1.0,
            radius: 12,
            density: default_density(),
            font: default_font(),
            system_fonts: Vec::new(),
            gap: default_gap(),
            tall_results: false,
            side_preview: false,
            text: "#e3e3e3".into(),
            glow: false,
            glow_strength: 14,
            border_on: default_border_on(),
            border_w: default_border_w(),
            border_pos: default_border_pos(),
            glow_color: String::new(),
            border_color: String::new(),
            pins_style: default_pins_style(),
            light_mode: false,
            follow_system: false,
            custom_theme: None,
        }
    }
}
impl ThemeConfig {

    pub fn sanitized(mut self) -> Self {
        self.accent = sanitize_hex(&self.accent, "#507090");
        self.card_bg = sanitize_hex(&self.card_bg, "#1e1e1e");
        self.text = sanitize_hex(&self.text, "#e3e3e3");
        if !self.card_alpha.is_finite() {
            self.card_alpha = 1.0;
        }
        self.card_alpha = self.card_alpha.clamp(0.4, 1.0);
        self.radius = self.radius.clamp(0, 24);
        self.gap = self.gap.clamp(0, 24);
        match self.density.as_str() {
            "compact-results" | "compact-full" => {}
            _ => self.density = default_density(),
        }
        let mut kept: Vec<String> = Vec::new();
        for name in self.system_fonts.drain(..) {
            let name = name.trim().to_string();
            if valid_font_family(&name) && !kept.iter().any(|k| k.eq_ignore_ascii_case(&name)) {
                kept.push(name);
            }
        }
        let skip = kept.len().saturating_sub(MAX_SYSTEM_FONTS);
        self.system_fonts = kept.split_off(skip);
        let chosen_system = self
            .font
            .strip_prefix("sys:")
            .is_some_and(|n| self.system_fonts.iter().any(|k| k == n));
        if !chosen_system && !matches!(self.font.as_str(), "wix" | "sn-pro" | "montserrat") {
            self.font = default_font();
        }
        self.glow_strength = self.glow_strength.clamp(0, 40);
        self.glow_color = sanitize_optional_color(&self.glow_color);
        self.border_color = sanitize_optional_color(&self.border_color);
        if !self.border_w.is_finite() {
            self.border_w = 1.0;
        }
        self.border_w = self.border_w.clamp(0.0, 8.0);

        match self.border_pos.as_str() {
            "inner" | "outer" => {}
            _ => self.border_pos = "inner".into(),
        }
        match self.pins_style.as_str() {
            "list" | "left" | "right" => {}
            _ => self.pins_style = default_pins_style(),
        }
        self
    }
}
/// Empty (use the default), `#rrggbb` or `#rrggbbaa`; anything else is dropped.
fn sanitize_optional_color(val: &str) -> String {
    let v = val.trim();
    let ok = v.starts_with('#') && (v.len() == 7 || v.len() == 9) && v[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok { v.to_lowercase() } else { String::new() }
}
fn sanitize_hex(val: &str, fallback: &str) -> String {
    let v = val.trim();
    let ok =
        v.starts_with('#') && v.len() == 7 && v[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        v.to_lowercase()
    } else {
        fallback.to_string()
    }
}
struct ConfigState {
    path: PathBuf,
    config: Config,
}
static STATE: LazyLock<Mutex<Option<ConfigState>>> = LazyLock::new(|| Mutex::new(None));
fn config_path() -> PathBuf {
    crate::paths::config_file()
}
/// Installs from before 0.1.3 stored an empty hotkey, which the keyboard hook
/// cannot use. Replace anything unusable with the default so the file on disk
/// matches what the app actually runs with.
fn normalise_hotkey(config: &mut Config) {
    if !crate::keyboard_hook::is_supported_hotkey(&config.hotkey) {
        config.hotkey = DEFAULT_HOTKEY.to_string();
    }
    config.disabled_drives = normalise_drives(&config.disabled_drives);
    config.disabled_kinds.retain(|k| *k <= 10);
    if !config.zoom.is_finite() {
        config.zoom = 1.0;
    }
}

/// A drive is a letter and a colon. Anything else in the list is a hand-edited
/// mistake, and the indexer matches these as path prefixes -- so a stray value
/// with a multi-byte character in it was enough to panic the watcher.
fn normalise_drives(drives: &[String]) -> Vec<String> {
    drives
        .iter()
        .filter_map(|d| {
            let t = d.trim().trim_end_matches('\\');
            let bytes = t.as_bytes();
            if bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
                Some(t.to_string())
            } else {
                None
            }
        })
        .collect()
}
fn with_state<R>(f: impl FnOnce(&mut ConfigState) -> R) -> R {
    let mut guard = STATE.lock().unwrap();
    let state = guard.get_or_insert_with(|| {
        let path = config_path();
        let mut config: Config = crate::storage::load_json(&path);
        normalise_hotkey(&mut config);
        migrate_index_excludes(&mut config);
        ConfigState { path, config }
    });
    f(state)
}
/// Reads the config under its lock.
fn read<R>(f: impl FnOnce(&Config) -> R) -> R {
    with_state(|state| f(&state.config))
}
/// Changes the config under one lock (so read-modify-write cannot race) and
/// queues it for saving; the disk write happens off the calling thread.
fn update<R>(f: impl FnOnce(&mut Config) -> R) -> R {
    with_state(|state| {
        let out = f(&mut state.config);
        if let Ok(json) = serde_json::to_string_pretty(&state.config) {
            crate::storage::save_later(state.path.clone(), json);
        }
        out
    })
}
/// Writes the config as it is, so a fresh install has a file and the next start
/// is no longer a first run.
pub fn save_defaults() {
    update(|_| ());
}
pub fn get_theme() -> ThemeConfig {
    read(|c| c.theme.clone())
}
pub fn set_theme(theme: ThemeConfig) -> ThemeConfig {
    let clean = theme.sanitized();
    update(|c| c.theme = clean.clone());
    clean
}
pub fn is_pinned() -> bool {
    read(|c| c.pinned)
}
pub fn set_pinned(pinned: bool, x: i32, y: i32) {
    update(|c| {
        c.pinned = pinned;
        c.pin_x = x;
        c.pin_y = y;
    });
}
pub fn pinned_position() -> Option<(i32, i32)> {
    read(|c| c.pinned.then_some((c.pin_x, c.pin_y)))
}
pub fn get_placement() -> (String, i32) {
    read(|c| {
        let align = if is_valid_align(&c.align) {
            c.align.clone()
        } else {
            default_align()
        };
        (align, c.monitor)
    })
}
pub fn is_valid_align(align: &str) -> bool {
    let b = align.as_bytes();
    b.len() == 2 && matches!(b[0], b't' | b'c' | b'b') && matches!(b[1], b'l' | b'c' | b'r')
}
pub fn set_placement(align: String, monitor: i32) {
    update(|c| {
        c.align = align;
        c.monitor = monitor;
    });
}
pub fn get_language() -> String {
    read(|c| match c.language.as_str() {
        "en" | "ru" | "ja" | "de" => c.language.clone(),
        _ => "en".to_string(),
    })
}
pub fn set_language(lang: String) -> String {
    let clean = match lang.to_lowercase().as_str() {
        "ru" => "ru".to_string(),
        "ja" => "ja".to_string(),
        "de" => "de".to_string(),
        _ => "en".to_string(),
    };
    update(|c| c.language = clean.clone());
    clean
}
pub fn get_keybinds() -> std::collections::BTreeMap<String, String> {
    read(|c| c.keybinds.clone())
}
/// Stores the changed combinations. Ids and combinations are short plain strings; anything else
/// (a hand-edited or oversized map) is dropped rather than kept.
pub fn set_keybinds(map: std::collections::BTreeMap<String, String>) -> std::collections::BTreeMap<String, String> {
    let clean = clean_keybinds(map);
    update(|c| c.keybinds = clean.clone());
    clean
}
fn clean_keybinds(map: std::collections::BTreeMap<String, String>) -> std::collections::BTreeMap<String, String> {
    map.into_iter()
        .filter(|(k, v)| {
            !k.is_empty()
                && k.len() <= 32
                && !v.is_empty()
                && v.len() <= 40
                && k.chars().all(|c| c.is_ascii_alphanumeric())
                && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '+')
        })
        .take(64)
        .collect()
}
pub fn get_setup_done() -> bool {
    read(|c| c.setup_done)
}
pub fn set_setup_done(done: bool) {
    update(|c| c.setup_done = done);
}
pub fn get_autostart() -> bool {
    read(|c| c.autostart)
}
pub fn set_autostart(enable: bool) {
    update(|c| c.autostart = enable);
}
pub fn get_preview_style() -> String {
    read(|c| match c.preview_style.as_str() {
        "popup" => "popup".to_string(),
        _ => default_preview_style(),
    })
}
pub fn set_preview_style(style: &str) -> String {
    let clean = if style == "popup" {
        "popup".to_string()
    } else {
        default_preview_style()
    };
    update(|c| c.preview_style = clean.clone());
    clean
}
pub fn get_hotkey() -> String {
    read(|c| c.hotkey.clone())
}
pub fn set_hotkey(key: &str) {
    update(|c| c.hotkey = key.to_string());
}
pub fn get_zoom() -> f64 {
    read(|c| if c.zoom.is_finite() && c.zoom > 0.0 { c.zoom } else { 1.0 })
}
pub fn set_zoom(zoom: f64) {
    // `clamp` hands back NaN for NaN, and serde writes that as `null`, which
    // then fails to parse as an f64 -- so one bad value took the whole config
    // file down with it, theme, language, hotkey and all.
    let z = if zoom.is_finite() { zoom.clamp(0.5, 2.0) } else { 1.0 };
    update(|c| c.zoom = z);
}
pub fn get_index_excludes() -> Vec<String> {
    read(|c| c.index_excludes.clone())
}
/// Marker in the skip set meaning "skip every name that starts with a dot".
pub(crate) const SKIP_DOT_NAMES: &str = ".*";
/// What the indexer leaves out by name: the exclude list, plus `AppData` and the dot folders
/// unless Settings turned them on.
pub fn index_skip_set() -> std::collections::HashSet<String> {
    read(|c| skip_set_for(&c.index_excludes, c.index_hidden, c.index_appdata))
}
fn skip_set_for(excludes: &[String], hidden: bool, appdata: bool) -> std::collections::HashSet<String> {
    let mut set: std::collections::HashSet<String> = excludes.iter().map(|s| s.to_lowercase()).collect();
    if appdata {
        set.remove("appdata");
    } else {
        set.insert("appdata".into());
    }
    if !hidden {
        set.insert(SKIP_DOT_NAMES.into());
    }
    set
}
#[derive(Serialize)]
pub struct IndexOptions {
    pub hidden: bool,
    pub appdata: bool,
}
pub fn get_index_options() -> IndexOptions {
    read(|c| IndexOptions { hidden: c.index_hidden, appdata: c.index_appdata })
}
/// Turns one of the two index switches (`hidden`, `appdata`) on or off.
pub fn set_index_option(name: &str, on: bool) -> IndexOptions {
    update(|c| match name {
        "hidden" => c.index_hidden = on,
        "appdata" => c.index_appdata = on,
        _ => {}
    });
    get_index_options()
}
pub fn get_disabled_kinds() -> Vec<u8> {
    read(|c| c.disabled_kinds.clone())
}
/// Turns one file kind on or off and returns the new disabled list.
pub fn set_kind_enabled(kind: u8, enabled: bool) -> Vec<u8> {
    update(|c| {
        let kinds = &mut c.disabled_kinds;
        if enabled {
            kinds.retain(|&k| k != kind);
        } else if kind <= 10 && !kinds.contains(&kind) {
            kinds.push(kind);
        }
        kinds.sort();
        kinds.dedup();
        kinds.clone()
    })
}
pub fn get_disabled_drives() -> Vec<String> {
    read(|c| normalise_drives(&c.disabled_drives))
}

/// The kinds of motion Settings > Animations can switch off. The names match
/// the `--t-*` duration variables the stylesheet reads. The looping animations
/// (icon placeholders, the indexing spinner, the eyedropper loupe) are not here
/// on purpose: they are the only motion that tells the user something is still
/// happening, so they stay on.
pub const ANIM_KINDS: [&str; 6] = ["blur", "fade", "move", "size", "color", "glow"];

pub fn get_anim_off() -> Vec<String> {
    read(|c| c.anim_off.clone())
}

/// Switches one kind of motion off or on and returns the new list.
pub fn set_anim_off(kind: String, off: bool) -> Vec<String> {
    update(|c| {
        let list = &mut c.anim_off;
        if off {
            if ANIM_KINDS.contains(&kind.as_str()) && !list.contains(&kind) {
                list.push(kind);
            }
        } else {
            list.retain(|k| k != &kind);
        }
        list.sort();
        list.dedup();
        list.clone()
    })
}
/// Turns one drive on or off and returns the new disabled list.
pub fn set_drive_enabled(drive: &str, enabled: bool) -> Vec<String> {
    let d = drive.trim().to_uppercase();
    update(|c| {
        let drives = &mut c.disabled_drives;
        if enabled {
            drives.retain(|x| x != &d);
        } else if !d.is_empty() && !drives.contains(&d) {
            drives.push(d);
        }
        drives.sort();
        drives.dedup();
        drives.clone()
    })
}
#[cfg(test)]
mod tests {
    #[test]
    fn keybinds_keep_only_plain_ids_and_combinations() {
        let mut m = std::collections::BTreeMap::new();
        m.insert("previewFull".to_string(), "Ctrl+Shift+F".to_string());
        m.insert("bad id".to_string(), "Ctrl+A".to_string());
        m.insert("pin".to_string(), "Ctrl+<script>".to_string());
        m.insert("reveal".to_string(), String::new());
        let clean = super::clean_keybinds(m);
        assert_eq!(clean.len(), 1);
        assert_eq!(clean["previewFull"], "Ctrl+Shift+F");
    }
    #[test]
    fn a_config_without_keybinds_has_none() {
        let cfg: super::Config = serde_json::from_str("{}").unwrap();
        assert!(cfg.keybinds.is_empty());
    }
    use super::*;
    #[test]
    fn default_excludes_keep_ordinary_folder_names_searchable() {
        for name in ["build", "dist", "target", "vendor", ".github", ".vscode", ".idea", "appdata"] {
            assert!(!DEFAULT_INDEX_EXCLUDES.contains(&name), "{name} should not be excluded by default");
        }
        for name in ["node_modules", ".git", "windows", "program files", "$recycle.bin"] {
            assert!(DEFAULT_INDEX_EXCLUDES.contains(&name), "{name} should stay excluded");
        }
    }
    #[test]
    fn an_untouched_old_default_list_moves_to_the_new_one() {
        let mut old = Config { index_excludes: OLD_DEFAULT_INDEX_EXCLUDES.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        migrate_index_excludes(&mut old);
        assert_eq!(old.index_excludes, default_index_excludes());
        let mut mine = Config { index_excludes: vec!["windows".into(), "my stuff".into()], ..Default::default() };
        migrate_index_excludes(&mut mine);
        assert_eq!(mine.index_excludes, vec!["windows".to_string(), "my stuff".to_string()]);
    }
    #[test]
    fn appdata_and_dot_folders_follow_their_switches() {
        let list = default_index_excludes();
        let off = skip_set_for(&list, false, false);
        assert!(off.contains("appdata") && off.contains(SKIP_DOT_NAMES));
        let on = skip_set_for(&list, true, true);
        assert!(!on.contains("appdata") && !on.contains(SKIP_DOT_NAMES));
        assert!(on.contains(".git") && on.contains("node_modules"), "the plain list still applies");
        let old_config = skip_set_for(&["appdata".to_string()], false, true);
        assert!(!old_config.contains("appdata"), "the switch wins over an old list entry");
    }
    #[test]
    fn align_validation_rejects_bad_values_without_panicking() {
        for ok in ["tl", "cc", "br", "tc"] {
            assert!(is_valid_align(ok), "{ok}");
        }
        for bad in ["", "c", "ccc", "xx", "яя", "cя", "CC"] {
            assert!(!is_valid_align(bad), "{bad}");
        }
    }
    #[test]
    fn unusable_hotkeys_are_replaced_with_the_default() {
        let missing: Config = serde_json::from_str(r#"{"zoom": 1.0}"#).unwrap();
        assert_eq!(missing.hotkey, DEFAULT_HOTKEY, "missing field");
        let mut empty: Config = serde_json::from_str(r#"{"hotkey": "", "zoom": 1.0}"#).unwrap();
        normalise_hotkey(&mut empty);
        assert_eq!(empty.hotkey, DEFAULT_HOTKEY, "empty string from 0.1.2");
        let mut junk: Config = serde_json::from_str(r#"{"hotkey": "Ctrl+-", "zoom": 1.0}"#).unwrap();
        normalise_hotkey(&mut junk);
        assert_eq!(junk.hotkey, DEFAULT_HOTKEY, "unhookable combo");
        let mut good: Config =
            serde_json::from_str(r#"{"hotkey": "Ctrl+Shift+P", "zoom": 1.0}"#).unwrap();
        normalise_hotkey(&mut good);
        assert_eq!(good.hotkey, "Ctrl+Shift+P", "valid hotkey is kept");
    }
    #[test]
    fn autostart_preference_defaults_to_on_and_is_remembered() {
        let old: Config = serde_json::from_str(r#"{"hotkey": "Alt+Space", "zoom": 1.0}"#).unwrap();
        assert!(old.autostart);
        let off: Config =
            serde_json::from_str(r#"{"hotkey": "Alt+Space", "zoom": 1.0, "autostart": false}"#).unwrap();
        assert!(!off.autostart);
        let roundtrip: Config = serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();
        assert!(!roundtrip.autostart);
    }
    #[test]
    fn setup_counts_as_done_for_old_configs_and_not_for_a_fresh_one() {
        let old: Config = serde_json::from_str(r#"{"hotkey": "Alt+Space", "zoom": 1.0}"#).unwrap();
        assert!(old.setup_done, "an update must not start the setup");
        assert!(old.autostart, "and must not turn autostart off");
        let fresh = Config::default();
        assert!(!fresh.setup_done);
        assert!(!fresh.autostart, "a fresh install registers nothing before it is asked");
        let done: Config = serde_json::from_str(&serde_json::to_string(&fresh).unwrap()).unwrap();
        assert!(!done.setup_done, "the flag is written out and read back");
    }
    #[test]
    fn density_keeps_known_modes_and_falls_back_to_full() {
        for mode in ["full", "compact-results", "compact-full"] {
            let theme = ThemeConfig {
                density: mode.into(),
                ..Default::default()
            };
            assert_eq!(theme.sanitized().density, mode);
        }
        let bogus = ThemeConfig {
            density: "nonsense".into(),
            ..Default::default()
        };
        assert_eq!(bogus.sanitized().density, "full");
    }
    #[test]
    fn font_keeps_known_choices_and_falls_back_to_the_default() {
        for font in ["wix", "sn-pro", "montserrat"] {
            let theme = ThemeConfig {
                font: font.into(),
                ..Default::default()
            };
            assert_eq!(theme.sanitized().font, font);
        }
        let bogus = ThemeConfig {
            font: "comic-sans".into(),
            ..Default::default()
        };
        assert_eq!(bogus.sanitized().font, "wix");
        // Stolzl was bundled before; a config that still names it moves to the default.
        let legacy = ThemeConfig {
            font: "stolzl".into(),
            ..Default::default()
        };
        assert_eq!(legacy.sanitized().font, "wix");
        let old: ThemeConfig = serde_json::from_str(r#"{"density": "full"}"#).unwrap();
        assert_eq!(old.font, "wix");
    }
    #[test]
    fn system_fonts_are_checked_and_capped() {
        let theme = ThemeConfig {
            font: "sys:Segoe UI".into(),
            system_fonts: vec!["Segoe UI".into(), "segoe ui".into(), "Bad'; } body{".into(), "Consolas".into()],
            ..Default::default()
        }
        .sanitized();
        assert_eq!(theme.system_fonts, vec!["Segoe UI", "Consolas"]);
        assert_eq!(theme.font, "sys:Segoe UI");
        let gone = ThemeConfig {
            font: "sys:Arial".into(),
            system_fonts: vec!["Consolas".into()],
            ..Default::default()
        }
        .sanitized();
        assert_eq!(gone.font, "wix");
        let many = ThemeConfig {
            system_fonts: (0..9).map(|i| format!("Font {i}")).collect(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(many.system_fonts.len(), 6);
        assert_eq!(many.system_fonts[5], "Font 8");
    }
    #[test]
    fn side_preview_defaults_off_and_uses_the_camel_case_key() {
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert!(!cfg.theme.side_preview);
        let on: ThemeConfig = serde_json::from_str(r#"{"sidePreview": true}"#).unwrap();
        assert!(on.side_preview);
        assert!(serde_json::to_string(&on).unwrap().contains(r#""sidePreview":true"#));
    }
    #[test]
    fn tall_results_defaults_off_and_uses_the_camel_case_key() {
        let cfg: Config = serde_json::from_str(r#"{"theme": {"density": "full"}}"#).unwrap();
        assert!(!cfg.theme.tall_results);
        let on: ThemeConfig = serde_json::from_str(r#"{"tallResults": true}"#).unwrap();
        assert!(on.tall_results);
        assert!(serde_json::to_string(&on).unwrap().contains(r#""tallResults":true"#));
    }
    #[test]
    fn corner_radius_goes_down_to_a_square_card() {
        assert_eq!(ThemeConfig { radius: 0, ..Default::default() }.sanitized().radius, 0);
        assert_eq!(ThemeConfig { radius: 2, ..Default::default() }.sanitized().radius, 2);
        // Still bounded above, so a hand-edited config cannot make it silly.
        assert_eq!(ThemeConfig { radius: 99, ..Default::default() }.sanitized().radius, 24);
    }
    #[test]
    fn glow_and_border_colours_are_optional_hex_with_alpha() {
        let t = ThemeConfig { glow_color: "#FF00AA80".into(), border_color: "red".into(), ..Default::default() }.sanitized();
        assert_eq!(t.glow_color, "#ff00aa80");
        assert_eq!(t.border_color, "");
        let old: Config = serde_json::from_str(r#"{"theme": {"radius": 12}}"#).unwrap();
        assert_eq!(old.theme.glow_color, "");
    }
    #[test]
    fn row_spacing_is_clamped_and_survives_an_old_config() {
        assert_eq!(ThemeConfig { gap: 0, ..Default::default() }.sanitized().gap, 0);
        assert_eq!(ThemeConfig { gap: 40, ..Default::default() }.sanitized().gap, 24);
        // Written before the slider existed: the default has to fill it in.
        let cfg: Config = serde_json::from_str(r#"{"theme": {"radius": 12}}"#).unwrap();
        assert_eq!(cfg.theme.gap, 12);
    }
    #[test]
    fn only_known_animation_kinds_are_kept() {
        // set_anim_off goes through update(), which writes the file, so the
        // validation itself is what matters here: a kind the frontend does not
        // know would set a variable nothing reads.
        assert!(ANIM_KINDS.contains(&"blur"));
        assert!(!ANIM_KINDS.contains(&"wobble"));
        // The looping animations are permanent, so they are not switchable.
        assert!(!ANIM_KINDS.contains(&"pulse"));
        assert_eq!(ANIM_KINDS.len(), 6);
    }
    #[test]
    fn a_config_written_before_density_existed_still_loads() {
        // 0.1.3 and earlier stored `cardH`; it is gone, and the replacement
        // must fall back to the default rather than failing to parse.
        let cfg: Config = serde_json::from_str(r#"{"cardH": 64, "zoom": 1.0}"#).unwrap();
        assert_eq!(cfg.theme.density, "full");
    }
    #[test]
    fn pins_style_defaults_to_the_list_and_rejects_unknown_values() {
        let cfg: Config = serde_json::from_str(r#"{"theme": {}}"#).unwrap();
        assert_eq!(cfg.theme.pins_style, "list");
        for side in ["list", "left", "right"] {
            let theme: ThemeConfig = serde_json::from_str(&format!(r#"{{"pinsStyle": "{side}"}}"#)).unwrap();
            assert_eq!(theme.sanitized().pins_style, side);
        }
        let bogus: ThemeConfig = serde_json::from_str(r#"{"pinsStyle": "top"}"#).unwrap();
        assert_eq!(bogus.sanitized().pins_style, "list");
    }
}
