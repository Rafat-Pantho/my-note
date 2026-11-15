mod ai;
mod clipboard;
mod config;
mod effects;
mod files;
mod keychain;
mod timing;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

use config::{Settings, SettingsState};
use effects::{EffectsState, Mode, Status};

/// Until the frontend is up, window close is not intercepted (nothing to protect yet).
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);

/// `marks` is only a timing breakdown from the page (ms since navigation start); it is printed with
/// MYNOTE_TIMING=1 and ignored otherwise.
#[tauri::command]
fn editor_ready(marks: Option<String>) {
    FRONTEND_READY.store(true, Ordering::Relaxed);
    timing::report("editor ready");
    if let Some(m) = marks {
        timing::report(&format!("page marks: {m}"));
    }
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
    config::flush(&app); // pending debounced settings
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
    /// Which AI environment is active and whether it is local or remote (status bar). Derived from the
    /// settings alone: no keychain access, no network.
    ai: ai::AiStatus,
}

impl Appearance {
    fn new(settings: Settings, status: Status) -> Self {
        let ai = settings.ai.status();
        Appearance {
            settings,
            status,
            ai,
        }
    }
}

/// Settings plus what the window is really doing. Sync command: runs on the main thread.
#[tauri::command]
fn get_settings(
    window: WebviewWindow,
    settings: State<SettingsState>,
    fx: State<EffectsState>,
) -> Appearance {
    let settings = settings.get();
    let status = effects::apply(&window, &settings, &fx);
    fx.record(&status);
    Appearance::new(settings, status)
}

/// Merges a partial settings object, applies it now and saves it after a short debounce.
/// Invalid fields are ignored (the reply carries the values actually in effect).
#[tauri::command]
fn set_settings(
    app: AppHandle,
    window: WebviewWindow,
    patch: serde_json::Value,
    settings: State<SettingsState>,
    fx: State<EffectsState>,
) -> Appearance {
    let settings = settings.update(&patch);
    config::schedule_save(&app);
    let status = effects::apply(&window, &settings, &fx);
    fx.record(&status);
    Appearance::new(settings, status)
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
    let settings = settings.get();
    let status = effects::apply(&window, &settings, &fx);
    if fx.record(&status) {
        let _ = window.emit("appearance-changed", Appearance::new(settings, status));
    }
}

pub fn run() {
    timing::report("run");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            timing::report("setup start");
            // First-launch state is solid (effects Off). Applied before the window is ever shown.
            let settings = config::load_settings(app.handle());
            let no_effects = std::env::args_os().any(|a| a == "--no-effects");
            app.manage(SettingsState::new(settings.clone()));
            app.manage(EffectsState::new(no_effects));
            app.manage(ai::AiState::default()); // an empty map: no I/O, no network
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
            timing::report("setup done");
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
            get_settings,
            set_settings,
            keychain::key_set,
            keychain::key_delete,
            keychain::key_has,
            ai::ai_get,
            ai::ai_enable,
            ai::ai_disable,
            ai::ai_add_env,
            ai::ai_update_env,
            ai::ai_remove_env,
            ai::ai_set_active,
            ai::ai_set_key,
            ai::ai_clear_key,
            ai::ai_set_consent,
            ai::ai_list_models,
            ai::ai_set_model,
            ai::ai_stream,
            ai::ai_cancel,
            ai::ai_save_preset,
            ai::ai_delete_preset,
            ai::open_ollama_site,
            clipboard::clipboard_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running My Note");
}
