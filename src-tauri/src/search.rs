

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

fn lev_dist(a: &str, b: &str, max: usize) -> Option<usize> {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let (n, m) = (a_chars.len(), b_chars.len());
    if n.abs_diff(m) > max {
        return None;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0; m + 1];
    for i in 1..=n {
        cur[0] = i;
        let mut min_row = cur[0];
        for j in 1..=m {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            min_row = min_row.min(cur[j]);
        }
        if min_row > max {
            return None;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let d = prev[m];
    if d <= max { Some(d) } else { None }
}

type VariantTable = (String, Vec<(char, i32)>);

fn variant_char_table(v: &str) -> Vec<(char, i32)> {
    let mut table: Vec<(char, i32)> = Vec::new();
    for c in v.chars() {
        match table.iter_mut().find(|(ch, _)| *ch == c) {
            Some(entry) => entry.1 += 1,
            None => table.push((c, 1)),
        }
    }
    table
}

fn shared_chars(name: &str, table: &[(char, i32)]) -> i32 {
    let mut tmp: Vec<(char, i32)> = table.to_vec();
    let mut shared = 0i32;
    for c in name.chars() {
        if let Some(entry) = tmp.iter_mut().find(|(ch, _)| *ch == c) {
            if entry.1 > 0 {
                entry.1 -= 1;
                shared += 1;
            }
        }
    }
    shared
}

fn is_fuzzy_match(name: &str, variants: &[VariantTable], max_dist: usize) -> Option<usize> {
    let mut best: Option<usize> = None;
    let name_chars: Vec<char> = name.chars().collect();
    for (v, table) in variants {
        let wlen = v.chars().count();
        if wlen < 3 { continue; }
        
        if let Some(d) = lev_dist(name, v, max_dist) {
            best = Some(best.map_or(d, |b| b.min(d)));
            if best == Some(1) { return best; }
        }
        
        if name_chars.len() > wlen
            && shared_chars(name, table) >= wlen as i32 - max_dist as i32
        {
            for start in 0..=name_chars.len() - wlen {
                let window: String = name_chars[start..start + wlen].iter().collect();
                if let Some(d) = lev_dist(&window, v, max_dist) {
                    best = Some(best.map_or(d, |b| b.min(d)));
                    if best == Some(1) { return best; }
                }
            }
            
            if wlen > 1 {
                for delta in [1i32, -1] {
                    let wl = (wlen as i32 + delta) as usize;
                    if wl == 0 || name_chars.len() < wl { continue; }
                    for start in 0..=name_chars.len() - wl {
                        let window: String = name_chars[start..start + wl].iter().collect();
                        if let Some(d) = lev_dist(&window, v, max_dist) {
                            best = Some(best.map_or(d, |b| b.min(d)));
                            if best == Some(1) { return best; }
                        }
                    }
                }
            }
        }
    }
    best
}

fn match_score(
    e: &SearchEntry,
    q: &str,
    variants: &[VariantTable],
    frec: &std::collections::HashMap<String, f64>,
    fuzzy_deadline: std::time::Instant,
) -> Option<ScoreKey> {
    let name = e.name_lower.as_ref();
    let primary = if name == q {
        0u32
    } else if variants.iter().any(|(v, _)| name == v) {
        1
    } else if name.starts_with(q) {
        2
    } else if variants.iter().any(|(v, _)| name.starts_with(v)) {
        3
    } else if variants.iter().any(|(v, _)| name.contains(v.as_str())) {
        4
    } else {

        let q_len = q.chars().count();
        let max_dist = if q_len <= 3 {
            0
        } else if q_len <= 6 {
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
            5
        } else {
            return None;
        }
    };
    
    let ext = std::path::Path::new(&e.path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_exe = ext == "exe";
    let tier: u32 = if (e.kind == KIND_APP || e.kind == KIND_SHORTCUT) && !is_exe {
        0 
    } else if is_exe {
        1 
    } else {
        2 
    };

    let frec_score = frec.get(&e.path).copied().unwrap_or(0.0).clamp(0.0, 1000.0);
    let frec_inv = ((1000.0 - frec_score) * 10.0) as u32;
    
    let len = (e.name_lower.chars().count() as u32).min(9999);
    let path_len = (e.path.chars().count() as u32).min(9999);
    Some(ScoreKey { tier, primary, frec_inv, len, path_len })
}

const MAX_RESULTS: usize = 30;

const FUZZY_BUDGET_MS: u64 = 250;

pub fn search_index(query: &str, version: u32) -> Vec<SearchResult> {
    let q = query.to_lowercase();
    if q.is_empty() || !is_current(version) {
        return Vec::new();
    }

    let variants: Vec<VariantTable> = get_search_variants(&q)
        .into_iter()
        .map(|v| {
            let table = variant_char_table(&v);
            (v, table)
        })
        .collect();
    
    let frec = frecency::scores_snapshot();
    let fuzzy_deadline = std::time::Instant::now() + std::time::Duration::from_millis(FUZZY_BUDGET_MS);
    
    let disabled_kinds = config::get_disabled_kinds();
    
    with_entries(|entries| {
        let mut picked: Vec<(ScoreKey, usize)> = entries
            .par_iter()
            .enumerate()
            .filter(|(_, e)| !disabled_kinds.contains(&e.kind))
            .filter_map(|(i, e)| {
                if !is_current(version) {
                    return None;
                }
                match_score(e, &q, &variants, &frec, fuzzy_deadline).map(|score| (score, i))
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
                    if !seen_apps.insert(&e.name_lower) {
                        continue;
                    }
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
        let r = search_index("chrome", 1);
        let el_chrome = t.elapsed();
        assert!(!r.is_empty(), "'chrome' returned no results");
        
        assert!(r[0].name.contains("chrome"), "first hit must be a chrome match");
        assert!(r.iter().any(|x| x.name == "chrome"), "exact 'chrome' must be present");

        SEARCH_VERSION.store(2, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r2 = search_index("vjcrdf", 2); 
        let el_layout = t.elapsed();
        assert!(!r2.is_empty(), "layout variant 'vjcrdf' returned nothing");

        SEARCH_VERSION.store(3, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r3 = search_index("spotfy", 3);
        let el_fuzzy = t.elapsed();
        assert!(!r3.is_empty(), "typo 'spotfy' did not match 'spotify'");

        SEARCH_VERSION.store(4, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let r4 = search_index("pohotoshop", 4);
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

        SEARCH_VERSION.store(100, Ordering::SeqCst);
        let stale = search_index("chrome", 99);
        assert!(stale.is_empty(), "stale scan must abort immediately");
        SEARCH_VERSION.store(101, Ordering::SeqCst);
    }
}
