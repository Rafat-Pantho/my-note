mod config;
mod effects;
mod files;
mod timing;

use std::sync::atomic::{AtomicBool, Ordering};

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

use config::{Settings, SettingsState};
use effects::{EffectsState, Mode, Status};

/// Until the frontend is up, window close is not intercepted (nothing to protect yet).
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn editor_ready() {
    FRONTEND_READY.store(true, Ordering::Relaxed);
    timing::report("editor ready");
}

#[tauri::command]
fn show_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    timing::report("window shown");
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// File paths passed on the command line ("Open with"). Flags are ignored.
#[tauri::command]
fn take_launch_args() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .map(|a| {
            std::path::absolute(&a)
                .unwrap_or_else(|_| a.into())
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

#[derive(Clone, Serialize)]
struct Appearance {
    settings: Settings,
    status: Status,
}

/// Settings plus what the window is really doing. Sync command: runs on the main thread.
#[tauri::command]
fn get_appearance(
    window: WebviewWindow,
    settings: State<SettingsState>,
    fx: State<EffectsState>,
) -> Appearance {
    let settings = settings.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let status = effects::apply(&window, &settings, &fx);
    fx.record(&status);
    Appearance { settings, status }
}

/// Merges a partial settings object (theme, effects, opacity, reduceEffects), saves it and re-applies.
#[tauri::command]
fn set_appearance(
    app: AppHandle,
    window: WebviewWindow,
    patch: serde_json::Value,
    settings: State<SettingsState>,
    fx: State<EffectsState>,
) -> Result<Appearance, String> {
    let mut guard = settings.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.merge_json(&patch);
    let settings = guard.clone();
    drop(guard);
    let saved = config::save_settings(&app, &settings);
    let status = effects::apply(&window, &settings, &fx);
    fx.record(&status);
    saved?;
    Ok(Appearance { settings, status })
}

/// Re-checks OS state (transparency toggled, high contrast, theme) and tells the frontend if the result
/// changed. Only does work while an effect is requested or the theme follows the OS.
fn refresh_appearance(app: &AppHandle) {
    let (Some(window), Some(settings), Some(fx)) = (
        app.get_webview_window("main"),
        app.try_state::<SettingsState>(),
        app.try_state::<EffectsState>(),
    ) else {
        return;
    };
    let settings = settings.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let status = effects::apply(&window, &settings, &fx);
    if fx.record(&status) {
        let _ = window.emit("appearance-changed", Appearance { settings, status });
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // First-launch state is solid (effects Off). Applied before the window is ever shown.
            let settings = config::load_settings(app.handle());
            let no_effects = std::env::args_os().any(|a| a == "--no-effects");
            app.manage(SettingsState(Mutex::new(settings.clone())));
            app.manage(EffectsState::new(no_effects));
            if let Some(window) = app.get_webview_window("main") {
                let fx = app.state::<EffectsState>();
                let status = effects::apply(&window, &settings, &fx);
                fx.record(&status);
                if settings.effects != Mode::Off && status.active == Mode::Off {
                    timing::report(&format!(
                        "effects fell back to solid: {}",
                        status.reason.unwrap_or_default()
                    ));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if FRONTEND_READY.load(Ordering::Relaxed) => {
                // The frontend asks about unsaved changes, then calls exit_app.
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
            WindowEvent::Focused(true) | WindowEvent::ThemeChanged(_) => {
                refresh_appearance(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            editor_ready,
            show_window,
            set_title,
            exit_app,
            take_launch_args,
            files::read_file,
            files::write_file,
            files::pick_open_files,
            files::pick_save_path,
            config::load_session,
            config::save_session,
            get_appearance,
            set_appearance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running My Note");
}
