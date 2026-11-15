//! File IO: encoding and line-ending detection, decode/encode, and the file commands.
//!
//! Editor text is always `\n`-separated UTF-8; the original encoding and line ending
//! travel as metadata and are re-applied on save.

use std::{borrow::Cow, fs};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle,
    ipc::{InvokeBody, Request, Response},
};
use tauri_plugin_dialog::DialogExt;

/// Above this size the frontend asks before opening.
pub const LARGE_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf-8",
            Encoding::Utf8Bom => "utf-8-bom",
            Encoding::Utf16Le => "utf-16le",
            Encoding::Utf16Be => "utf-16be",
            Encoding::Windows1252 => "windows-1252",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "utf-8" => Encoding::Utf8,
            "utf-8-bom" => Encoding::Utf8Bom,
            "utf-16le" => Encoding::Utf16Le,
            "utf-16be" => Encoding::Utf16Be,
            "windows-1252" => Encoding::Windows1252,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEnding {
    Crlf,
    Lf,
    Cr,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Crlf => "crlf",
            LineEnding::Lf => "lf",
            LineEnding::Cr => "cr",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "crlf" => LineEnding::Crlf,
            "lf" => LineEnding::Lf,
            "cr" => LineEnding::Cr,
            _ => return None,
        })
    }

    fn sequence(self) -> &'static str {
        match self {
            LineEnding::Crlf => "\r\n",
            LineEnding::Lf => "\n",
            LineEnding::Cr => "\r",
        }
    }
}

pub struct Decoded {
    /// Text with every line ending normalized to `\n`, BOM removed.
    pub text: String,
    pub encoding: Encoding,
    pub line_ending: LineEnding,
}

/// Windows-1252 code points for bytes 0x80..=0x9F (undefined bytes map to the C1 control).
const CP1252_HIGH: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008D, 0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

/// Returns the encoding and the length of its BOM (0 if none).
pub fn detect_encoding(bytes: &[u8]) -> (Encoding, usize) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (Encoding::Utf8Bom, 3);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return (Encoding::Utf16Le, 2);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return (Encoding::Utf16Be, 2);
    }
    if let Some(enc) = sniff_utf16_without_bom(bytes) {
        return (enc, 0);
    }
    if std::str::from_utf8(bytes).is_ok() {
        (Encoding::Utf8, 0)
    } else {
        (Encoding::Windows1252, 0)
    }
}

/// Mostly-Latin UTF-16 has a zero byte in every other position.
fn sniff_utf16_without_bom(bytes: &[u8]) -> Option<Encoding> {
    let sample = &bytes[..bytes.len().min(4096) & !1];
    if sample.len() < 4 {
        return None;
    }
    let pairs = sample.len() / 2;
    let (mut even_zero, mut odd_zero) = (0usize, 0usize);
    for pair in sample.as_chunks::<2>().0 {
        even_zero += (pair[0] == 0) as usize;
        odd_zero += (pair[1] == 0) as usize;
    }
    if odd_zero * 10 >= pairs * 3 && even_zero * 20 < pairs {
        Some(Encoding::Utf16Le)
    } else if even_zero * 10 >= pairs * 3 && odd_zero * 20 < pairs {
        Some(Encoding::Utf16Be)
    } else {
        None
    }
}

/// Majority line ending, or `None` when the text has no line breaks.
pub fn detect_line_ending(text: &str) -> Option<LineEnding> {
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut bytes = text.bytes().peekable();
    while let Some(b) = bytes.next() {
        match b {
            b'\r' => {
                if bytes.peek() == Some(&b'\n') {
                    bytes.next();
                    crlf += 1;
                } else {
                    cr += 1;
                }
            }
            b'\n' => lf += 1,
            _ => {}
        }
    }
    if crlf + lf + cr == 0 {
        None
    } else if crlf >= lf && crlf >= cr {
        Some(LineEnding::Crlf)
    } else if lf >= cr {
        Some(LineEnding::Lf)
    } else {
        Some(LineEnding::Cr)
    }
}

pub fn normalize_newlines(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn apply_line_ending(text: &str, ending: LineEnding) -> Cow<'_, str> {
    match ending {
        LineEnding::Lf => Cow::Borrowed(text),
        other => Cow::Owned(text.replace('\n', other.sequence())),
    }
}

pub fn decode(bytes: &[u8]) -> Decoded {
    let (encoding, bom) = detect_encoding(bytes);
    let body = &bytes[bom..];
    let raw = match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => String::from_utf8_lossy(body).into_owned(),
        Encoding::Utf16Le => decode_utf16(body, u16::from_le_bytes),
        Encoding::Utf16Be => decode_utf16(body, u16::from_be_bytes),
        Encoding::Windows1252 => body
            .iter()
            .map(|&b| match b {
                0x80..=0x9F => {
                    char::from_u32(CP1252_HIGH[(b - 0x80) as usize] as u32).unwrap_or('?')
                }
                _ => b as char,
            })
            .collect(),
    };
    // New/empty files default to CRLF like Notepad.
    let line_ending = detect_line_ending(&raw).unwrap_or(LineEnding::Crlf);
    Decoded {
        text: normalize_newlines(raw),
        encoding,
        line_ending,
    }
}

fn decode_utf16(bytes: &[u8], from: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|&c| from(c)).collect();
    String::from_utf16_lossy(&units)
}

/// `text` uses `\n`; the line ending and encoding are applied here.
pub fn encode(text: &str, encoding: Encoding, ending: LineEnding) -> Vec<u8> {
    let text = apply_line_ending(text, ending);
    match encoding {
        Encoding::Utf8 => text.into_owned().into_bytes(),
        Encoding::Utf8Bom => {
            let mut out = Vec::with_capacity(text.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(text.as_bytes());
            out
        }
        Encoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
            out
        }
        Encoding::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            out.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
            out
        }
        Encoding::Windows1252 => text
            .chars()
            .map(|c| match c as u32 {
                0..=0x7F | 0xA0..=0xFF => c as u8,
                cp => CP1252_HIGH
                    .iter()
                    .position(|&h| h as u32 == cp)
                    .map_or(b'?', |i| 0x80 + i as u8),
            })
            .collect(),
    }
}

/// IPC bodies are `[u32 BE meta length][meta JSON][payload]` so big text travels as raw bytes.
fn split_body(body: &[u8]) -> Result<(&[u8], &[u8]), String> {
    let len_bytes: [u8; 4] = body
        .get(..4)
        .and_then(|b| b.try_into().ok())
        .ok_or("malformed request")?;
    let n = u32::from_be_bytes(len_bytes) as usize;
    let meta = body.get(4..4 + n).ok_or("malformed request")?;
    Ok((meta, &body[4 + n..]))
}

pub fn pack_body(meta: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + meta.len() + payload.len());
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(meta);
    out.extend_from_slice(payload);
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadMeta {
    encoding: &'static str,
    line_ending: &'static str,
    size: u64,
}

#[tauri::command]
pub async fn read_file(path: String, allow_large: bool) -> Result<Response, String> {
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > LARGE_FILE_BYTES && !allow_large {
        return Err(format!("large:{size}"));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let decoded = decode(&bytes);
    drop(bytes);
    let meta = serde_json::to_vec(&ReadMeta {
        encoding: decoded.encoding.as_str(),
        line_ending: decoded.line_ending.as_str(),
        size,
    })
    .map_err(|e| e.to_string())?;
    Ok(Response::new(pack_body(&meta, decoded.text.as_bytes())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteMeta {
    path: String,
    encoding: String,
    line_ending: String,
}

#[tauri::command]
pub async fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected a raw body".into());
    };
    let (meta, payload) = split_body(body)?;
    let meta: WriteMeta = serde_json::from_slice(meta).map_err(|e| e.to_string())?;
    let encoding = Encoding::parse(&meta.encoding).ok_or("unknown encoding")?;
    let ending = LineEnding::parse(&meta.line_ending).ok_or("unknown line ending")?;
    let text = std::str::from_utf8(payload).map_err(|e| e.to_string())?;
    fs::write(&meta.path, encode(text, encoding, ending)).map_err(|e| e.to_string())
}

fn path_string(p: tauri_plugin_dialog::FilePath) -> Option<String> {
    p.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pick_open_files(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(path_string)
        .collect()
}

#[tauri::command]
pub async fn pick_save_path(app: AppHandle, default_name: String) -> Option<String> {
    app.dialog()
        .file()
        .set_file_name(default_name)
        .blocking_save_file()
        .and_then(path_string)
}

/// Modified time (ms since 1970) and size of a file: what the "changed on disk" check compares.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub mtime_ms: u64,
    pub size: u64,
}

pub fn stamp_of(path: &str) -> Option<Stamp> {
    let m = fs::metadata(path).ok().filter(|m| m.is_file())?;
    let mtime_ms = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(Stamp {
        mtime_ms,
        size: m.len(),
    })
}

/// One stat per path (null if the file is gone). Called when the window regains focus, never in a loop:
/// there is no background file watcher.
#[tauri::command]
pub async fn file_stamps(paths: Vec<String>) -> Vec<Option<Stamp>> {
    paths.iter().take(500).map(|p| stamp_of(p)).collect()
}

/* ---------- things that start another program, each only on a user action ---------- */

/// Opens an http(s) address in the default browser. Nothing else is accepted (no file:, javascript:...).
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http and https addresses can be opened.".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the browser: {e}"))
}

/// Ctrl+E / Edit > Search web: opens the chosen engine with `query`. Fails with "no-engine" until the user
/// has picked one (the frontend then asks). Runs only on that explicit action.
#[tauri::command]
pub fn search_web(
    query: String,
    settings: tauri::State<crate::config::SettingsState>,
) -> Result<(), String> {
    let engine = settings.get().search_engine;
    if engine.is_empty() {
        return Err("no-engine".into());
    }
    let url = crate::config::search_url(&engine, &query).ok_or("Nothing to search for.")?;
    open_url(&url)
}

/// `/select,"<path>"` for Explorer (it wants backslashes and the quotes inside the one argument).
fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{}\"", path.replace('/', "\\"))
}

/// Shows the file in Explorer / Finder / the file manager.
#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("The file no longer exists.".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer.exe");
        c.raw_arg(explorer_select_arg(&path));
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.args(["-R", &path]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(p.parent().unwrap_or(p));
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the file manager: {e}"))
}

/// Starts another My Note window (a new process: no shared state, like starting the app again) that opens
/// `paths`. It starts with no session of its own (`--new-window`).
#[tauri::command]
pub fn new_window(paths: Vec<String>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(crate::config::NEW_WINDOW_FLAG);
    if std::env::args_os().any(|a| a == "--no-effects") {
        cmd.arg("--no-effects");
    }
    cmd.args(paths.iter().take(50).filter(|p| !p.starts_with('-')));
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start a new window: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_changes_with_content_and_is_none_when_missing() {
        let p = std::env::temp_dir().join(format!("mynote-stamp-{}.txt", std::process::id()));
        let path = p.to_string_lossy().into_owned();
        fs::write(&p, "one").unwrap();
        let a = stamp_of(&path).unwrap();
        assert_eq!(a.size, 3);
        assert_eq!(stamp_of(&path), Some(a)); // same file, same stamp
        fs::write(&p, "three").unwrap();
        assert_eq!(stamp_of(&path).unwrap().size, 5);
        fs::remove_file(&p).unwrap();
        assert_eq!(stamp_of(&path), None);
        assert_eq!(stamp_of(&std::env::temp_dir().to_string_lossy()), None); // a folder is not a file
    }

    #[test]
    fn explorer_argument_is_one_quoted_select() {
        assert_eq!(
            explorer_select_arg("C:/My Notes/a b.txt"),
            "/select,\"C:\\My Notes\\a b.txt\""
        );
    }

    #[test]
    fn only_web_addresses_can_be_opened() {
        for bad in [
            "file:///C:/x",
            "javascript:alert(1)",
            "calc.exe",
            "ftp://x",
            "",
        ] {
            assert!(open_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn detects_utf8_variants() {
        assert_eq!(detect_encoding(b"plain ascii"), (Encoding::Utf8, 0));
        assert_eq!(detect_encoding("héllo €".as_bytes()), (Encoding::Utf8, 0));
        assert_eq!(detect_encoding(b"\xEF\xBB\xBFhi"), (Encoding::Utf8Bom, 3));
        assert_eq!(detect_encoding(b""), (Encoding::Utf8, 0));
    }

    #[test]
    fn detects_utf16_with_and_without_bom() {
        assert_eq!(detect_encoding(b"\xFF\xFEh\0i\0"), (Encoding::Utf16Le, 2));
        assert_eq!(detect_encoding(b"\xFE\xFF\0h\0i"), (Encoding::Utf16Be, 2));
        assert_eq!(detect_encoding(b"h\0e\0l\0l\0o\0"), (Encoding::Utf16Le, 0));
        assert_eq!(detect_encoding(b"\0h\0e\0l\0l\0o"), (Encoding::Utf16Be, 0));
    }

    #[test]
    fn invalid_utf8_falls_back_to_windows_1252() {
        assert_eq!(detect_encoding(b"caf\xE9"), (Encoding::Windows1252, 0));
        let d = decode(b"caf\xE9 \x80 \x93q\x94");
        assert_eq!(d.text, "café € \u{201C}q\u{201D}");
        assert_eq!(d.encoding, Encoding::Windows1252);
    }

    #[test]
    fn decode_strips_boms() {
        assert_eq!(decode(b"\xEF\xBB\xBFabc").text, "abc");
        assert_eq!(decode(b"\xFF\xFEa\0b\0").text, "ab");
        assert_eq!(decode(b"\xFE\xFF\0a\0b").text, "ab");
    }

    #[test]
    fn detects_line_endings() {
        assert_eq!(detect_line_ending("a\r\nb\r\n"), Some(LineEnding::Crlf));
        assert_eq!(detect_line_ending("a\nb\n"), Some(LineEnding::Lf));
        assert_eq!(detect_line_ending("a\rb\r"), Some(LineEnding::Cr));
        assert_eq!(detect_line_ending("a\r\nb\nc\n"), Some(LineEnding::Lf));
        assert_eq!(detect_line_ending("no breaks"), None);
        assert_eq!(decode(b"no breaks").line_ending, LineEnding::Crlf);
    }

    #[test]
    fn normalizes_and_reapplies_line_endings() {
        let d = decode(b"a\r\nb\rc\nd");
        assert_eq!(d.text, "a\nb\nc\nd");
        assert_eq!(apply_line_ending("a\nb", LineEnding::Crlf), "a\r\nb");
        assert_eq!(apply_line_ending("a\nb", LineEnding::Cr), "a\rb");
        assert_eq!(apply_line_ending("a\nb", LineEnding::Lf), "a\nb");
    }

    #[test]
    fn round_trips_every_encoding() {
        let text = "line one\nline two é €\n";
        for enc in [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
            Encoding::Windows1252,
        ] {
            for ending in [LineEnding::Crlf, LineEnding::Lf, LineEnding::Cr] {
                let d = decode(&encode(text, enc, ending));
                assert_eq!(d.text, text, "{enc:?} {ending:?}");
                assert_eq!(d.encoding, enc, "{enc:?} {ending:?}");
                assert_eq!(d.line_ending, ending, "{enc:?} {ending:?}");
            }
        }
    }

    #[test]
    fn unencodable_chars_become_question_marks_in_1252() {
        assert_eq!(
            encode("a漢b", Encoding::Windows1252, LineEnding::Lf),
            b"a?b"
        );
    }

    #[test]
    fn body_framing_round_trips_and_rejects_garbage() {
        let packed = pack_body(b"{}", b"hello");
        assert_eq!(split_body(&packed).unwrap(), (&b"{}"[..], &b"hello"[..]));
        assert!(split_body(b"\0\0").is_err());
        assert!(split_body(&[0, 0, 0, 9, 1]).is_err());
    }
}
