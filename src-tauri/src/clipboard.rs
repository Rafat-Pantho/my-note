//! Reading the clipboard for the editor's right-click Paste.
//!
//! The webview cannot do it: `navigator.clipboard.readText()` waits for a permission prompt that never
//! resolves in WebView2, and `execCommand("paste")` is refused. So the text comes from Rust, only when the
//! user clicks Paste. Windows reads the clipboard directly (APIs already in the dependency tree); other
//! systems report "unsupported" and the menu tells the user to press Ctrl+V instead.

/// The clipboard's text, or an empty string if it holds none.
#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    read_text()
}

#[cfg(windows)]
fn read_text() -> Result<String, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// CF_UNICODETEXT
    const UNICODE_TEXT: u32 = 13;
    // SAFETY: plain Win32 clipboard calls. The clipboard is closed on every path after a successful open,
    // the global memory is locked only while it is copied, and the read never goes past GlobalSize.
    unsafe {
        if OpenClipboard(null_mut()) == 0 {
            return Err("The clipboard is in use by another program. Try again.".into());
        }
        let handle = GetClipboardData(UNICODE_TEXT);
        let text = if handle.is_null() {
            String::new()
        } else {
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                String::new()
            } else {
                let max = GlobalSize(handle) / 2;
                let mut len = 0;
                while len < max && *ptr.add(len) != 0 {
                    len += 1;
                }
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                GlobalUnlock(handle);
                s
            }
        };
        CloseClipboard();
        Ok(text)
    }
}

#[cfg(not(windows))]
fn read_text() -> Result<String, String> {
    Err("unsupported".into())
}
