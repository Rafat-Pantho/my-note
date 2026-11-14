//! Persisted app state. For now: the session file (open tabs, unsaved text, view prefs).
//! The frontend owns the JSON shape; Rust only stores it atomically in the app data dir.

use std::{fs, path::PathBuf};

use tauri::{
    AppHandle, Manager,
    ipc::{InvokeBody, Request, Response},
};

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// Empty body when there is no saved session.
#[tauri::command]
pub async fn load_session(app: AppHandle) -> Result<Response, String> {
    let bytes = fs::read(session_path(&app)?).unwrap_or_default();
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn save_session(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected a raw body".into());
    };
    let path = session_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
