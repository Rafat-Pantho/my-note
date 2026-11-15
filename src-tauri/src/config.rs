//! Persisted app state: the session file (open tabs, unsaved text, view prefs) and the user settings.
//! The frontend owns the session JSON shape; Rust only stores it atomically in the app data dir.
//! Settings live in a versioned `config.json` in the app config dir. Rust owns and validates them:
//! changes apply in memory at once and are written (atomically) after a short debounce.

use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, State,
    ipc::{InvokeBody, Request, Response},
};

use crate::ai::AiConfig;
use crate::effects::Mode;
use crate::files::{Encoding, LineEnding};

fn data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Temp file + rename, so a crash never leaves a half-written file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// A session file up to this size is sent with the first request; a bigger one is announced with
/// `SESSION_LARGE` and sent when the frontend asks again (`full`), after the first paint. Pushing megabytes
/// through the webview's IPC at startup blocks the small `editor_ready` / `show_window` calls behind it.
const SESSION_INLINE_MAX: u64 = 256 * 1024;
/// A session file always starts with `{`, so a single other byte is unambiguous.
const SESSION_LARGE: u8 = b'L';

fn session_deferred(len: Option<u64>, full: bool) -> bool {
    !full && len.is_some_and(|n| n > SESSION_INLINE_MAX)
}

/// Empty body when there is no saved session.
#[tauri::command]
pub async fn load_session(app: AppHandle, full: bool) -> Result<Response, String> {
    if is_secondary() {
        return Ok(Response::new(Vec::new())); // an extra window starts empty
    }
    let path = data_file(&app, "session.json")?;
    if session_deferred(fs::metadata(&path).ok().map(|m| m.len()), full) {
        return Ok(Response::new(vec![SESSION_LARGE]));
    }
    Ok(Response::new(fs::read(path).unwrap_or_default()))
}

#[tauri::command]
pub async fn save_session(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    if is_secondary() {
        return Ok(()); // only the first window owns the session file
    }
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected a raw body".into());
    };
    write_atomic(&data_file(&app, "session.json")?, body)
}

/// Flag given to an extra window started from the first one (File > New window, Move to new window).
pub const NEW_WINDOW_FLAG: &str = "--new-window";

fn has_flag(args: impl Iterator<Item = std::ffi::OsString>, flag: &str) -> bool {
    args.skip(1).any(|a| a == flag)
}

/// An extra window has no session of its own (the first window owns `session.json`) and does not remember
/// the window size.
pub fn is_secondary() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| has_flag(std::env::args_os(), NEW_WINDOW_FLAG))
}

/* ---------- settings ---------- */

/// Bump when the file layout changes and add a step to `migrate`.
pub const CONFIG_VERSION: u32 = 1;
const CONFIG_FILE: &str = "config.json";
/// Unversioned file written by M2; read once and migrated into `config.json`.
const LEGACY_FILE: &str = "settings.json";
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);

pub const MIN_OPACITY: f64 = 0.5;
pub const MAX_OPACITY: f64 = 1.0;
/// Used only once the user opts in to Transparent or Blur.
pub const DEFAULT_OPACITY: f64 = 0.85;
pub const FONT_SIZE_RANGE: (u32, u32) = (8, 48);
pub const TAB_SIZE_RANGE: (u32, u32) = (1, 16);
const MAX_FONT_FAMILY_LEN: usize = 200;
pub const AUTO_SAVE_RANGE: (u32, u32) = (1, 600);
pub const PRINT_MARGIN_RANGE: (u32, u32) = (0, 50);
const MAX_PRINT_TEXT_LEN: usize = 200;
const MAX_LANGUAGE_LEN: usize = 64;
const MAX_DIR_LEN: usize = 1000;

/// Header / footer text: plain text up to 200 characters, no control characters. None means invalid.
fn sanitize_print_text(s: &str) -> Option<String> {
    (s.chars().count() <= MAX_PRINT_TEXT_LEN && !s.chars().any(char::is_control))
        .then(|| s.to_string())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

/// User choices. No secrets here, ever (keys live in the OS keychain).
/// Defaults are the first-launch state: system theme, effects off (solid).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Encoding for new files (`files::Encoding` id).
    pub default_encoding: String,
    /// Line ending for new files (`files::LineEnding` id).
    pub default_line_ending: String,
    pub word_wrap: bool,
    /// CSS font-family list for the editor. Empty means the built-in monospace stack.
    pub font_family: String,
    pub font_size: u32,
    pub tab_size: u32,
    pub restore_session: bool,
    pub theme: Theme,
    pub effects: Mode,
    /// Background layer opacity, 0.5 to 1.0. Never applied to text.
    pub opacity: f64,
    /// Master switch: forces solid and turns off non-essential animation.
    pub reduce_effects: bool,
    /// Save files that already have a path after `auto_save_seconds` without typing. Off by default.
    pub auto_save: bool,
    pub auto_save_seconds: u32,
    /// Render zero-width and bidirectional control characters visibly.
    pub show_control_chars: bool,
    /// Page setup for printing: margin in mm, orientation, header and footer codes (&f name, &p page,
    /// &P pages, &d date, &l &c &r alignment, && for an ampersand).
    pub print_margin_mm: u32,
    pub print_landscape: bool,
    pub print_header: String,
    pub print_footer: String,
    /// Open files from File > Open and Recent in a new window instead of a new tab.
    pub open_in_new_window: bool,
    /// Opening a file whose first line is exactly `.LOG` appends a date and time line (like Notepad).
    pub log_timestamp: bool,
    /// Keep a list of recent files. Turning it off also clears the list.
    pub recent_enabled: bool,
    /// Web search engine for Ctrl+E: "" (not chosen yet), "bing", "google", "duckduckgo" or a custom URL
    /// template containing `%s`.
    pub search_engine: String,
    /// Show the whole status bar (when off only the AI indicator stays: it must always be visible).
    pub status_bar: bool,
    /// Spell check and autocorrect. Both apply only to tabs whose file type is switched on in `spell_types`.
    pub spell_check: bool,
    pub autocorrect: bool,
    /// File type -> on/off (`spell::FILE_TYPES` lists the keys). Unknown keys are ignored.
    pub spell_types: BTreeMap<String, bool>,
    /// Dictionary id: `en_US` (built in) or the stem of a `.dic` + `.aff` pair in `spell_dict_dir`.
    pub spell_language: String,
    /// Folder the user chose for extra dictionaries ("" = none). Read only when the language list is asked for.
    pub spell_dict_dir: String,
    /// Last opened files, newest first. Paths only, never contents. Changed only through the `recent_*`
    /// commands; saved in the file but not part of the settings payload or the generic patch.
    #[serde(skip)]
    pub recent_files: Vec<String>,
    /// Size and position of the first window at the last exit. Same handling as `recent_files`.
    #[serde(skip)]
    pub window: Option<WindowGeom>,
    /// AI environments and consent. Not part of the generic settings patch and not sent with the settings
    /// (the frontend gets `ai::AiStatus` / `ai::AiView` instead): it is written to the file by
    /// `to_file_bytes` and changed only through the `ai_*` commands.
    #[serde(skip)]
    pub ai: AiConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            default_encoding: Encoding::Utf8.as_str().into(),
            default_line_ending: LineEnding::Crlf.as_str().into(),
            word_wrap: true,
            font_family: String::new(),
            font_size: 14,
            tab_size: 8,
            restore_session: true,
            theme: Theme::System,
            effects: Mode::Off,
            opacity: DEFAULT_OPACITY,
            reduce_effects: false,
            auto_save: false,
            auto_save_seconds: 5,
            show_control_chars: false,
            print_margin_mm: 20,
            print_landscape: false,
            print_header: "&f".into(),
            print_footer: "Page &p".into(),
            open_in_new_window: false,
            recent_enabled: true,
            log_timestamp: true,
            search_engine: String::new(),
            status_bar: true,
            spell_check: true,
            autocorrect: true,
            spell_types: crate::spell::default_types(),
            spell_language: crate::spell::BUILTIN_ID.into(),
            spell_dict_dir: String::new(),
            recent_files: Vec::new(),
            window: None,
            ai: AiConfig::default(),
        }
    }
}

pub fn clamp_opacity(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(MIN_OPACITY, MAX_OPACITY)
    } else {
        DEFAULT_OPACITY
    }
}

/// Rounds and clamps a JSON number into `range`; None if it is not a finite number.
fn clamp_int(v: &serde_json::Value, (lo, hi): (u32, u32)) -> Option<u32> {
    let f = v.as_f64().filter(|f| f.is_finite())?;
    Some(f.round().clamp(f64::from(lo), f64::from(hi)) as u32)
}

/// Trims and checks a font-family list. It ends up in a CSS custom property, so reject anything that is
/// not plain text; None means invalid (keep the old value).
fn sanitize_font_family(s: &str) -> Option<String> {
    let t = s.trim();
    let bad = |c: char| c.is_control() || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\');
    (t.chars().count() <= MAX_FONT_FAMILY_LEN && !t.chars().any(bad)).then(|| t.to_string())
}

/// A dictionary id: the file stem of a `.dic` file, so letters, digits, `_`, `-` and `.` only.
fn sanitize_language_id(s: &str) -> Option<String> {
    let ok = !s.is_empty()
        && s.chars().count() <= MAX_LANGUAGE_LEN
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    ok.then(|| s.to_string())
}

/// A folder path: "" (none) or up to 1,000 characters with no control characters.
fn sanitize_dir(s: &str) -> Option<String> {
    (s.chars().count() <= MAX_DIR_LEN && !s.chars().any(char::is_control)).then(|| s.to_string())
}

fn from_value<T: serde::de::DeserializeOwned>(x: &serde_json::Value) -> Option<T> {
    serde_json::from_value(x.clone()).ok()
}

impl Settings {
    /// Applies the fields present in `v` (a JSON object); anything missing or invalid is left alone.
    /// Used for both the file and the frontend's partial updates, so a hand-edited file never breaks startup.
    pub fn merge_json(&mut self, v: &serde_json::Value) {
        let get = |k: &str| v.get(k);
        if let Some(e) = get("defaultEncoding")
            .and_then(|x| x.as_str())
            .and_then(Encoding::parse)
        {
            self.default_encoding = e.as_str().into();
        }
        if let Some(l) = get("defaultLineEnding")
            .and_then(|x| x.as_str())
            .and_then(LineEnding::parse)
        {
            self.default_line_ending = l.as_str().into();
        }
        if let Some(b) = get("wordWrap").and_then(|x| x.as_bool()) {
            self.word_wrap = b;
        }
        if let Some(f) = get("fontFamily")
            .and_then(|x| x.as_str())
            .and_then(sanitize_font_family)
        {
            self.font_family = f;
        }
        if let Some(n) = get("fontSize").and_then(|x| clamp_int(x, FONT_SIZE_RANGE)) {
            self.font_size = n;
        }
        if let Some(n) = get("tabSize").and_then(|x| clamp_int(x, TAB_SIZE_RANGE)) {
            self.tab_size = n;
        }
        if let Some(b) = get("restoreSession").and_then(|x| x.as_bool()) {
            self.restore_session = b;
        }
        if let Some(t) = get("theme").and_then(from_value) {
            self.theme = t;
        }
        if let Some(m) = get("effects").and_then(from_value) {
            self.effects = m;
        }
        if let Some(o) = get("opacity").and_then(|x| x.as_f64()) {
            self.opacity = clamp_opacity(o);
        }
        if let Some(r) = get("reduceEffects").and_then(|x| x.as_bool()) {
            self.reduce_effects = r;
        }
        if let Some(b) = get("autoSave").and_then(|x| x.as_bool()) {
            self.auto_save = b;
        }
        if let Some(n) = get("autoSaveSeconds").and_then(|x| clamp_int(x, AUTO_SAVE_RANGE)) {
            self.auto_save_seconds = n;
        }
        if let Some(b) = get("showControlChars").and_then(|x| x.as_bool()) {
            self.show_control_chars = b;
        }
        if let Some(n) = get("printMarginMm").and_then(|x| clamp_int(x, PRINT_MARGIN_RANGE)) {
            self.print_margin_mm = n;
        }
        if let Some(b) = get("printLandscape").and_then(|x| x.as_bool()) {
            self.print_landscape = b;
        }
        if let Some(t) = get("printHeader")
            .and_then(|x| x.as_str())
            .and_then(sanitize_print_text)
        {
            self.print_header = t;
        }
        if let Some(t) = get("printFooter")
            .and_then(|x| x.as_str())
            .and_then(sanitize_print_text)
        {
            self.print_footer = t;
        }
        if let Some(b) = get("openInNewWindow").and_then(|x| x.as_bool()) {
            self.open_in_new_window = b;
        }
        if let Some(b) = get("logTimestamp").and_then(|x| x.as_bool()) {
            self.log_timestamp = b;
        }
        if let Some(b) = get("recentEnabled").and_then(|x| x.as_bool()) {
            self.recent_enabled = b;
            if !b {
                self.recent_files.clear();
            }
        }
        if let Some(e) = get("searchEngine")
            .and_then(|x| x.as_str())
            .and_then(sanitize_search_engine)
        {
            self.search_engine = e;
        }
        if let Some(b) = get("statusBar").and_then(|x| x.as_bool()) {
            self.status_bar = b;
        }
        if let Some(b) = get("spellCheck").and_then(|x| x.as_bool()) {
            self.spell_check = b;
        }
        if let Some(b) = get("autocorrect").and_then(|x| x.as_bool()) {
            self.autocorrect = b;
        }
        if let Some(map) = get("spellTypes").and_then(|x| x.as_object()) {
            for (k, v) in map {
                if let (Some(on), Some(slot)) = (v.as_bool(), self.spell_types.get_mut(k)) {
                    *slot = on;
                }
            }
        }
        if let Some(l) = get("spellLanguage")
            .and_then(|x| x.as_str())
            .and_then(sanitize_language_id)
        {
            self.spell_language = l;
        }
        if let Some(d) = get("spellDictDir")
            .and_then(|x| x.as_str())
            .and_then(sanitize_dir)
        {
            self.spell_dict_dir = d;
        }
    }

    /// The on-disk form: the settings plus the format version.
    pub fn to_file_bytes(&self) -> Result<Vec<u8>, String> {
        let mut v = serde_json::to_value(self).map_err(|e| e.to_string())?;
        v["ai"] = serde_json::to_value(&self.ai).map_err(|e| e.to_string())?;
        v["recentFiles"] = serde_json::to_value(&self.recent_files).map_err(|e| e.to_string())?;
        if let Some(w) = &self.window {
            v["window"] = serde_json::to_value(w).map_err(|e| e.to_string())?;
        }
        v["version"] = CONFIG_VERSION.into();
        serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())
    }
}

/// Upgrades a parsed config object to `CONFIG_VERSION` in place. Add one `match` arm per version bump.
fn migrate(v: &mut serde_json::Value, from: u32) {
    // 0 -> 1: the unversioned M2 settings file. Same field names; new fields take their defaults, so
    // there is nothing to rewrite yet. Future bumps: `if from < 2 { ...rename/convert fields... }`.
    let _ = from;
    v["version"] = CONFIG_VERSION.into();
}

/// A config file is usable if it is a JSON object whose version is absent (0) or not newer than ours.
fn parse_file(text: &str) -> Option<(serde_json::Value, u32)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if !v.is_object() {
        return None;
    }
    let version = match v.get("version") {
        None => 0,
        Some(x) => u32::try_from(x.as_u64()?).ok()?,
    };
    (version <= CONFIG_VERSION).then_some((v, version))
}

/// Moves an unusable file aside as `<name>.invalid-<unix seconds>` (copy as a fallback) so it is never lost.
fn back_up(path: &Path) -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("{}.invalid-{stamp}", path.file_name()?.to_string_lossy());
    let dest = path.with_file_name(name);
    if fs::rename(path, &dest).is_ok() {
        return Some(dest);
    }
    fs::copy(path, &dest).ok().map(|_| dest)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    /// No file yet: defaults.
    Fresh,
    Current,
    /// Read an older layout; the caller should save it in the current one.
    Migrated {
        from: u32,
    },
    /// The file was invalid (not JSON, not an object, unreadable text, or from a newer version): it was
    /// backed up and defaults are in use.
    Recovered {
        backup: Option<PathBuf>,
    },
}

fn settings_from(mut v: serde_json::Value, from: u32) -> (Settings, Loaded) {
    migrate(&mut v, from);
    let mut s = Settings::default();
    s.merge_json(&v);
    s.ai = AiConfig::from_value(v.get("ai")); // only the file can carry this, never a patch
    s.recent_files = parse_recent(v.get("recentFiles"));
    s.window = v.get("window").and_then(WindowGeom::from_value);
    let loaded = if from < CONFIG_VERSION {
        Loaded::Migrated { from }
    } else {
        Loaded::Current
    };
    (s, loaded)
}

/// Loads `path`; if there is none, tries the legacy unversioned file. Never fails: worst case is defaults.
pub fn load_from(path: &Path, legacy: Option<&Path>) -> (Settings, Loaded) {
    match fs::read_to_string(path) {
        Ok(text) => match parse_file(&text) {
            Some((v, from)) => settings_from(v, from),
            None => (
                Settings::default(),
                Loaded::Recovered {
                    backup: back_up(path),
                },
            ),
        },
        // Not valid UTF-8 text.
        Err(e) if e.kind() == ErrorKind::InvalidData => (
            Settings::default(),
            Loaded::Recovered {
                backup: back_up(path),
            },
        ),
        Err(e) if e.kind() == ErrorKind::NotFound => legacy
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|t| parse_file(&t))
            .map(|(v, _)| settings_from(v, 0))
            .unwrap_or((Settings::default(), Loaded::Fresh)),
        // Unreadable for another reason (permissions...): run with defaults, leave the file alone.
        Err(_) => (Settings::default(), Loaded::Fresh),
    }
}

/* ---------- recent files ---------- */

pub const MAX_RECENT: usize = 10;
const MAX_PATH_LEN: usize = 4096;

fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn valid_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= MAX_PATH_LEN && !p.chars().any(char::is_control)
}

/// Moves `path` to the front (no duplicates), keeping at most `MAX_RECENT`.
pub fn push_recent(list: &mut Vec<String>, path: &str) {
    if !valid_path(path) {
        return;
    }
    list.retain(|p| !same_path(p, path));
    list.insert(0, path.to_string());
    list.truncate(MAX_RECENT);
}

/// A hand-edited or damaged list never breaks startup: bad entries and duplicates are dropped.
pub fn parse_recent(v: Option<&serde_json::Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in v.and_then(|x| x.as_array()).into_iter().flatten() {
        let Some(p) = p.as_str().filter(|p| valid_path(p)) else {
            continue;
        };
        if !out.iter().any(|q| same_path(q, p)) && out.len() < MAX_RECENT {
            out.push(p.to_string());
        }
    }
    out
}

/// The entries that still exist, in order. `exists` is injected so the rule is testable.
pub fn existing_recent(list: &[String], exists: impl Fn(&str) -> bool) -> Vec<String> {
    list.iter().filter(|p| exists(p)).cloned().collect()
}

/// For File > Recent: only files that still exist (a missing one is skipped, not forgotten, so an unplugged
/// drive does not wipe the list).
#[tauri::command]
pub async fn recent_list(settings: State<'_, SettingsState>) -> Result<Vec<String>, String> {
    let s = settings.get();
    if !s.recent_enabled {
        return Ok(Vec::new());
    }
    let list = s.recent_files;
    Ok(existing_recent(&list, |p| Path::new(p).is_file()))
}

#[tauri::command]
pub fn recent_add(app: AppHandle, path: String, settings: State<SettingsState>) {
    settings.with_mut(|s| {
        if s.recent_enabled {
            push_recent(&mut s.recent_files, &path);
        }
    });
    schedule_save(&app);
}

#[tauri::command]
pub fn recent_clear(app: AppHandle, settings: State<SettingsState>) {
    settings.with_mut(|s| s.recent_files.clear());
    schedule_save(&app);
}

/* ---------- web search engine ---------- */

const MAX_ENGINE_LEN: usize = 500;
const MAX_SEARCH_CHARS: usize = 1000;

fn engine_template(id: &str) -> Option<&'static str> {
    match id {
        "bing" => Some("https://www.bing.com/search?q=%s"),
        "google" => Some("https://www.google.com/search?q=%s"),
        "duckduckgo" => Some("https://duckduckgo.com/?q=%s"),
        _ => None,
    }
}

/// "" and the three built-in ids are fine; anything else must be an http(s) URL containing `%s`.
/// None means invalid (keep the old value).
fn sanitize_search_engine(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || engine_template(t).is_some() {
        return Some(t.to_string());
    }
    let bad = |c: char| c.is_control() || c.is_whitespace() || matches!(c, '"' | '<' | '>');
    let scheme = t.starts_with("https://") || t.starts_with("http://");
    (scheme && t.contains("%s") && t.chars().count() <= MAX_ENGINE_LEN && !t.chars().any(bad))
        .then(|| t.to_string())
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The address to open for `query` with `engine`; None if no engine is chosen or the query is blank.
pub fn search_url(engine: &str, query: &str) -> Option<String> {
    let template = engine_template(engine).unwrap_or(engine);
    let template = sanitize_search_engine(template).filter(|t| !t.is_empty())?;
    let query: String = query.trim().chars().take(MAX_SEARCH_CHARS).collect();
    (!query.is_empty()).then(|| template.replace("%s", &percent_encode(&query)))
}

/* ---------- window size and position ---------- */

/// Outer position and inner size in physical pixels, as of the last exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeom {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

const MIN_WINDOW: u32 = 300;
const MAX_WINDOW: u32 = 20_000;

impl WindowGeom {
    pub fn from_value(v: &serde_json::Value) -> Option<Self> {
        let g: WindowGeom = serde_json::from_value(v.clone()).ok()?;
        g.sane().then_some(g)
    }

    fn sane(&self) -> bool {
        (MIN_WINDOW..=MAX_WINDOW).contains(&self.width)
            && (MIN_WINDOW..=MAX_WINDOW).contains(&self.height)
            && self.x.abs() <= 32_000
            && self.y.abs() <= 32_000
    }

    /// Visible enough to grab: the top strip (title bar) overlaps a monitor by at least 100 x 30 pixels, so a
    /// window saved on a monitor that is gone never opens off screen. `monitors` are (x, y, width, height).
    pub fn is_reachable(&self, monitors: &[(i32, i32, u32, u32)]) -> bool {
        monitors.iter().any(|&(mx, my, mw, mh)| {
            let left = self.x.max(mx);
            let right = (self.x + self.width as i32).min(mx + mw as i32);
            let top = self.y.max(my);
            let bottom = (self.y + 40).min(my + mh as i32);
            right - left >= 100 && bottom - top >= 30
        })
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(CONFIG_FILE))
}

/// Settings in memory plus the debounced-save bookkeeping.
pub struct SettingsState {
    current: Mutex<Settings>,
    /// Bumped on every change; a delayed save only runs if no newer change arrived.
    generation: AtomicU64,
    dirty: AtomicBool,
    /// Serializes writes (debounce thread vs. flush at exit).
    write_lock: Mutex<()>,
}

impl SettingsState {
    pub fn new(s: Settings) -> Self {
        SettingsState {
            current: Mutex::new(s),
            generation: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
            write_lock: Mutex::new(()),
        }
    }

    pub fn get(&self) -> Settings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Runs `f` on the settings and marks them unsaved. For changes that do not come from the generic patch
    /// (the AI commands).
    pub fn with_mut<R>(&self, f: impl FnOnce(&mut Settings) -> R) -> R {
        let mut g = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let r = f(&mut g);
        self.dirty.store(true, Ordering::SeqCst);
        r
    }

    /// Merges a partial update and marks the state unsaved. Returns the new settings.
    pub fn update(&self, patch: &serde_json::Value) -> Settings {
        let mut g = self.current.lock().unwrap_or_else(|e| e.into_inner());
        g.merge_json(patch);
        self.dirty.store(true, Ordering::SeqCst);
        g.clone()
    }
}

/// Reads the settings at startup. A legacy file is migrated (saved as `config.json`, old file removed).
pub fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = config_path(app) else {
        return Settings::default();
    };
    let legacy = app.path().app_data_dir().ok().map(|d| d.join(LEGACY_FILE));
    let (settings, loaded) = load_from(&path, legacy.as_deref());
    if let Loaded::Migrated { .. } = loaded
        && write_settings(&path, &settings).is_ok()
        && let Some(l) = legacy
    {
        let _ = fs::remove_file(l);
    }
    settings
}

fn write_settings(path: &Path, s: &Settings) -> Result<(), String> {
    write_atomic(path, &s.to_file_bytes()?)
}

/// Writes pending changes now (no-op if there are none). Called after the debounce and at exit.
pub fn flush(app: &AppHandle) {
    let Some(st) = app.try_state::<SettingsState>() else {
        return;
    };
    let _guard = st.write_lock.lock().unwrap_or_else(|e| e.into_inner());
    if !st.dirty.swap(false, Ordering::SeqCst) {
        return;
    }
    let result = config_path(app).and_then(|p| write_settings(&p, &st.get()));
    if let Err(e) = result {
        st.dirty.store(true, Ordering::SeqCst);
        eprintln!("my-note: could not save config: {e}");
    }
}

/// Saves shortly after the last change, so dragging a slider writes the file once.
pub fn schedule_save(app: &AppHandle) {
    let Some(st) = app.try_state::<SettingsState>() else {
        return;
    };
    let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEBOUNCE);
        if let Some(st) = app.try_state::<SettingsState>()
            && st.generation.load(Ordering::SeqCst) == generation
        {
            flush(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_session_is_deferred_until_asked_for() {
        assert!(!session_deferred(None, false)); // no file
        assert!(!session_deferred(Some(SESSION_INLINE_MAX), false)); // at the limit: sent now
        assert!(session_deferred(Some(SESSION_INLINE_MAX + 1), false));
        assert!(!session_deferred(Some(SESSION_INLINE_MAX + 1), true)); // the second request gets it all
        assert_ne!(SESSION_LARGE, b'{'); // cannot be mistaken for a session file
    }

    /// Empty scratch dir, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mynote-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self.path(name);
            fs::write(&p, bytes).unwrap();
            p
        }
        fn backups(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains(".invalid-"))
                .collect()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn defaults_are_solid_system_theme() {
        let s = Settings::default();
        assert_eq!(s.effects, Mode::Off);
        assert_eq!(s.theme, Theme::System);
        assert!(!s.reduce_effects);
        assert_eq!(
            (s.default_encoding.as_str(), s.default_line_ending.as_str()),
            ("utf-8", "crlf")
        );
        assert!(s.word_wrap && s.restore_session);
        assert_eq!((s.font_size, s.tab_size), (14, 8));
    }

    #[test]
    fn opacity_is_clamped() {
        assert_eq!(clamp_opacity(0.1), 0.5);
        assert_eq!(clamp_opacity(7.0), 1.0);
        assert_eq!(clamp_opacity(0.7), 0.7);
        assert_eq!(clamp_opacity(f64::NAN), DEFAULT_OPACITY);
    }

    #[test]
    fn invalid_fields_are_ignored_one_by_one() {
        let mut s = Settings::default();
        s.merge_json(&serde_json::json!({
            "theme": "dark", "effects": "sparkly", "opacity": 0.2, "reduceEffects": true,
            "defaultEncoding": "ebcdic", "defaultLineEnding": "lf", "wordWrap": "yes",
            "fontSize": 500, "tabSize": 0, "restoreSession": false,
        }));
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.effects, Mode::Off); // invalid value ignored
        assert_eq!(s.opacity, 0.5); // clamped
        assert!(s.reduce_effects);
        assert_eq!(s.default_encoding, "utf-8"); // unknown encoding ignored
        assert_eq!(s.default_line_ending, "lf");
        assert!(s.word_wrap); // wrong type ignored
        assert_eq!(s.font_size, 48); // clamped
        assert_eq!(s.tab_size, 1); // clamped
        assert!(!s.restore_session);
    }

    #[test]
    fn spelling_defaults_and_validation() {
        let mut s = Settings::default();
        assert!(s.spell_check && s.autocorrect);
        assert_eq!(s.spell_language, "en_US");
        assert_eq!(s.spell_dict_dir, "");
        let on: Vec<&str> = s
            .spell_types
            .iter()
            .filter(|(_, v)| **v)
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(on, ["markdown", "text", "untitled"]); // everything else off
        assert_eq!(s.spell_types.len(), 7);

        // A partial patch changes only the keys it names; unknown keys and non-booleans are ignored.
        s.merge_json(&serde_json::json!({
            "spellTypes": { "code": true, "markdown": false, "bogus": true, "web": "yes" },
            "spellCheck": false, "autocorrect": "no",
        }));
        assert!(s.spell_types["code"] && !s.spell_types["markdown"] && s.spell_types["text"]);
        assert!(!s.spell_types.contains_key("bogus") && !s.spell_types["web"]);
        assert!(!s.spell_check && s.autocorrect);

        // Language ids are file stems; folders have no control characters.
        s.merge_json(&serde_json::json!({ "spellLanguage": "bn_BD", "spellDictDir": "D:/dicts" }));
        assert_eq!(s.spell_language, "bn_BD");
        assert_eq!(s.spell_dict_dir, "D:/dicts");
        for bad in ["", "a/b", "../x", "x y", "a;b"] {
            s.merge_json(&serde_json::json!({ "spellLanguage": bad }));
            assert_eq!(s.spell_language, "bn_BD", "{bad:?}");
        }
        s.merge_json(&serde_json::json!({ "spellDictDir": "bad\ndir" }));
        assert_eq!(s.spell_dict_dir, "D:/dicts");
        s.merge_json(&serde_json::json!({ "spellDictDir": "" })); // clearing is allowed
        assert_eq!(s.spell_dict_dir, "");

        // It survives the file round trip.
        let bytes = s.to_file_bytes().unwrap();
        let mut back = Settings::default();
        back.merge_json(&serde_json::from_slice(&bytes).unwrap());
        assert_eq!(back.spell_types, s.spell_types);
        assert_eq!(back.spell_language, "bn_BD");
    }

    #[test]
    fn font_family_must_be_plain_text() {
        assert_eq!(
            sanitize_font_family("  Cascadia Code, Consolas "),
            Some("Cascadia Code, Consolas".into())
        );
        assert_eq!(sanitize_font_family(""), Some(String::new()));
        assert_eq!(sanitize_font_family("a; color: red"), None);
        assert_eq!(sanitize_font_family("a}b"), None);
        assert_eq!(sanitize_font_family("a\nb"), None);
        assert_eq!(sanitize_font_family(&"x".repeat(201)), None);
        let mut s = Settings::default();
        s.merge_json(&serde_json::json!({ "fontFamily": "Fira Code" }));
        s.merge_json(&serde_json::json!({ "fontFamily": "x;y" })); // rejected, old value stays
        assert_eq!(s.font_family, "Fira Code");
    }

    #[test]
    fn partial_update_keeps_other_fields() {
        let mut s = Settings::default();
        s.merge_json(&serde_json::json!({ "effects": "blur", "opacity": 0.6 }));
        s.merge_json(&serde_json::json!({ "theme": "light" }));
        assert_eq!(s.effects, Mode::Blur);
        assert_eq!(s.opacity, 0.6);
        assert_eq!(s.theme, Theme::Light);
    }

    #[test]
    fn missing_file_gives_defaults() {
        let d = Scratch::new("fresh");
        let (s, loaded) = load_from(&d.path(CONFIG_FILE), Some(&d.path(LEGACY_FILE)));
        assert_eq!(loaded, Loaded::Fresh);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn saved_file_round_trips_with_version() {
        let d = Scratch::new("roundtrip");
        let mut s = Settings::default();
        s.merge_json(&serde_json::json!({
            "theme": "dark", "fontSize": 18, "tabSize": 4, "fontFamily": "Consolas"
        }));
        let path = d.path(CONFIG_FILE);
        write_settings(&path, &s).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["version"], CONFIG_VERSION);
        assert!(!d.path("config.json.tmp").exists());
        let (back, loaded) = load_from(&path, None);
        assert_eq!(loaded, Loaded::Current);
        assert_eq!(back, s);
    }

    #[test]
    fn unversioned_file_is_migrated() {
        let d = Scratch::new("migrate-inplace");
        let path = d.write(
            CONFIG_FILE,
            br#"{"theme":"light","effects":"blur","opacity":0.7}"#,
        );
        let (s, loaded) = load_from(&path, None);
        assert_eq!(loaded, Loaded::Migrated { from: 0 });
        assert_eq!(
            (s.theme, s.effects, s.opacity),
            (Theme::Light, Mode::Blur, 0.7)
        );
        assert_eq!(s.font_size, 14); // new field took its default
        assert!(d.backups().is_empty());
    }

    #[test]
    fn legacy_settings_file_is_used_when_there_is_no_config() {
        let d = Scratch::new("migrate-legacy");
        let legacy = d.write(LEGACY_FILE, br#"{"theme":"dark","reduceEffects":true}"#);
        let (s, loaded) = load_from(&d.path(CONFIG_FILE), Some(&legacy));
        assert_eq!(loaded, Loaded::Migrated { from: 0 });
        assert_eq!(s.theme, Theme::Dark);
        assert!(s.reduce_effects);
        // A broken legacy file is ignored, not an error.
        let bad = d.write("bad-legacy.json", b"{{{");
        let (s, loaded) = load_from(&d.path(CONFIG_FILE), Some(&bad));
        assert_eq!((s, loaded), (Settings::default(), Loaded::Fresh));
    }

    #[test]
    fn migrate_stamps_the_current_version() {
        let mut v = serde_json::json!({ "theme": "dark" });
        migrate(&mut v, 0);
        assert_eq!(v["version"], CONFIG_VERSION);
        assert_eq!(v["theme"], "dark");
    }

    fn assert_recovered(d: &Scratch, content: &[u8]) {
        let path = d.write(CONFIG_FILE, content);
        let (s, loaded) = load_from(&path, None);
        assert_eq!(s, Settings::default());
        let Loaded::Recovered { backup: Some(b) } = loaded else {
            panic!("expected a backup, got {loaded:?}");
        };
        assert_eq!(
            fs::read(&b).unwrap(),
            content,
            "backup keeps the original bytes"
        );
        assert!(!path.exists(), "invalid file moved out of the way");
        assert_eq!(d.backups(), vec![b]);
    }

    #[test]
    fn invalid_json_is_backed_up_and_defaults_load() {
        assert_recovered(&Scratch::new("bad-json"), b"{ not json");
    }

    #[test]
    fn empty_file_is_invalid() {
        assert_recovered(&Scratch::new("bad-empty"), b"");
    }

    #[test]
    fn non_object_json_is_invalid() {
        assert_recovered(&Scratch::new("bad-array"), b"[1, 2, 3]");
    }

    #[test]
    fn newer_version_is_backed_up_not_overwritten() {
        let v = CONFIG_VERSION + 1;
        let text = format!(r#"{{"version":{v},"theme":"dark"}}"#);
        assert_recovered(&Scratch::new("bad-future"), text.as_bytes());
    }

    #[test]
    fn non_integer_version_is_invalid() {
        assert_recovered(&Scratch::new("bad-version"), br#"{"version":"one"}"#);
    }

    #[test]
    fn non_utf8_file_is_invalid() {
        assert_recovered(&Scratch::new("bad-utf8"), &[0xff, 0xfe, 0x00, 0x80]);
    }

    #[test]
    fn ai_config_is_saved_and_loaded_but_never_patched_in() {
        use crate::ai::{Consent, Kind};
        let mut s = Settings::default();
        assert!(!s.ai.enabled, "AI is off by default");
        s.ai = AiConfig::from_value(Some(&serde_json::json!({
            "enabled": true,
            "environments": [{ "id": "e1", "name": "Ollama", "kind": "ollama",
                "baseUrl": "http://localhost:11434", "consent": "denied" }]
        })));
        // The frontend payload (serialize) does not carry it; the file does.
        assert!(serde_json::to_value(&s).unwrap().get("ai").is_none());
        let d = Scratch::new("ai-roundtrip");
        let path = d.path(CONFIG_FILE);
        write_settings(&path, &s).unwrap();
        let (back, _) = load_from(&path, None);
        assert_eq!(back.ai, s.ai);
        assert_eq!(back.ai.environments[0].consent, Consent::Denied);
        assert_eq!(back.ai.environments[0].kind, Kind::Ollama);
        // A settings patch cannot touch it, even if it tries.
        let mut t = Settings::default();
        t.merge_json(&serde_json::json!({
            "ai": { "enabled": true, "environments": [{ "id": "x", "name": "x", "kind": "ollama",
                "baseUrl": "http://localhost:11434", "consent": "granted",
                "consentOrigin": "http://localhost:11434" }] }
        }));
        assert_eq!(t.ai, AiConfig::default());
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn recent_list_is_newest_first_without_duplicates() {
        let mut l = Vec::new();
        push_recent(&mut l, "/a.txt");
        push_recent(&mut l, "/b.txt");
        push_recent(&mut l, "/c.txt");
        push_recent(&mut l, "/a.txt"); // reopened: moves to the front, no second entry
        assert_eq!(l, strings(&["/a.txt", "/c.txt", "/b.txt"]));
    }

    #[test]
    #[cfg(windows)]
    fn recent_paths_ignore_case_on_windows() {
        let mut l = strings(&["C:\\Notes\\A.txt"]);
        push_recent(&mut l, "c:\\notes\\a.TXT");
        assert_eq!(l, strings(&["c:\\notes\\a.TXT"]));
    }

    #[test]
    fn recent_list_keeps_ten_and_drops_the_oldest() {
        let mut l = Vec::new();
        for i in 0..25 {
            push_recent(&mut l, &format!("/f{i}.txt"));
        }
        assert_eq!(l.len(), MAX_RECENT);
        assert_eq!(l[0], "/f24.txt");
        assert_eq!(l[MAX_RECENT - 1], "/f15.txt");
    }

    #[test]
    fn log_timestamp_defaults_on_and_can_be_switched_off() {
        let st = SettingsState::new(Settings::default());
        assert!(st.get().log_timestamp);
        assert!(
            !st.update(&serde_json::json!({ "logTimestamp": false }))
                .log_timestamp
        );
    }

    #[test]
    fn recent_off_switch_clears_the_list_and_stops_recording() {
        let st = SettingsState::new(Settings::default());
        st.with_mut(|s| push_recent(&mut s.recent_files, "/a.txt"));
        let s = st.update(&serde_json::json!({ "recentEnabled": false }));
        assert!(!s.recent_enabled && s.recent_files.is_empty());
        let s = st.update(&serde_json::json!({ "recentEnabled": true }));
        assert!(s.recent_enabled);
    }

    #[test]
    fn recent_list_rejects_bad_paths() {
        let mut l = Vec::new();
        push_recent(&mut l, "");
        push_recent(&mut l, "a\nb");
        push_recent(&mut l, &"x".repeat(MAX_PATH_LEN + 1));
        assert!(l.is_empty());
    }

    #[test]
    fn recent_list_loaded_from_a_damaged_file_is_cleaned() {
        let v = serde_json::json!(["/a", 5, null, "/b", "/a", "", "/c\u{0}"]);
        assert_eq!(parse_recent(Some(&v)), strings(&["/a", "/b"]));
        assert!(parse_recent(Some(&serde_json::json!("nope"))).is_empty());
        assert!(parse_recent(None).is_empty());
        let many: Vec<String> = (0..40).map(|i| format!("/f{i}")).collect();
        assert_eq!(
            parse_recent(Some(&serde_json::json!(many))).len(),
            MAX_RECENT
        );
    }

    #[test]
    fn missing_files_are_skipped_but_kept_in_order() {
        let l = strings(&["/a", "/gone", "/b"]);
        assert_eq!(
            existing_recent(&l, |p| p != "/gone"),
            strings(&["/a", "/b"])
        );
        assert_eq!(l.len(), 3); // the stored list is not touched
    }

    #[test]
    fn recent_list_and_window_survive_a_save_but_not_a_patch() {
        let d = Scratch::new("recent-roundtrip");
        let mut s = Settings::default();
        push_recent(&mut s.recent_files, "/a.txt");
        s.window = Some(WindowGeom {
            x: 10,
            y: 20,
            width: 900,
            height: 650,
            maximized: true,
        });
        assert!(
            serde_json::to_value(&s)
                .unwrap()
                .get("recentFiles")
                .is_none()
        );
        let path = d.path(CONFIG_FILE);
        write_settings(&path, &s).unwrap();
        let (back, _) = load_from(&path, None);
        assert_eq!(back, s);
        let mut t = Settings::default();
        t.merge_json(&serde_json::json!({
            "recentFiles": ["/evil"], "window": { "x": 0, "y": 0, "width": 500, "height": 500, "maximized": false }
        }));
        assert!(t.recent_files.is_empty() && t.window.is_none());
    }

    #[test]
    fn a2_settings_have_safe_defaults_and_are_validated() {
        let mut s = Settings::default();
        assert!(!s.auto_save, "auto-save is off by default");
        assert!(!s.show_control_chars && !s.print_landscape);
        assert_eq!((s.print_margin_mm, s.auto_save_seconds), (20, 5));
        assert_eq!(
            (s.print_header.as_str(), s.print_footer.as_str()),
            ("&f", "Page &p")
        );
        s.merge_json(&serde_json::json!({
            "autoSave": true, "autoSaveSeconds": 9999, "showControlChars": true,
            "printMarginMm": 90, "printLandscape": true,
            "printHeader": "&l&f&r&d", "printFooter": "x\ny"
        }));
        assert!(s.auto_save && s.show_control_chars && s.print_landscape);
        assert_eq!(s.auto_save_seconds, 600); // clamped
        assert_eq!(s.print_margin_mm, 50); // clamped
        assert_eq!(s.print_header, "&l&f&r&d");
        assert_eq!(s.print_footer, "Page &p"); // control character rejected, old value stays
        s.merge_json(&serde_json::json!({ "autoSaveSeconds": 0, "printHeader": "" }));
        assert_eq!((s.auto_save_seconds, s.print_header.as_str()), (1, ""));
        s.merge_json(&serde_json::json!({ "printFooter": "x".repeat(201) }));
        assert_eq!(s.print_footer, "Page &p");
    }

    #[test]
    fn new_settings_are_validated() {
        let mut s = Settings::default();
        assert!(s.status_bar && !s.open_in_new_window && s.search_engine.is_empty());
        s.merge_json(&serde_json::json!({
            "statusBar": false, "openInNewWindow": true, "searchEngine": "google"
        }));
        assert!(!s.status_bar && s.open_in_new_window);
        assert_eq!(s.search_engine, "google");
        s.merge_json(&serde_json::json!({ "searchEngine": "javascript:alert(%s)" }));
        s.merge_json(&serde_json::json!({ "searchEngine": "https://x.test/?q=" })); // no %s
        s.merge_json(&serde_json::json!({ "searchEngine": "https://x.test/ ?q=%s" })); // space
        assert_eq!(s.search_engine, "google"); // all rejected
        s.merge_json(&serde_json::json!({ "searchEngine": "https://x.test/find?q=%s" }));
        assert_eq!(s.search_engine, "https://x.test/find?q=%s");
        s.merge_json(&serde_json::json!({ "searchEngine": "" })); // "ask again"
        assert_eq!(s.search_engine, "");
    }

    #[test]
    fn search_urls_are_built_and_encoded() {
        assert_eq!(
            search_url("bing", "rust & cargo").as_deref(),
            Some("https://www.bing.com/search?q=rust%20%26%20cargo")
        );
        assert_eq!(
            search_url("duckduckgo", "a+b=c").as_deref(),
            Some("https://duckduckgo.com/?q=a%2Bb%3Dc")
        );
        assert_eq!(
            search_url("google", "বাংলা").as_deref(),
            Some("https://www.google.com/search?q=%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE")
        );
        assert_eq!(
            search_url("https://x.test/s/%s/go", " hi ").as_deref(),
            Some("https://x.test/s/hi/go")
        );
        // A query containing "%s" is encoded, not substituted again.
        assert_eq!(
            search_url("https://x.test/?q=%s", "100%s").as_deref(),
            Some("https://x.test/?q=100%25s")
        );
        assert_eq!(search_url("", "hi"), None); // no engine chosen
        assert_eq!(search_url("nope", "hi"), None);
        assert_eq!(search_url("bing", "   "), None);
        let long = "a".repeat(5000);
        assert_eq!(
            search_url("bing", &long).unwrap().len(),
            "https://www.bing.com/search?q=".len() + MAX_SEARCH_CHARS
        );
    }

    #[test]
    fn window_geometry_is_checked_against_the_monitors() {
        let screen = [(0, 0, 1920, 1080)];
        let g = |x, y| WindowGeom {
            x,
            y,
            width: 900,
            height: 650,
            maximized: false,
        };
        assert!(g(100, 100).is_reachable(&screen));
        assert!(g(1800, 100).is_reachable(&screen)); // 120 px still visible
        assert!(!g(1850, 100).is_reachable(&screen)); // only 70 px
        assert!(!g(100, 1070).is_reachable(&screen)); // title bar below the screen
        assert!(!g(-5000, 0).is_reachable(&screen)); // monitor unplugged
        assert!(g(-1000, 100).is_reachable(&[(-1920, 0, 1920, 1080), (0, 0, 1920, 1080)]));
        assert!(!g(100, 100).is_reachable(&[]));
        assert!(
            WindowGeom::from_value(
                &serde_json::json!({"x":0,"y":0,"width":900,"height":650,"maximized":false})
            )
            .is_some()
        );
        assert!(
            WindowGeom::from_value(
                &serde_json::json!({"x":0,"y":0,"width":10,"height":650,"maximized":false})
            )
            .is_none()
        );
        assert!(
            WindowGeom::from_value(
                &serde_json::json!({"x":-32001,"y":0,"width":900,"height":650,"maximized":false})
            )
            .is_none()
        );
        assert!(WindowGeom::from_value(&serde_json::json!("x")).is_none());
    }

    #[test]
    fn new_window_flag_is_found_after_the_program_name() {
        let args = |v: &[&str]| v.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert!(has_flag(
            args(&["app", NEW_WINDOW_FLAG, "a.txt"]).into_iter(),
            NEW_WINDOW_FLAG
        ));
        assert!(!has_flag(
            args(&[NEW_WINDOW_FLAG]).into_iter(),
            NEW_WINDOW_FLAG
        )); // argv[0] is the program
        assert!(!has_flag(
            args(&["app", "a.txt"]).into_iter(),
            NEW_WINDOW_FLAG
        ));
    }

    #[test]
    fn debounce_state_tracks_unsaved_changes() {
        let st = SettingsState::new(Settings::default());
        assert!(!st.dirty.load(Ordering::SeqCst));
        let s = st.update(&serde_json::json!({ "tabSize": 2 }));
        assert_eq!(s.tab_size, 2);
        assert_eq!(st.get().tab_size, 2);
        assert!(st.dirty.load(Ordering::SeqCst));
    }
}
