use crate::config;
use crate::frecency;
use crate::indexer::{with_entries, SearchEntry, KIND_APP, KIND_SHORTCUT};
use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
pub static SEARCH_VERSION: AtomicU32 = AtomicU32::new(0);
pub fn is_current(version: u32) -> bool {
    SEARCH_VERSION.load(Ordering::SeqCst) == version
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, serde::Serialize)]
pub struct ScoreKey {
    /// 0..1000 for results opened before under this very query (lower = picked
    /// more), 1000 for the rest; ranks above everything else (see picks.rs).
    pub pick_inv: u32,
    /// How well the name matches, coarsely: 0 starts with the query (or a word in
    /// it does), 1 has it somewhere inside, 2 only a typo away. It ranks above the
    /// kind of item, so a shortcut that merely resembles the query can no longer
    /// sit above a program whose name starts with it.
    pub class: u32,
    pub tier: u32,
    pub primary: u32,
    pub frec_inv: u32,
    pub len: u32,
    pub path_len: u32,
}
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub icon: String,
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    #[serde(skip)]
    pub score: ScoreKey,
}
const EN_TO_RU: &[(char, char)] = &[
    ('q', '\u{0439}'), ('w', '\u{0446}'), ('e', '\u{0443}'), ('r', '\u{043A}'),
    ('t', '\u{0435}'), ('y', '\u{043D}'), ('u', '\u{0433}'), ('i', '\u{0448}'),
    ('o', '\u{0449}'), ('p', '\u{0437}'), ('[', '\u{0445}'), (']', '\u{044A}'),
    ('a', '\u{0444}'), ('s', '\u{044B}'), ('d', '\u{0432}'), ('f', '\u{0430}'),
    ('g', '\u{043F}'), ('h', '\u{0440}'), ('j', '\u{043E}'), ('k', '\u{043B}'),
    ('l', '\u{0434}'), (';', '\u{0436}'), ('\'', '\u{044D}'),
    ('z', '\u{044F}'), ('x', '\u{0447}'), ('c', '\u{0441}'), ('v', '\u{043C}'),
    ('b', '\u{0438}'), ('n', '\u{0442}'), ('m', '\u{044C}'),
    (',', '\u{0431}'), ('.', '\u{044E}'),
];
const RU_TRANSLIT: &[(char, &str)] = &[
    ('\u{0430}', "a"), ('\u{0431}', "b"), ('\u{0432}', "v"), ('\u{0433}', "g"),
    ('\u{0434}', "d"), ('\u{0435}', "e"), ('\u{0451}', "yo"), ('\u{0436}', "zh"),
    ('\u{0437}', "z"), ('\u{0438}', "i"), ('\u{0439}', "y"), ('\u{043A}', "k"),
    ('\u{043B}', "l"), ('\u{043C}', "m"), ('\u{043D}', "n"), ('\u{043E}', "o"),
    ('\u{043F}', "p"), ('\u{0440}', "r"), ('\u{0441}', "s"), ('\u{0442}', "t"),
    ('\u{0443}', "u"), ('\u{0444}', "f"), ('\u{0445}', "h"), ('\u{0446}', "ts"),
    ('\u{0447}', "ch"), ('\u{0448}', "sh"), ('\u{0449}', "shch"), ('\u{044A}', ""),
    ('\u{044B}', "y"), ('\u{044C}', ""), ('\u{044D}', "e"), ('\u{044E}', "yu"),
    ('\u{044F}', "ya"),
];
fn get_search_variants(q: &str) -> Vec<String> {
    let mut variants = vec![q.to_string()];
    let lower: String = q.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect();
    let v1: String = lower
        .chars()
        .map(|c| EN_TO_RU.iter().find(|&&(en, _)| en == c).map(|&(_, ru)| ru).unwrap_or(c))
        .collect();
    if !variants.contains(&v1) {
        variants.push(v1);
    }
    let v2: String = lower
        .chars()
        .map(|c| EN_TO_RU.iter().find(|&&(_, ru)| ru == c).map(|&(en, _)| en).unwrap_or(c))
        .collect();
    if !variants.contains(&v2) {
        variants.push(v2);
    }
    let v3: String = lower
        .chars()
        .map(|c| match RU_TRANSLIT.iter().find(|&&(ru, _)| ru == c) {
            Some(&(_, tr)) => tr.to_string(),
            None => c.to_string(),
        })
        .collect();
    if !variants.contains(&v3) {
        variants.push(v3);
    }
    let mut ru_from_en: std::collections::HashMap<char, char> = std::collections::HashMap::new();
    for &(ru, tr) in RU_TRANSLIT {
        let mut it = tr.chars();
        if let (Some(first), None) = (it.next(), it.next()) {
            ru_from_en.entry(first).or_insert(ru);
        }
    }
    let v4: String = lower
        .chars()
        .map(|c| *ru_from_en.get(&c).unwrap_or(&c))
        .collect();
    if !variants.contains(&v4) {
        variants.push(v4);
    }
    variants
}
/// Levenshtein distance between two char slices, or None once it must exceed
/// `max`. `prev` / `cur` are scratch rows reused across calls.
fn lev_dist(a: &[char], b: &[char], max: usize, prev: &mut Vec<usize>, cur: &mut Vec<usize>) -> Option<usize> {
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) > max {
        return None;
    }
    prev.clear();
    prev.extend(0..=m);
    cur.clear();
    cur.resize(m + 1, 0);
    for i in 1..=n {
        cur[0] = i;
        let mut min_row = cur[0];
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            min_row = min_row.min(cur[j]);
        }
        if min_row > max {
            return None;
        }
        std::mem::swap(prev, cur);
    }
    let d = prev[m];
    if d <= max { Some(d) } else { None }
}
/// One spelling of the query (as typed, other keyboard layout, ...), with its
/// chars and char counts worked out once per search instead of once per entry.
struct Variant {
    text: String,
    chars: Vec<char>,
    table: Vec<(char, i32)>,
}
impl Variant {
    fn new(text: String) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut table: Vec<(char, i32)> = Vec::new();
        for &c in &chars {
            match table.iter_mut().find(|(ch, _)| *ch == c) {
                Some(entry) => entry.1 += 1,
                None => table.push((c, 1)),
            }
        }
        Variant { text, chars, table }
    }
}
fn shared_chars(name: &[char], table: &[(char, i32)], counts: &mut Vec<(char, i32)>) -> i32 {
    counts.clear();
    counts.extend_from_slice(table);
    let mut shared = 0i32;
    for c in name {
        if let Some(entry) = counts.iter_mut().find(|(ch, _)| ch == c) {
            if entry.1 > 0 {
                entry.1 -= 1;
                shared += 1;
            }
        }
    }
    shared
}
/// Per-thread buffers for the fuzzy pass: it runs on hundreds of thousands of
/// names per keystroke, and allocating a String per comparison window used to
/// dominate the time.
#[derive(Default)]
struct FuzzyScratch {
    name: Vec<char>,
    prev: Vec<usize>,
    cur: Vec<usize>,
    counts: Vec<(char, i32)>,
}
thread_local! {
    static SCRATCH: std::cell::RefCell<FuzzyScratch> = std::cell::RefCell::new(FuzzyScratch::default());
}
fn is_fuzzy_match(name: &str, variants: &[Variant], max_dist: usize) -> Option<usize> {
    SCRATCH.with(|scratch| {
        let scratch = &mut *scratch.borrow_mut();
        let FuzzyScratch { name: name_chars, prev, cur, counts } = scratch;
        name_chars.clear();
        name_chars.extend(name.chars());
        let mut best: Option<usize> = None;
        for v in variants {
            let wlen = v.chars.len();
            if wlen < 3 { continue; }
            if let Some(d) = lev_dist(name_chars, &v.chars, max_dist, prev, cur) {
                best = Some(best.map_or(d, |b| b.min(d)));
                if best == Some(1) { return best; }
            }
            if name_chars.len() > wlen
                && shared_chars(name_chars, &v.table, counts) >= wlen as i32 - max_dist as i32
            {
                // Compare the query against every substring of the same length
                // and one char shorter / longer (a missing or extra letter).
                for wl in [wlen, wlen + 1, wlen - 1] {
                    if wl == 0 || name_chars.len() < wl { continue; }
                    for start in 0..=name_chars.len() - wl {
                        let window = &name_chars[start..start + wl];
                        if let Some(d) = lev_dist(window, &v.chars, max_dist, prev, cur) {
                            best = Some(best.map_or(d, |b| b.min(d)));
                            if best == Some(1) { return best; }
                        }
                    }
                }
            }
        }
        best
    })
}
fn match_score(
    e: &SearchEntry,
    q: &str,
    variants: &[Variant],
    frec: &std::collections::HashMap<String, f64>,
    picks: &std::collections::HashMap<String, f64>,
    fuzzy_deadline: std::time::Instant,
) -> Option<ScoreKey> {
    let name = e.name_lower.as_ref();
    let primary = if name == q {
        0u32
    } else if variants.iter().any(|v| name == v.text) {
        1
    } else if name.starts_with(q) {
        2
    } else if variants.iter().any(|v| name.starts_with(v.text.as_str())) {
        3
    } else if variants.iter().any(|v| contains_at_word_start(name, &v.text)) {
        // "chrome" in "google chrome": as good as a prefix for a launcher.
        4
    } else if variants.iter().any(|v| name.contains(v.text.as_str())) {
        5
    } else {
        // Up to four letters, one typo is a quarter of the word: "anti" then
        // matched "tabtip", "rmactivate" and "compilation". Typos are only
        // forgiven from five letters on.
        let q_len = q.chars().count();
        let max_dist = if q_len <= 4 {
            0
        } else if q_len <= 7 {
            1
        } else {
            2
        };
        if max_dist == 0 {
            return None;
        }
        if std::time::Instant::now() > fuzzy_deadline {
            return None;
        }
        if is_fuzzy_match(name, variants, max_dist).is_some() {
            PRIMARY_FUZZY
        } else {
            return None;
        }
    };
    let class = match primary {
        0..=4 => 0,
        5 => 1,
        _ => 2,
    };

    let ext = std::path::Path::new(&e.path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_exe = ext == "exe";
    let is_program = e.kind == KIND_APP || e.kind == KIND_SHORTCUT;
    // Installers and uninstallers are programs nobody is looking for when they
    // type the program's name; they go with the plain files.
    let tier: u32 = if is_program && is_setup_or_uninstaller(&e.path) {
        2
    } else if is_program && !is_exe {
        0
    } else if is_exe {
        1
    } else {
        2
    };
    let frec_score = frec.get(&e.path).copied().unwrap_or(0.0).clamp(0.0, 1000.0);
    let frec_inv = ((1000.0 - frec_score) * 10.0) as u32;

    let pick_inv = match picks.get(&e.path) {
        Some(&w) => (1000.0 - (w * 100.0).clamp(1.0, 999.0)) as u32,
        None => 1000,
    };
    let len = (e.name_lower.chars().count() as u32).min(9999);
    let path_len = (e.path.chars().count() as u32).min(9999);
    Some(ScoreKey { pick_inv, class, tier, primary, frec_inv, len, path_len })
}
/// `needle` occurs in `name` at the start of a word: at the very start, or after
/// a space, dash, dot or other non-alphanumeric character.
fn contains_at_word_start(name: &str, needle: &str) -> bool {
    !needle.is_empty()
        && name
            .match_indices(needle)
            .any(|(i, _)| name[..i].chars().next_back().map_or(true, |c| !c.is_alphanumeric()))
}
/// `unins000.exe`, `Uninstall Foo.lnk`, `FooSetup-x64.exe`, `installer.exe`.
pub(crate) fn is_setup_or_uninstaller(path: &str) -> bool {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase();
    file.starts_with("unins") || file.contains("uninstall") || file.contains("setup") || file.contains("installer")
}
/// Always this many results when there are that many matches...
const MIN_RESULTS: usize = 30;
/// ...and past that, more while they are real matches (the name contains the query), up to this
/// many. Typo matches never extend the list.
const MAX_RESULTS: usize = 120;
/// `ScoreKey::primary` of a typo match; everything below it contains or starts with the query.
const PRIMARY_FUZZY: u32 = 6;
const FUZZY_BUDGET_MS: u64 = 250;
/// Whether `path` lies under `prefix` (`D:\`), ignoring ASCII case. Compared as
/// bytes, so a prefix length that falls inside a multi-byte character is fine.
fn under_prefix(path: &str, prefix: &str) -> bool {
    path.len() >= prefix.len() && path.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}
/// `prefix`, when given, keeps the results to paths under it (a drive scope).
pub fn search_index(query: &str, version: u32, prefix: Option<&str>) -> Vec<SearchResult> {
    let q = query.to_lowercase();
    if q.is_empty() || !is_current(version) {
        return Vec::new();
    }
    let variants: Vec<Variant> = get_search_variants(&q).into_iter().map(Variant::new).collect();

    let frec = frecency::scores_snapshot();
    let picks = crate::picks::for_query(query);
    let fuzzy_deadline = std::time::Instant::now() + std::time::Duration::from_millis(FUZZY_BUDGET_MS);

    let disabled_kinds = config::get_disabled_kinds();

    with_entries(|entries| {
        let mut picked: Vec<(ScoreKey, usize)> = entries
            .par_iter()
            .enumerate()
            .filter(|(_, e)| !disabled_kinds.contains(&e.kind))
            .filter(|(_, e)| prefix.map_or(true, |p| under_prefix(&e.path, p)))
            .filter_map(|(i, e)| {
                if !is_current(version) {
                    return None;
                }
                match_score(e, &q, &variants, &frec, &picks, fuzzy_deadline).map(|score| (score, i))
            })
            .collect();
        if !is_current(version) {
            return Vec::new();
        }
        picked.sort_unstable();
        let mut deduplicated = Vec::with_capacity(MAX_RESULTS);
        let mut seen_apps = std::collections::HashSet::new();
        for (score, i) in picked {
            if let Some(e) = entries.get(i) {
                if e.kind == crate::indexer::KIND_APP || e.kind == crate::indexer::KIND_SHORTCUT {
                    // One row per program as the user sees it. The internal name
                    // can differ for the same program -- the registry calls it
                    // "antigravity 2.15.1", the Start Menu "antigravity" -- and
                    // both came out as two rows reading "Antigravity". The best
                    // ranked one stays.
                    let shown = crate::indexer::derive_display_name(&e.path, e.kind).to_lowercase();
                    if !seen_apps.insert(shown) {
                        continue;
                    }
                }

                if deduplicated.len() >= MIN_RESULTS && score.primary >= PRIMARY_FUZZY {
                    continue;
                }
                let mut r = crate::indexer::entry_to_result(e);
                r.score = score;
                deduplicated.push(r);
                if deduplicated.len() >= MAX_RESULTS {
                    break;
                }
            }
        }
        deduplicated
    })
    .unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::{INDEX, KIND_APP, KIND_DOCUMENT, KIND_FILE, KIND_FOLDER, KIND_IMAGE};
    fn entry(name: &str, path: &str, kind: u8) -> SearchEntry {
        SearchEntry {
            name_lower: name.to_lowercase().into_boxed_str(),
            path: path.to_string(),
            kind,
        }
    }
    fn bench_names() -> Vec<String> {
        let stems = ["IMG_2024", "отчёт_по_проекту", "setup_x64_v", "photo_vacation", "invoice-final", "node_modules_cache", "Screenshot 2025-", "документ", "readme", "spotify_launcher"];
        (0..300_000).map(|i| format!("{}{}_{}", stems[i % stems.len()], i, i % 97).to_lowercase()).collect()
    }
    fn bench_variants(q: &str) -> Vec<Variant> {
        get_search_variants(q).into_iter().map(Variant::new).collect()
    }
    #[test]
    #[ignore]
    fn bench_fuzzy() {
        let names = bench_names();
        for q in ["spotfy", "pohotoshop", "invocie", "скриншот"] {
            let variants = bench_variants(q);
            let max = if q.chars().count() <= 6 { 1 } else { 2 };
            let t = std::time::Instant::now();
            let hits = names.iter().filter(|n| is_fuzzy_match(n, &variants, max).is_some()).count();
            println!("BENCH {q}: {hits} hits in {:?}", t.elapsed());
        }
    }
    /// Ranks `entries` for `q` the way search_index does, without the shared index.
    fn ranked(q: &str, entries: &[SearchEntry]) -> Vec<String> {
        let variants = bench_variants(q);
        let none = std::collections::HashMap::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut scored: Vec<(ScoreKey, &str)> = entries
            .iter()
            .filter_map(|e| match_score(e, q, &variants, &none, &none, deadline).map(|s| (s, e.path.as_str())))
            .collect();
        scored.sort();
        scored.into_iter().map(|(_, p)| p.to_string()).collect()
    }
    #[test]
    fn typing_anti_finds_antigravity_and_nothing_that_only_resembles_it() {
        use crate::indexer::KIND_SHORTCUT;
        let entries = vec![
            entry("komori - compilation #2 - shortcut", "D:\\skins\\Komori - Compilation #2 - Shortcut.lnk", KIND_SHORTCUT),
            entry("tabtip", "C:\\ink\\TabTip.exe", KIND_APP),
            entry("rmactivate", "C:\\Windows\\System32\\RMActivate.exe", KIND_APP),
            entry("uninstall antigravity", "C:\\sm\\Uninstall Antigravity.lnk", KIND_APP),
            entry("antigravity-x64", "D:\\Downloads\\Antigravity-x64.exe", KIND_APP),
            entry("antigravity", "C:\\sm\\Antigravity.lnk", KIND_APP),
            entry("antigravity notes.txt", "D:\\antigravity notes.txt", KIND_DOCUMENT),
        ];
        assert_eq!(
            ranked("anti", &entries),
            vec![
                "C:\\sm\\Antigravity.lnk",
                "D:\\Downloads\\Antigravity-x64.exe",
                "D:\\antigravity notes.txt",
                "C:\\sm\\Uninstall Antigravity.lnk",
            ],
            "four letters forgive no typo, and the uninstaller ranks with the files"
        );
        // From five letters on a typo is forgiven, but such a match comes after every real one.
        let typo = ranked("antigarvity", &entries);
        assert_eq!(typo.first().map(String::as_str), Some("C:\\sm\\Antigravity.lnk"));
    }
    #[test]
    fn a_word_inside_the_name_counts_like_a_prefix() {
        let entries = vec![
            entry("chrome_setup.log", "C:\\logs\\chrome_setup.log", KIND_FILE),
            entry("google chrome", "C:\\sm\\Google Chrome.lnk", KIND_APP),
        ];
        assert_eq!(ranked("chrome", &entries)[0], "C:\\sm\\Google Chrome.lnk");
        assert!(contains_at_word_start("google chrome", "chrome"));
        assert!(!contains_at_word_start("rmactivate", "act"));
        assert!(is_setup_or_uninstaller("C:\\x\\unins000.exe"));
        assert!(is_setup_or_uninstaller("D:\\t\\AntigravitySetup-stable.exe"));
        assert!(!is_setup_or_uninstaller("C:\\x\\Antigravity.exe"));
    }
    #[test]
    fn search_finds_matches_and_is_fast() {
        SEARCH_VERSION.store(0, Ordering::SeqCst);
        let mut entries = vec![
            entry("chrome", "C:\\apps\\chrome.exe", KIND_APP),
            entry("google chrome", "C:\\sm\\google chrome.lnk", KIND_APP),
            entry("photoshop", "C:\\sm\\photoshop.lnk", KIND_APP),
            entry("spotify", "C:\\sm\\spotify.lnk", KIND_APP),
            entry("documents", "C:\\Users\\x\\Documents", KIND_FOLDER),
            entry("vacation photo", "C:\\pics\\vacation.jpg", KIND_IMAGE),
            entry("москва", "C:\\docs\\москва.txt", KIND_DOCUMENT),
            entry("chrome notes.txt", "d:\\Заметки\\chrome notes.txt", KIND_DOCUMENT),
        ];

        for i in 0..300_000 {
            entries.push(entry(
                &format!("отчёт по проекту номер {} — итоговая версия (2)", i),
                &format!("C:\\data\\отчёт_{}_итоговая_версия.dat", i),
                KIND_FILE,
            ));
        }
        let _ = INDEX.set(std::sync::RwLock::new(entries));
        SEARCH_VERSION.store(1, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r = search_index("chrome", 1, None);
        let el_chrome = t.elapsed();
        assert!(!r.is_empty(), "'chrome' returned no results");

        assert!(r[0].name.contains("chrome"), "first hit must be a chrome match");
        assert!(r.iter().any(|x| x.name == "chrome"), "exact 'chrome' must be present");
        SEARCH_VERSION.store(2, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r2 = search_index("vjcrdf", 2, None); 
        let el_layout = t.elapsed();
        assert!(!r2.is_empty(), "layout variant 'vjcrdf' returned nothing");
        SEARCH_VERSION.store(3, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r3 = search_index("spotfy", 3, None);
        let el_fuzzy = t.elapsed();
        assert!(!r3.is_empty(), "typo 'spotfy' did not match 'spotify'");
        SEARCH_VERSION.store(4, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r4 = search_index("pohotoshop", 4, None);
        let el_fuzzy2 = t.elapsed();
        assert!(!r4.is_empty(), "typo 'pohotoshop' did not match 'photoshop'");
        println!(
            "300k entries — chrome: {:?}, layout: {:?}, fuzzy: {:?}, fuzzy2: {:?}",
            el_chrome, el_layout, el_fuzzy, el_fuzzy2
        );
        let max_duration = if cfg!(debug_assertions) {
            std::time::Duration::from_millis(5000)
        } else {
            std::time::Duration::from_millis(1500)
        };
        for el in [el_chrome, el_layout, el_fuzzy, el_fuzzy2] {
            assert!(
                el < max_duration,
                "search too slow: {:?}",
                el
            );
        }
        // A drive scope keeps only that drive, whatever the case of the letter.
        SEARCH_VERSION.store(5, Ordering::SeqCst);
        let on_d = search_index("chrome", 5, Some("D:\\"));
        assert_eq!(on_d.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), vec!["d:\\Заметки\\chrome notes.txt"]);
        assert!(under_prefix("C:\\x", "c:\\") && !under_prefix("ЖЖ", "D:\\"), "byte compare never slices mid-char");
        SEARCH_VERSION.store(100, Ordering::SeqCst);
        let stale = search_index("chrome", 99, None);
        assert!(stale.is_empty(), "stale scan must abort immediately");
        SEARCH_VERSION.store(101, Ordering::SeqCst);
    }
}
