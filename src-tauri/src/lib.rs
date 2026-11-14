mod timing;

use tauri::{Manager, WebviewWindow};

#[tauri::command]
fn editor_ready() {
    timing::report("editor ready");
}

#[tauri::command]
fn show_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    timing::report("window shown");
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![editor_ready, show_window])
        .setup(|app| {
            // Fail loudly if the main window is missing from the config.
            app.get_webview_window("main").expect("main window");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running My Note");
}
