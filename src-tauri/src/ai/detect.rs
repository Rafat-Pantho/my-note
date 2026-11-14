//! Ollama detection. File-existence checks only: the PATH folders and the known per-OS install locations.
//! The binary is never run, nothing is spawned and no connection is made. Called only when the user
//! clicks "Enable AI".

use std::{
    env,
    path::{Path, PathBuf},
};

#[cfg(windows)]
const EXE: &str = "ollama.exe";
#[cfg(not(windows))]
const EXE: &str = "ollama";

/// Where an installed Ollama may live, in the order we look. Empty entries are skipped by the caller.
fn known_locations(get: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(windows) {
        // The installer's default is the per-user %LOCALAPPDATA%\Programs\Ollama.
        if let Some(p) = get("LOCALAPPDATA") {
            v.push(p.join("Programs").join("Ollama").join(EXE));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = get(var) {
                v.push(p.join("Ollama").join(EXE));
            }
        }
    } else if cfg!(target_os = "macos") {
        v.push(PathBuf::from("/Applications/Ollama.app"));
        v.push(PathBuf::from("/usr/local/bin/ollama"));
        v.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        if let Some(h) = get("HOME") {
            v.push(h.join("Applications").join("Ollama.app"));
        }
    } else {
        for p in [
            "/usr/local/bin/ollama",
            "/usr/bin/ollama",
            "/bin/ollama",
            "/opt/ollama/bin/ollama",
            "/snap/bin/ollama",
        ] {
            v.push(PathBuf::from(p));
        }
    }
    v
}

/// Core of the check with the environment and the file system injected, so it is testable.
fn find_with(
    get: &dyn Fn(&str) -> Option<PathBuf>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = get("PATH")
        .into_iter()
        .flat_map(|p| env::split_paths(&p).collect::<Vec<_>>())
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(EXE));
    on_path.chain(known_locations(get)).find(|p| exists(p))
}

/// The path of an installed Ollama, if one is found by looking at files. Never runs anything.
pub fn find_ollama() -> Option<PathBuf> {
    find_with(&|k| env::var_os(k).map(PathBuf::from), &|p| {
        // `exists` (not `is_file`): on macOS the app is a folder.
        p.exists()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<PathBuf> + use<> {
        let m: HashMap<String, PathBuf> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), PathBuf::from(v)))
            .collect();
        move |k| m.get(k).cloned()
    }

    fn fs_of(paths: &[PathBuf]) -> impl Fn(&Path) -> bool + use<> {
        let s: HashSet<PathBuf> = paths.iter().cloned().collect();
        move |p| s.contains(p)
    }

    #[test]
    fn nothing_installed_finds_nothing() {
        let get = env_of(&[("PATH", "/a:/b"), ("LOCALAPPDATA", "/lad"), ("HOME", "/h")]);
        assert_eq!(find_with(&get, &|_| false), None);
    }

    #[test]
    fn found_on_path() {
        let dir = PathBuf::from("tools");
        let path = env::join_paths([PathBuf::from("other"), dir.clone()]).unwrap();
        let get = |k: &str| (k == "PATH").then(|| PathBuf::from(&path));
        let hit = dir.join(EXE);
        assert_eq!(
            find_with(&get, &fs_of(std::slice::from_ref(&hit))),
            Some(hit)
        );
    }

    #[cfg(windows)]
    #[test]
    fn found_in_localappdata_programs_ollama() {
        let get = env_of(&[("PATH", ""), ("LOCALAPPDATA", r"C:\Users\u\AppData\Local")]);
        let hit = PathBuf::from(r"C:\Users\u\AppData\Local")
            .join("Programs")
            .join("Ollama")
            .join("ollama.exe");
        assert_eq!(
            find_with(&get, &fs_of(std::slice::from_ref(&hit))),
            Some(hit)
        );
    }

    #[cfg(windows)]
    #[test]
    fn missing_env_variables_are_tolerated() {
        assert_eq!(find_with(&|_| None, &|_| false), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn found_in_known_unix_location() {
        let get = env_of(&[("PATH", ""), ("HOME", "/h")]);
        let hit = if cfg!(target_os = "macos") {
            PathBuf::from("/Applications/Ollama.app")
        } else {
            PathBuf::from("/usr/local/bin/ollama")
        };
        assert_eq!(
            find_with(&get, &fs_of(std::slice::from_ref(&hit))),
            Some(hit)
        );
    }
}
