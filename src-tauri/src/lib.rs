mod config;
mod files;
mod timing;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, WebviewWindow, WindowEvent};

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && FRONTEND_READY.load(Ordering::Relaxed)
            {
                // The frontend asks about unsaved changes, then calls exit_app.
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running My Note");
}
