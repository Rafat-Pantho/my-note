//! Window effects: Off (solid), Transparent, Blur.
//!
//! The decision (what to show, and why a request was downgraded) is pure and tested in `decide`.
//! Everything that touches the OS lives in `platform` and `apply`. Any failure ends in solid, with the
//! reason recorded in `Status`. The editor never depends on any of this working.
//!
//! Windows backend choice (from the window-vibrancy docs and its build gating):
//!   build >= 22621 (Win11 22H2+): Blur = Acrylic (system backdrop API, no known lag here)
//!   build 22000..22620 (Win11 21H2): Blur = Mica (Acrylic lags while moving/resizing on 22000)
//!   Windows 10: Blur unsupported (Acrylic and blur lag on 1903+), solid. Transparent still works.
//! The legacy `apply_blur` is never used (it lags on 22621+).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Theme as WinTheme, WebviewWindow, window::Color};

use crate::config::{Settings, Theme};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    Transparent,
    Blur,
}

// Mica/Acrylic exist only on Windows and Vibrancy only on macOS, so some variants are unused per platform.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    /// Solid window, nothing applied.
    Solid,
    /// Transparent window without a blur (see-through).
    Plain,
    Mica,
    Acrylic,
    Vibrancy,
}

impl Backend {
    fn as_str(self) -> &'static str {
        match self {
            Backend::Solid => "solid",
            Backend::Plain => "transparent",
            Backend::Mica => "mica",
            Backend::Acrylic => "acrylic",
            Backend::Vibrancy => "vibrancy",
        }
    }
}

/// What this OS/session can do, independent of user settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    /// Backend used for Blur mode; None when blur is not supported here.
    pub blur: Option<Backend>,
    /// A see-through window works (false on Linux without a compositor).
    pub transparent: bool,
}

/// Live OS preferences that force solid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Env {
    pub os_transparency_off: bool,
    pub high_contrast: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Switches {
    pub reduce_effects: bool,
    /// `--no-effects` on the command line.
    pub no_effects_flag: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Decision {
    pub active: Mode,
    pub backend: Backend,
    pub reason: Option<String>,
}

fn solid(reason: &str) -> Decision {
    Decision {
        active: Mode::Off,
        backend: Backend::Solid,
        reason: Some(reason.into()),
    }
}

/// Pure: requested mode + switches + OS state -> what to actually do.
/// Precedence: explicit Off, command-line flag, Reduce effects, OS settings, capability.
pub fn decide(req: Mode, sw: Switches, env: Env, caps: Caps) -> Decision {
    if req == Mode::Off {
        return Decision {
            active: Mode::Off,
            backend: Backend::Solid,
            reason: None,
        };
    }
    if sw.no_effects_flag {
        return solid("--no-effects flag");
    }
    if sw.reduce_effects {
        return solid("Reduce effects is on");
    }
    if env.high_contrast {
        return solid("High contrast mode is on");
    }
    if env.os_transparency_off {
        return solid("Transparency effects are turned off in the OS");
    }
    match req {
        Mode::Transparent if caps.transparent => Decision {
            active: Mode::Transparent,
            backend: Backend::Plain,
            reason: None,
        },
        Mode::Transparent => solid("No compositor: transparency is not available"),
        _ => match caps.blur {
            Some(b) => Decision {
                active: Mode::Blur,
                backend: b,
                reason: None,
            },
            None => solid("Blur is not supported on this system"),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub requested: Mode,
    pub active: Mode,
    pub backend: &'static str,
    /// Why the active mode differs from the request (None when it does not).
    pub reason: Option<String>,
    pub blur_supported: bool,
    pub transparent_supported: bool,
    /// Resolved light/dark of the window right now.
    pub dark: bool,
}

pub struct EffectsState {
    pub no_effects_flag: bool,
    /// Which backend is currently applied to the window, so it can be cleared before switching.
    applied: Mutex<Backend>,
    last: Mutex<Option<Status>>,
}

impl EffectsState {
    pub fn new(no_effects_flag: bool) -> Self {
        EffectsState {
            no_effects_flag,
            applied: Mutex::new(Backend::Solid),
            last: Mutex::new(None),
        }
    }

    /// Remembers `s`; true if it differs from the previous status.
    pub fn record(&self, s: &Status) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let changed = last.as_ref() != Some(s);
        *last = Some(s.clone());
        changed
    }
}

#[cfg(windows)]
mod platform {
    use super::{Backend, Caps, Env};
    use tauri::WebviewWindow;
    use windows_sys::Win32::{
        System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW},
        UI::{
            Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
            WindowsAndMessaging::{SPI_GETHIGHCONTRAST, SystemParametersInfoW},
        },
    };

    pub fn caps(_w: &WebviewWindow) -> Caps {
        let blur = match windows_version::OsVersion::current().build {
            22621.. => Some(Backend::Acrylic),
            22000.. => Some(Backend::Mica),
            _ => None,
        };
        Caps {
            blur,
            transparent: true,
        }
    }

    fn transparency_enabled() -> bool {
        let sub: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
            .encode_utf16()
            .collect();
        let name: Vec<u16> = "EnableTransparency\0".encode_utf16().collect();
        let mut value: u32 = 1;
        let mut size = size_of::<u32>() as u32;
        // SAFETY: valid NUL-terminated wide strings; `value` and `size` outlive the call.
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        // A missing value means the default, which is enabled.
        rc != 0 || value != 0
    }

    fn high_contrast() -> bool {
        let mut hc = HIGHCONTRASTW {
            cbSize: size_of::<HIGHCONTRASTW>() as u32,
            dwFlags: 0,
            lpszDefaultScheme: std::ptr::null_mut(),
        };
        // SAFETY: `hc` is a correctly sized, initialized HIGHCONTRASTW.
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                hc.cbSize,
                (&mut hc as *mut HIGHCONTRASTW).cast(),
                0,
            )
        };
        ok != 0 && hc.dwFlags & HCF_HIGHCONTRASTON != 0
    }

    pub fn env(_w: &WebviewWindow) -> Env {
        Env {
            os_transparency_off: !transparency_enabled(),
            high_contrast: high_contrast(),
        }
    }

    pub fn apply(w: &WebviewWindow, b: Backend) -> Result<(), String> {
        match b {
            Backend::Mica => window_vibrancy::apply_mica(w, None),
            Backend::Acrylic => window_vibrancy::apply_acrylic(w, None),
            _ => Ok(()),
        }
        .map_err(|e| e.to_string())
    }

    pub fn clear(w: &WebviewWindow, b: Backend) {
        let _ = match b {
            Backend::Mica => window_vibrancy::clear_mica(w),
            Backend::Acrylic => window_vibrancy::clear_acrylic(w),
            _ => Ok(()),
        };
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Backend, Caps, Env};
    use tauri::WebviewWindow;
    use window_vibrancy::NSVisualEffectMaterial;

    pub fn caps(_w: &WebviewWindow) -> Caps {
        Caps {
            blur: Some(Backend::Vibrancy),
            transparent: true,
        }
    }

    pub fn env(_w: &WebviewWindow) -> Env {
        Env::default()
    }

    pub fn apply(w: &WebviewWindow, b: Backend) -> Result<(), String> {
        match b {
            // WindowBackground follows the light/dark appearance of the window.
            Backend::Vibrancy => window_vibrancy::apply_vibrancy(
                w,
                NSVisualEffectMaterial::WindowBackground,
                None,
                None,
            ),
            _ => Ok(()),
        }
        .map_err(|e| e.to_string())
    }

    pub fn clear(w: &WebviewWindow, b: Backend) {
        if b == Backend::Vibrancy {
            let _ = window_vibrancy::clear_vibrancy(w);
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::{Backend, Caps, Env};
    use tauri::WebviewWindow;

    /// Translucency only if a compositor is running; blur is left to the compositor, not offered.
    pub fn caps(w: &WebviewWindow) -> Caps {
        #[cfg(target_os = "linux")]
        let composited = {
            use gtk::prelude::WidgetExt;
            w.gtk_window()
                .ok()
                .and_then(|g| g.screen())
                .is_some_and(|s| s.is_composited())
        };
        #[cfg(not(target_os = "linux"))]
        let composited = {
            let _ = w;
            false
        };
        Caps {
            blur: None,
            transparent: composited,
        }
    }

    pub fn env(_w: &WebviewWindow) -> Env {
        Env::default()
    }

    pub fn apply(_w: &WebviewWindow, _b: Backend) -> Result<(), String> {
        Ok(())
    }

    pub fn clear(_w: &WebviewWindow, _b: Backend) {}
}

/// Window background behind the webview: opaque theme color when solid (avoids a flash while resizing),
/// fully transparent when an effect is on. WebView2 only honors alpha 0 or 255.
fn window_color(dark: bool, effect: bool) -> Color {
    match (effect, dark) {
        (true, _) => Color(0, 0, 0, 0),
        (false, true) => Color(0x1e, 0x1e, 0x1e, 255),
        (false, false) => Color(0xff, 0xff, 0xff, 255),
    }
}

fn resolve_dark(w: &WebviewWindow, theme: Theme) -> bool {
    match theme {
        Theme::Dark => true,
        Theme::Light => false,
        Theme::System => w.theme().map(|t| t == WinTheme::Dark).unwrap_or(true),
    }
}

/// Brings the window in line with `settings`. Safe to call repeatedly; must run on the main thread
/// (sync commands and window events already do). Never fails: the worst case is a solid window.
pub fn apply(w: &WebviewWindow, settings: &Settings, fx: &EffectsState) -> Status {
    let _ = w.set_theme(match settings.theme {
        Theme::Light => Some(WinTheme::Light),
        Theme::Dark => Some(WinTheme::Dark),
        Theme::System => None,
    });
    let dark = resolve_dark(w, settings.theme);

    let caps = platform::caps(w);
    let env = platform::env(w);
    let sw = Switches {
        reduce_effects: settings.reduce_effects,
        no_effects_flag: fx.no_effects_flag,
    };
    let mut d = decide(settings.effects, sw, env, caps);

    let mut applied = fx.applied.lock().unwrap_or_else(|e| e.into_inner());
    if *applied != d.backend {
        platform::clear(w, *applied);
        *applied = Backend::Solid;
    }
    if d.backend != Backend::Solid && *applied != d.backend {
        match platform::apply(w, d.backend) {
            Ok(()) => *applied = d.backend,
            Err(e) => d = solid(&format!("{} failed: {e}", d.backend.as_str())),
        }
    }
    let _ = w.set_background_color(Some(window_color(dark, d.active != Mode::Off)));

    Status {
        requested: settings.effects,
        active: d.active,
        backend: d.backend.as_str(),
        reason: d.reason,
        blur_supported: caps.blur.is_some(),
        transparent_supported: caps.transparent,
        dark,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN11_22H2: Caps = Caps {
        blur: Some(Backend::Acrylic),
        transparent: true,
    };
    const WIN10: Caps = Caps {
        blur: None,
        transparent: true,
    };
    const LINUX_PLAIN: Caps = Caps {
        blur: None,
        transparent: false,
    };
    const SW: Switches = Switches {
        reduce_effects: false,
        no_effects_flag: false,
    };

    #[test]
    fn off_is_solid_without_a_reason() {
        let d = decide(Mode::Off, SW, Env::default(), WIN11_22H2);
        assert_eq!(
            (d.active, d.backend, d.reason),
            (Mode::Off, Backend::Solid, None)
        );
    }

    #[test]
    fn blur_uses_the_platform_backend() {
        let d = decide(Mode::Blur, SW, Env::default(), WIN11_22H2);
        assert_eq!(
            (d.active, d.backend, d.reason),
            (Mode::Blur, Backend::Acrylic, None)
        );
    }

    #[test]
    fn transparent_works_without_blur_support() {
        let d = decide(Mode::Transparent, SW, Env::default(), WIN10);
        assert_eq!((d.active, d.backend), (Mode::Transparent, Backend::Plain));
    }

    #[test]
    fn unsupported_modes_drop_to_solid_with_a_reason() {
        let d = decide(Mode::Blur, SW, Env::default(), WIN10);
        assert_eq!(d.active, Mode::Off);
        assert!(d.reason.unwrap().contains("not supported"));
        let d = decide(Mode::Transparent, SW, Env::default(), LINUX_PLAIN);
        assert_eq!(d.active, Mode::Off);
        assert!(d.reason.unwrap().contains("compositor"));
    }

    #[test]
    fn flag_and_reduce_effects_force_solid() {
        let flag = Switches {
            no_effects_flag: true,
            ..SW
        };
        let d = decide(Mode::Blur, flag, Env::default(), WIN11_22H2);
        assert_eq!(d.active, Mode::Off);
        assert_eq!(d.reason.as_deref(), Some("--no-effects flag"));
        let reduce = Switches {
            reduce_effects: true,
            ..SW
        };
        let d = decide(Mode::Transparent, reduce, Env::default(), WIN11_22H2);
        assert_eq!(d.active, Mode::Off);
        assert!(d.reason.unwrap().contains("Reduce effects"));
    }

    #[test]
    fn os_preferences_force_solid() {
        let env = Env {
            os_transparency_off: true,
            high_contrast: false,
        };
        assert_eq!(decide(Mode::Blur, SW, env, WIN11_22H2).active, Mode::Off);
        let env = Env {
            os_transparency_off: false,
            high_contrast: true,
        };
        assert_eq!(
            decide(Mode::Transparent, SW, env, WIN11_22H2).active,
            Mode::Off
        );
    }
}
