//! Persisted app state: the session file (open tabs, unsaved text, view prefs) and the user settings
//! (theme, window effects). The frontend owns the session JSON shape; Rust only stores it atomically in
//! the app data dir. Settings are owned and validated by Rust.

use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager,
    ipc::{InvokeBody, Request, Response},
};

use crate::effects::Mode;

fn data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Temp file + rename, so a crash never leaves a half-written file.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
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

pub const MIN_OPACITY: f64 = 0.5;
pub const MAX_OPACITY: f64 = 1.0;
/// Used only once the user opts in to Transparent or Blur.
pub const DEFAULT_OPACITY: f64 = 0.85;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

/// User choices, stored in `settings.json`. No secrets here, ever.
/// Defaults are the first-launch state: system theme, effects off (solid).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    pub effects: Mode,
    /// Background layer opacity, 0.5 to 1.0. Never applied to text.
    pub opacity: f64,
    /// Master switch: forces solid and turns off non-essential animation.
    pub reduce_effects: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: Theme::System,
            effects: Mode::Off,
            opacity: DEFAULT_OPACITY,
            reduce_effects: false,
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

impl Settings {
    /// Applies the fields present in `v` (a JSON object); anything missing or invalid is left alone.
    /// Used for both the file and the frontend's partial updates, so a hand-edited file never breaks startup.
    pub fn merge_json(&mut self, v: &serde_json::Value) {
        if let Some(t) = v
            .get("theme")
            .and_then(|x| serde_json::from_value(x.clone()).ok())
        {
            self.theme = t;
        }
        if let Some(m) = v
            .get("effects")
            .and_then(|x| serde_json::from_value(x.clone()).ok())
        {
            self.effects = m;
        }
        if let Some(o) = v.get("opacity").and_then(|x| x.as_f64()) {
            self.opacity = clamp_opacity(o);
        }
        if let Some(r) = v.get("reduceEffects").and_then(|x| x.as_bool()) {
            self.reduce_effects = r;
        }
    }

    pub fn from_json_str(s: &str) -> Settings {
        let mut out = Settings::default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            out.merge_json(&v);
        }
        out
    }
}

pub struct SettingsState(pub Mutex<Settings>);

pub fn load_settings(app: &AppHandle) -> Settings {
    data_file(app, "settings.json")
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| Settings::from_json_str(&s))
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&data_file(app, "settings.json")?, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_solid_system_theme() {
        let s = Settings::default();
        assert_eq!(s.effects, Mode::Off);
        assert_eq!(s.theme, Theme::System);
        assert!(!s.reduce_effects);
    }

    #[test]
    fn opacity_is_clamped() {
        assert_eq!(clamp_opacity(0.1), 0.5);
        assert_eq!(clamp_opacity(7.0), 1.0);
        assert_eq!(clamp_opacity(0.7), 0.7);
        assert_eq!(clamp_opacity(f64::NAN), DEFAULT_OPACITY);
    }

    #[test]
    fn corrupt_or_partial_files_fall_back_per_field() {
        assert_eq!(Settings::from_json_str("not json"), Settings::default());
        assert_eq!(Settings::from_json_str(""), Settings::default());
        let s = Settings::from_json_str(
            r#"{"theme":"dark","effects":"sparkly","opacity":0.2,"reduceEffects":true}"#,
        );
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.effects, Mode::Off); // invalid value ignored
        assert_eq!(s.opacity, 0.5); // clamped
        assert!(s.reduce_effects);
    }

    #[test]
    fn partial_update_keeps_other_fields() {
        let mut s = Settings::from_json_str(r#"{"effects":"blur","opacity":0.6}"#);
        s.merge_json(&serde_json::json!({ "theme": "light" }));
        assert_eq!(s.effects, Mode::Blur);
        assert_eq!(s.opacity, 0.6);
        assert_eq!(s.theme, Theme::Light);
    }
}
