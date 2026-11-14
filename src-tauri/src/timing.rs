//! Startup timing, enabled with MYNOTE_TIMING=1. Prints ms since process start.

#[cfg(windows)]
fn since_process_start_ms() -> Option<f64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut create, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: all out-pointers are valid locals; GetCurrentProcess is a pseudo-handle.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut create,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return None;
    }
    let ticks = ((create.dwHighDateTime as u64) << 32) | create.dwLowDateTime as u64; // 100 ns since 1601
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000; // 1601 -> 1970
    let start_ms = ticks.checked_sub(EPOCH_DIFF_100NS)? as f64 / 10_000.0;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.0;
    Some(now_ms - start_ms)
}

#[cfg(not(windows))]
fn since_process_start_ms() -> Option<f64> {
    None
}

pub fn report(label: &str) {
    if std::env::var_os("MYNOTE_TIMING").is_some_and(|v| v == "1") {
        match since_process_start_ms() {
            Some(ms) => println!("[timing] {label}: {ms:.0} ms"),
            None => println!("[timing] {label}: unavailable"),
        }
    }
}
