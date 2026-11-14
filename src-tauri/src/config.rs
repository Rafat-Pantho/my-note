//! Persisted app state: the session file (open tabs, unsaved text, view prefs) and the user settings.
//! The frontend owns the session JSON shape; Rust only stores it atomically in the app data dir.
//! Settings live in a versioned `config.json` in the app config dir. Rust owns and validates them:
//! changes apply in memory at once and are written (atomically) after a short debounce.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager,
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

/// Empty body when there is no saved session.
#[tauri::command]
pub async fn load_session(app: AppHandle) -> Result<Response, String> {
    let bytes = fs::read(data_file(&app, "session.json")?).unwrap_or_default();
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn save_session(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected a raw body".into());
    };
    write_atomic(&data_file(&app, "session.json")?, body)
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
    }

    /// The on-disk form: the settings plus the format version.
    pub fn to_file_bytes(&self) -> Result<Vec<u8>, String> {
        let mut v = serde_json::to_value(self).map_err(|e| e.to_string())?;
        v["ai"] = serde_json::to_value(&self.ai).map_err(|e| e.to_string())?;
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
