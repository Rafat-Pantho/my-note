//! Spell check: a Hunspell-compatible checker (the `spellbook` crate) that is built on the first request and
//! never at startup. The built-in en_US dictionary is part of the exe (`include_str!`: it costs address
//! space, not memory, until it is parsed). Other languages are a `.dic` + `.aff` pair in a folder the user
//! picks. Nothing is downloaded. The frontend sends words and gets back the misspelled ones.
//!
//! Words in a script the loaded dictionary has no letters of (Bengali against en_US) are never reported:
//! the checker cannot know them, so it must not underline them.

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use spellbook::Dictionary;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::config::SettingsState;

pub const BUILTIN_ID: &str = "en_US";
const EN_US_AFF: &str = include_str!("../dict/en_US.aff");
const EN_US_DIC: &str = include_str!("../dict/en_US.dic");
const PERSONAL_FILE: &str = "user-dictionary.txt";
/// A dictionary file bigger than this is refused (the largest real ones are a few MB).
const MAX_DICT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WORD_CHARS: usize = 100;
const MAX_CHECK_WORDS: usize = 5_000;
const MAX_SUGGESTIONS: usize = 6;

// ---------- scripts ----------

/// Writing systems we tell apart. One bit each in a `u32` set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Script {
    Latin,
    Greek,
    Cyrillic,
    Armenian,
    Hebrew,
    Arabic,
    Devanagari,
    Bengali,
    Gurmukhi,
    Gujarati,
    Tamil,
    Telugu,
    Kannada,
    Malayalam,
    Sinhala,
    Thai,
    Lao,
    Tibetan,
    Georgian,
    Hangul,
    Kana,
    Han,
    Other,
}

impl Script {
    fn bit(self) -> u32 {
        1 << (self as u32)
    }
}

/// The script of an alphabetic character.
fn script_of(c: char) -> Script {
    let u = c as u32;
    let r = |lo: u32, hi: u32| (lo..=hi).contains(&u);
    let latin = r(0xAA, 0xAA) || r(0xBA, 0xBA) || r(0xC0, 0x24F) || r(0x1E00, 0x1EFF);
    let latin = latin || r(0x2C60, 0x2C7F) || r(0xA720, 0xA7FF) || r(0xFB00, 0xFB06);
    if c.is_ascii_alphabetic() || latin {
        Script::Latin
    } else if r(0x370, 0x3FF) || r(0x1F00, 0x1FFF) {
        Script::Greek
    } else if r(0x400, 0x52F) || r(0x1C80, 0x1C8F) || r(0x2DE0, 0x2DFF) || r(0xA640, 0xA69F) {
        Script::Cyrillic
    } else if r(0x530, 0x58F) {
        Script::Armenian
    } else if r(0x590, 0x5FF) {
        Script::Hebrew
    } else if r(0x600, 0x6FF)
        || r(0x750, 0x77F)
        || r(0x8A0, 0x8FF)
        || r(0xFB50, 0xFDFF)
        || r(0xFE70, 0xFEFF)
    {
        Script::Arabic
    } else if r(0x900, 0x97F) {
        Script::Devanagari
    } else if r(0x980, 0x9FF) {
        Script::Bengali
    } else if r(0xA00, 0xA7F) {
        Script::Gurmukhi
    } else if r(0xA80, 0xAFF) {
        Script::Gujarati
    } else if r(0xB80, 0xBFF) {
        Script::Tamil
    } else if r(0xC00, 0xC7F) {
        Script::Telugu
    } else if r(0xC80, 0xCFF) {
        Script::Kannada
    } else if r(0xD00, 0xD7F) {
        Script::Malayalam
    } else if r(0xD80, 0xDFF) {
        Script::Sinhala
    } else if r(0xE00, 0xE7F) {
        Script::Thai
    } else if r(0xE80, 0xEFF) {
        Script::Lao
    } else if r(0xF00, 0xFFF) {
        Script::Tibetan
    } else if r(0x10A0, 0x10FF) || r(0x1C90, 0x1CBF) {
        Script::Georgian
    } else if r(0x1100, 0x11FF) || r(0x3130, 0x318F) || r(0xAC00, 0xD7AF) {
        Script::Hangul
    } else if r(0x3040, 0x30FF) {
        Script::Kana
    } else if r(0x3400, 0x4DBF) || r(0x4E00, 0x9FFF) || r(0x20000, 0x2A6DF) {
        Script::Han
    } else {
        Script::Other
    }
}

/// Every script that has letters in `text`.
fn scripts_in(text: &str) -> u32 {
    let mut set = 0;
    for c in text.chars().filter(|c| c.is_alphabetic()) {
        set |= script_of(c).bit();
    }
    set
}

/// True if the word has letters and all of them are in `known`. Digits, apostrophes, hyphens and
/// combining marks are neutral.
fn checkable(word: &str, known: u32) -> bool {
    let mut any = false;
    for c in word.chars().filter(|c| c.is_alphabetic()) {
        any = true;
        if known & script_of(c).bit() == 0 {
            return false;
        }
    }
    any
}

// ---------- the personal dictionary ----------

/// A word we accept into the personal dictionary: letters, marks, digits, apostrophes and hyphens, no
/// spaces, no `/` (that starts the flags in a `.dic` line), no control characters.
pub fn valid_personal_word(word: &str) -> bool {
    let n = word.chars().count();
    (1..=MAX_WORD_CHARS).contains(&n)
        && word.chars().any(char::is_alphabetic)
        && word
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '\'' | '\u{2019}' | '-') || is_mark(c))
}

fn is_mark(c: char) -> bool {
    // Combining marks that `is_alphanumeric` does not cover (they are Mn, not alphabetic).
    matches!(c as u32, 0x300..=0x36F | 0x483..=0x489 | 0x591..=0x5BD | 0x610..=0x61A | 0x64B..=0x65F
        | 0x900..=0x903 | 0x93A..=0x94F | 0x980..=0x983 | 0x9BC..=0x9CD | 0x9D7 | 0x9E2..=0x9E3
        | 0x200C | 0x200D)
}

/// The words of a personal-dictionary file: one per line, blank lines and `#` comments skipped, invalid
/// lines dropped, duplicates removed (first one wins).
pub fn parse_personal(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let w = line.trim();
        if w.is_empty() || w.starts_with('#') || !valid_personal_word(w) {
            continue;
        }
        if seen.insert(w.to_string()) {
            out.push(w.to_string());
        }
    }
    out
}

/// The file contents after adding `word`; None if the word is invalid or already there.
pub fn with_word_added(text: &str, word: &str) -> Option<String> {
    let w = word.trim();
    if !valid_personal_word(w) || parse_personal(text).iter().any(|x| x == w) {
        return None;
    }
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(w);
    out.push('\n');
    Some(out)
}

fn personal_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join(PERSONAL_FILE))
        .map_err(|e| e.to_string())
}

/// Adds a word to the file at `path` (created with its folder if missing). Ok(false) if it was there.
fn personal_add(path: &Path, word: &str) -> Result<bool, String> {
    let current = fs::read_to_string(path).unwrap_or_default();
    let Some(next) = with_word_added(&current, word) else {
        return if valid_personal_word(word.trim()) {
            Ok(false)
        } else {
            Err("That is not a word that can be added.".into())
        };
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Append only the new line: a crash cannot lose the older words.
    let added = &next[current.len()..];
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(added.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---------- dictionaries on disk ----------

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    /// File stem of the pair (`bn_BD`) or `en_US` for the built-in one.
    pub id: String,
    pub name: String,
    pub builtin: bool,
}

/// `<stem>.dic` files that have a `<stem>.aff` beside them, sorted by name. An unreadable folder is empty.
fn scan_folder(dir: &Path) -> Vec<String> {
    let mut stems: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.extension()?.to_str()?.eq_ignore_ascii_case("dic") {
                return None;
            }
            let stem = p.file_stem()?.to_str()?.to_string();
            let aff = (
                dir.join(format!("{stem}.aff")),
                dir.join(format!("{stem}.AFF")),
            );
            (aff.0.is_file() || aff.1.is_file()).then_some(stem)
        })
        .collect();
    stems.sort_by_key(|s| s.to_lowercase());
    stems.dedup();
    stems
}

/// The built-in dictionary plus the folder's pairs. A folder pair named like the built-in one replaces it.
pub fn languages(dir: &str) -> Vec<Language> {
    let mut out = vec![Language {
        id: BUILTIN_ID.into(),
        name: "English (United States), built in".into(),
        builtin: true,
    }];
    if dir.is_empty() {
        return out;
    }
    for stem in scan_folder(Path::new(dir)) {
        if stem == BUILTIN_ID {
            out.remove(0);
        }
        out.push(Language {
            name: stem.clone(),
            id: stem,
            builtin: false,
        });
    }
    out.sort_by(|a, b| {
        b.builtin
            .cmp(&a.builtin)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// Text of a dictionary file. UTF-8 as is; otherwise the charset named by `SET` in the `.aff` file, for
/// the two legacy ones that are plain byte-to-character maps. Anything else is refused with a clear reason.
fn decode_dict_file(bytes: &[u8], aff_text: Option<&str>) -> Result<String, String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok(s.to_string());
    }
    let set = aff_text
        .and_then(|a| a.lines().find_map(|l| l.strip_prefix("SET")))
        .map(|s| s.trim().to_ascii_uppercase().replace(['-', '_'], ""))
        .unwrap_or_default();
    match set.as_str() {
        "ISO88591" | "WINDOWS1252" | "CP1252" => Ok(bytes.iter().map(|&b| b as char).collect()),
        other => Err(format!(
            "The dictionary is not UTF-8 and uses the unsupported character set \"{other}\". Convert it to UTF-8."
        )),
    }
}

fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let len = fs::metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len();
    if len > MAX_DICT_BYTES {
        return Err(format!("{} is too large for a dictionary.", path.display()));
    }
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_pair(dir: &Path, stem: &str) -> Result<(String, String), String> {
    let pick = |ext: &str| {
        let (lo, up) = (
            dir.join(format!("{stem}.{ext}")),
            dir.join(format!("{stem}.{}", ext.to_uppercase())),
        );
        if lo.is_file() { lo } else { up }
    };
    let aff_bytes = read_limited(&pick("aff"))?;
    let aff_guess = String::from_utf8_lossy(&aff_bytes).into_owned();
    let aff = decode_dict_file(&aff_bytes, Some(&aff_guess))?;
    let dic = decode_dict_file(&read_limited(&pick("dic"))?, Some(&aff))?;
    Ok((aff, dic))
}

// ---------- the loaded dictionary ----------

struct Loaded {
    /// What was asked for: the language id and the folder it came from ("" = built in).
    id: String,
    dir: String,
    dict: Dictionary,
    scripts: u32,
}

impl Loaded {
    fn build(
        aff: &str,
        dic: &str,
        id: &str,
        dir: &str,
        personal: &[String],
    ) -> Result<Self, String> {
        let mut dict = Dictionary::new(aff, dic)
            .map_err(|e| format!("The dictionary could not be read: {e}"))?;
        for w in personal {
            let _ = dict.add(w);
        }
        let scripts =
            scripts_in(dic) | scripts_in(aff.lines().find(|l| l.starts_with("TRY")).unwrap_or(""));
        Ok(Loaded {
            id: id.into(),
            dir: dir.into(),
            dict,
            scripts,
        })
    }

    /// Indices of the misspelled words (words in a script this dictionary does not cover are skipped).
    fn misspelled(&self, words: &[String]) -> Vec<usize> {
        words
            .iter()
            .enumerate()
            .filter(|(_, w)| checkable(w, self.scripts) && !self.dict.check(w))
            .map(|(i, _)| i)
            .collect()
    }

    fn suggest(&self, word: &str) -> Vec<String> {
        if !checkable(word, self.scripts) {
            return Vec::new();
        }
        let mut out = Vec::new();
        self.dict.suggest(word, &mut out);
        out.truncate(MAX_SUGGESTIONS);
        out
    }
}

/// Loaded on demand, dropped when spell check is turned off.
#[derive(Default)]
pub struct SpellState {
    loaded: Mutex<Option<Loaded>>,
    /// Changes whenever the answers could change (another dictionary, a word added, unloaded). The frontend
    /// keeps a cache and drops it when this number differs.
    epoch: AtomicU64,
}

impl SpellState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Loaded>> {
        self.loaded.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Makes sure the dictionary for (`id`, `dir`) is the loaded one; falls back to the built-in one if the
    /// folder pair is gone. Returns the id actually in use.
    fn ensure(
        &self,
        app: &AppHandle,
        guard: &mut Option<Loaded>,
        id: &str,
        dir: &str,
    ) -> Result<String, String> {
        let folder =
            (!dir.is_empty() && scan_folder(Path::new(dir)).iter().any(|s| s == id)).then_some(dir);
        let (want_id, want_dir) = match folder {
            Some(d) => (id, d),
            None => (BUILTIN_ID, ""),
        };
        if let Some(l) = guard.as_ref()
            && l.id == want_id
            && l.dir == want_dir
        {
            return Ok(l.id.clone());
        }
        let personal = personal_path(app)
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|t| parse_personal(&t))
            .unwrap_or_default();
        let loaded = match folder {
            Some(d) => {
                let (aff, dic) = read_pair(Path::new(d), id)?;
                Loaded::build(&aff, &dic, id, d, &personal)?
            }
            None => Loaded::build(EN_US_AFF, EN_US_DIC, BUILTIN_ID, "", &personal)?,
        };
        *guard = Some(loaded);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        Ok(want_id.to_string())
    }
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReply {
    pub epoch: u64,
    /// Language actually in use (the built-in one if the chosen folder pair is gone).
    pub language: String,
    /// Indices into the request, of misspelled words.
    pub bad: Vec<usize>,
}

/// Which words (by index) are misspelled. Loads the dictionary on the first call. With spell check off in
/// the settings nothing is loaded and nothing is reported.
#[tauri::command]
pub async fn spell_check(
    app: AppHandle,
    words: Vec<String>,
    settings: State<'_, SettingsState>,
    state: State<'_, SpellState>,
) -> Result<CheckReply, String> {
    let s = settings.get();
    if !s.spell_check {
        return Ok(CheckReply {
            epoch: state.epoch.load(Ordering::SeqCst),
            language: String::new(),
            bad: Vec::new(),
        });
    }
    if words.len() > MAX_CHECK_WORDS {
        return Err("Too many words in one request.".into());
    }
    let (lang, dir) = (s.spell_language, s.spell_dict_dir);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<SpellState>();
        let mut g = state.lock();
        let language = state.ensure(&app2, &mut g, &lang, &dir)?;
        let bad = g.as_ref().map(|l| l.misspelled(&words)).unwrap_or_default();
        Ok(CheckReply {
            epoch: state.epoch.load(Ordering::SeqCst),
            language,
            bad,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Up to six corrections for a misspelled word.
#[tauri::command]
pub async fn spell_suggest(
    app: AppHandle,
    word: String,
    settings: State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    let s = settings.get();
    if !s.spell_check || word.chars().count() > MAX_WORD_CHARS {
        return Ok(Vec::new());
    }
    let (lang, dir) = (s.spell_language, s.spell_dict_dir);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SpellState>();
        let mut g = state.lock();
        state.ensure(&app, &mut g, &lang, &dir)?;
        Ok(g.as_ref().map(|l| l.suggest(&word)).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds a word to the personal dictionary (a text file in the config folder) and to the loaded dictionary.
/// Returns the new epoch.
#[tauri::command]
pub async fn spell_add_word(
    app: AppHandle,
    word: String,
    state: State<'_, SpellState>,
) -> Result<u64, String> {
    let word = word.trim().to_string();
    let path = personal_path(&app)?;
    let added = personal_add(&path, &word)?;
    if added {
        let mut g = state.lock();
        if let Some(l) = g.as_mut() {
            let _ = l.dict.add(&word);
        }
        state.epoch.fetch_add(1, Ordering::SeqCst);
    }
    Ok(state.epoch.load(Ordering::SeqCst))
}

/// Frees the dictionary (spell check was turned off).
#[tauri::command]
pub fn spell_unload(state: State<'_, SpellState>) {
    if state.lock().take().is_some() {
        state.epoch.fetch_add(1, Ordering::SeqCst);
    }
}

/// The built-in dictionary plus every pair in the chosen folder. Reads the folder listing only.
#[tauri::command]
pub async fn spell_languages(settings: State<'_, SettingsState>) -> Result<Vec<Language>, String> {
    let dir = settings.get().spell_dict_dir;
    tauri::async_runtime::spawn_blocking(move || languages(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Asks for a folder with `.dic` and `.aff` files. None if cancelled.
#[tauri::command]
pub async fn spell_pick_dir(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// The personal dictionary file, if it exists (for "Show in folder").
#[tauri::command]
pub fn spell_personal_path(app: AppHandle) -> Option<String> {
    personal_path(&app)
        .ok()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Keys of the per-file-type switches and their defaults (used by the settings code).
pub const FILE_TYPES: [(&str, bool); 7] = [
    ("untitled", true),
    ("text", true),
    ("markdown", true),
    ("web", false),
    ("data", false),
    ("code", false),
    ("other", false),
];

pub fn default_types() -> BTreeMap<String, bool> {
    FILE_TYPES
        .iter()
        .map(|(k, v)| (k.to_string(), *v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn en() -> Loaded {
        Loaded::build(EN_US_AFF, EN_US_DIC, BUILTIN_ID, "", &[]).unwrap()
    }

    fn words(w: &[&str]) -> Vec<String> {
        w.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn built_in_dictionary_flags_typos_and_accepts_words() {
        let d = en();
        let w = words(&[
            "hello",
            "tset",
            "recieve",
            "receive",
            "don't",
            "don\u{2019}t",
            "Hello",
            "colour",
        ]);
        let bad: Vec<&str> = d
            .misspelled(&w)
            .into_iter()
            .map(|i| w[i].as_str())
            .collect();
        assert_eq!(bad, ["tset", "recieve", "colour"]);
    }

    #[test]
    fn hyphenated_words_are_checked_as_a_whole() {
        let d = en();
        let w = words(&[
            "well-known",
            "mother-in-law",
            "e-mail",
            "non-existent",
            "x-ray",
            "light-weight-like",
            "well-knwon",
            "teh-wrold",
        ]);
        let bad: Vec<&str> = d
            .misspelled(&w)
            .into_iter()
            .map(|i| w[i].as_str())
            .collect();
        assert_eq!(bad, ["well-knwon", "teh-wrold"]);
    }

    #[test]
    fn loading_the_built_in_dictionary_is_quick_enough() {
        // Debug builds are several times slower than release; this only guards against something absurd.
        let t = std::time::Instant::now();
        let d = en();
        let ms = t.elapsed().as_millis();
        println!("en_US load: {ms} ms");
        assert!(d.dict.check("hello"));
        assert!(ms < 5_000, "{ms} ms");
    }

    #[test]
    fn suggestions_include_the_fix() {
        let d = en();
        assert!(d.suggest("recieve").contains(&"receive".to_string()));
        assert!(d.suggest("teh").iter().any(|s| s == "the"));
        assert!(d.suggest("recieve").len() <= MAX_SUGGESTIONS);
    }

    #[test]
    fn words_in_other_scripts_are_not_reported() {
        let d = en();
        // Bengali, Cyrillic, Han, and a word that mixes Latin with Bengali: never underlined.
        let w = words(&["বিশ্ববিদ্যালয়", "привет", "漢字", "helloআমি", "tset"]);
        let bad: Vec<&str> = d
            .misspelled(&w)
            .into_iter()
            .map(|i| w[i].as_str())
            .collect();
        assert_eq!(bad, ["tset"]);
        assert!(d.suggest("আমি").is_empty());
        assert!(d.scripts & Script::Latin.bit() != 0);
        assert!(d.scripts & Script::Bengali.bit() == 0);
    }

    #[test]
    fn script_sets() {
        assert_eq!(scripts_in("abc ÀÉ"), Script::Latin.bit());
        assert_eq!(scripts_in("ক্ষ 123 ' -"), Script::Bengali.bit());
        assert_eq!(
            scripts_in("a я"),
            Script::Latin.bit() | Script::Cyrillic.bit()
        );
        assert!(checkable("don't", Script::Latin.bit()));
        assert!(
            !checkable("123", Script::Latin.bit()),
            "no letters: nothing to check"
        );
        assert!(!checkable("aя", Script::Latin.bit()));
    }

    #[test]
    fn personal_words_are_validated_and_parsed() {
        assert!(valid_personal_word("Pantho"));
        assert!(valid_personal_word("O'Neil"));
        assert!(valid_personal_word("well-known"));
        assert!(valid_personal_word("আমি"));
        for bad in [
            "",
            " ",
            "two words",
            "a/b",
            "foo/G",
            "tab\there",
            "123",
            "x\nz",
            "#",
        ] {
            assert!(!valid_personal_word(bad), "{bad:?}");
        }
        assert!(!valid_personal_word(&"a".repeat(101)));
        let text = "# mine\nPantho\n\n  Rafat \nPantho\nbad word\nfoo/G\n";
        assert_eq!(parse_personal(text), ["Pantho", "Rafat"]);
    }

    #[test]
    fn add_to_personal_text() {
        assert_eq!(with_word_added("", "Pantho").as_deref(), Some("Pantho\n"));
        assert_eq!(
            with_word_added("a1\nb", " Zed ").as_deref(),
            Some("a1\nb\nZed\n")
        );
        assert_eq!(with_word_added("Pantho\n", "Pantho"), None, "no duplicates");
        assert_eq!(with_word_added("", "two words"), None);
        assert!(
            with_word_added("Pantho\n", "pantho").is_some(),
            "case matters"
        );
    }

    #[test]
    fn adding_a_word_writes_the_file_and_the_checker_accepts_it() {
        let dir = std::env::temp_dir().join(format!("mynote-spell-{}", std::process::id()));
        let path = dir.join("nested").join(PERSONAL_FILE);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(personal_add(&path, "Pantho"), Ok(true));
        assert_eq!(personal_add(&path, "Pantho"), Ok(false));
        assert_eq!(personal_add(&path, "Zyx"), Ok(true));
        assert!(personal_add(&path, "no good").is_err());
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "Pantho\nZyx\n");
        let before = en();
        assert_eq!(before.misspelled(&words(&["Pantho", "Zyx"])), [0, 1]);
        let after =
            Loaded::build(EN_US_AFF, EN_US_DIC, BUILTIN_ID, "", &parse_personal(&text)).unwrap();
        assert!(
            after
                .misspelled(&words(&["Pantho", "Zyx", "PANTHO"]))
                .is_empty()
        );
        assert_eq!(after.misspelled(&words(&["Qwx"])), [0]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_dictionaries_are_listed_and_loaded() {
        let dir = std::env::temp_dir().join(format!("mynote-spell-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // A tiny Latin-1 dictionary with a legacy SET line, a pair without .aff, and a stray file.
        fs::write(dir.join("xx_TEST.aff"), b"SET ISO8859-1\n").unwrap();
        fs::write(dir.join("xx_TEST.dic"), b"2\ncaf\xe9\nhello\n").unwrap();
        fs::write(dir.join("lonely.dic"), b"1\nword\n").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        let langs = languages(dir.to_str().unwrap());
        let ids: Vec<&str> = langs.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, ["en_US", "xx_TEST"], "built in first; pairs only");
        assert!(langs[0].builtin && !langs[1].builtin);
        assert_eq!(languages("").len(), 1);
        let (aff, dic) = read_pair(&dir, "xx_TEST").unwrap();
        let d = Loaded::build(&aff, &dic, "xx_TEST", "x", &[]).unwrap();
        assert_eq!(d.misspelled(&words(&["café", "hello", "helo"])), [2]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_pair_named_en_us_replaces_the_built_in_entry() {
        let dir = std::env::temp_dir().join(format!("mynote-spell-over-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("en_US.aff"), b"SET UTF-8\n").unwrap();
        fs::write(dir.join("en_US.dic"), b"1\nword\n").unwrap();
        let langs = languages(dir.to_str().unwrap());
        assert_eq!(langs.len(), 1);
        assert!(!langs[0].builtin);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_encodings_are_refused_clearly() {
        let err = decode_dict_file(b"\xff\xfe", Some("SET KOI8-R\n")).unwrap_err();
        assert!(err.contains("KOI8R") && err.contains("UTF-8"), "{err}");
        assert_eq!(
            decode_dict_file("caf\u{e9}".as_bytes(), None).unwrap(),
            "café"
        );
        assert_eq!(decode_dict_file(b"\xef\xbb\xbfab", None).unwrap(), "ab");
    }
}
