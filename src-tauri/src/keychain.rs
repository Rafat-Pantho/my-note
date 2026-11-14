//! OS keychain wrapper (keyring crate). The frontend can store, delete and check for a key; there is
//! deliberately no command that returns one. Rust code that needs a key (the AI module, later) reads it
//! here, server side, and the secret never crosses the IPC boundary again after `key_set`.

use keyring::{Entry, Error};

const SERVICE: &str = "my-note";

/// Key ids are chosen by the app (e.g. "openai"), not free text: lowercase letters, digits, `-`, `_`, `.`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
}

fn entry(id: &str) -> Result<Entry, String> {
    if !valid_id(id) {
        return Err("invalid key id".into());
    }
    Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

/// Stores (or replaces) the secret.
pub fn set(id: &str, secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("the key is empty".into());
    }
    entry(id)?.set_password(secret).map_err(|e| e.to_string())
}

/// Removes the secret. Deleting a key that is not there is fine.
pub fn delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Reads the secret. Rust-only (the `ai` module): there is deliberately no command that returns it.
pub fn get(id: &str) -> Result<Option<String>, String> {
    match entry(id)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Async so a slow keychain (Linux unlock prompt) never blocks the UI.
#[tauri::command]
pub async fn key_set(id: String, secret: String) -> Result<(), String> {
    set(&id, &secret)
}

#[tauri::command]
pub async fn key_delete(id: String) -> Result<(), String> {
    delete(&id)
}

/// True if a secret is stored. The value itself is never returned.
#[tauri::command]
pub async fn key_has(id: String) -> Result<bool, String> {
    get(&id).map(|k| k.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_restricted() {
        assert!(valid_id("openai"));
        assert!(valid_id("my-host_1.api"));
        assert!(!valid_id(""));
        assert!(!valid_id("Has Space"));
        assert!(!valid_id("UPPER"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(&"a".repeat(65)));
        assert!(entry("bad id").is_err());
    }
}
