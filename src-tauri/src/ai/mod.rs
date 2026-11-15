//! AI connection layer: environments (where AI runs), the consent gate, model lists and streaming.
//!
//! Rules this module enforces (see CLAUDE.md):
//! - AI is off until the user turns it on; nothing at startup touches the network, spawns anything or probes.
//! - A network call needs a `Permit`. `permit()` is the only way to get one, and it refuses unless AI is on,
//!   the environment's consent is `Granted`, and that consent was given for the environment's current origin.
//!   A denied or undecided environment makes zero requests.
//! - API keys live in the OS keychain only; the frontend can store one but never reads one back.
//! - The frontend never makes requests: it asks, Rust connects.

pub mod detect;
pub mod net;
pub mod parse;

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State, ipc::Channel};

use crate::{config, config::SettingsState, keychain};
use net::ChatMessage;

pub const OLLAMA_URL: &str = "http://localhost:11434";
const MAX_ENVIRONMENTS: usize = 16;
const MAX_NAME_CHARS: usize = 60;
const MAX_URL_CHARS: usize = 300;
const MAX_MODEL_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Ollama,
    OpenaiCompatible,
    Anthropic,
    Gemini,
}

impl Kind {
    /// Anthropic and Gemini cannot work without a key; the other two may (local servers).
    pub fn needs_key(self) -> bool {
        matches!(self, Kind::Anthropic | Kind::Gemini)
    }

    fn default_name(self) -> &'static str {
        match self {
            Kind::Ollama => "Ollama",
            Kind::OpenaiCompatible => "OpenAI-compatible",
            Kind::Anthropic => "Anthropic",
            Kind::Gemini => "Gemini",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Consent {
    #[default]
    Unset,
    Granted,
    Denied,
}

/// One place AI can run. Persisted in `config.json`; never holds a secret.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    /// Normalized: http(s), no credentials, no query, no trailing slash.
    pub base_url: String,
    /// Selected model; always one of `models`.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub consent: Consent,
    /// The origin (scheme://host:port) the user allowed. Consent only counts while it matches `base_url`.
    #[serde(default)]
    pub consent_origin: String,
    /// The user accepted the plain-http warning for this non-local host.
    #[serde(default)]
    pub allow_insecure: bool,
    /// A key is stored in the OS keychain for this environment (the key itself is not).
    #[serde(default)]
    pub has_key: bool,
    /// Cached answer of the last successful model listing, and when (unix seconds).
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub models_at: u64,
}

/// All AI settings. Lives inside `config::Settings` (as `ai`) but is only changed through the commands
/// below, never through the generic settings patch, so consent cannot be skipped.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// Master switch. Off by default; nothing connects while it is off.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub environments: Vec<Environment>,
    /// The user's own AI actions (name + instruction), shown in the AI menu.
    #[serde(default)]
    pub presets: Vec<Preset>,
}

/// A saved custom action. The instruction is sent to the model like the built-in ones.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub instruction: String,
}

const MAX_PRESETS: usize = 30;
const MAX_PRESET_NAME_CHARS: usize = 60;
const MAX_PRESET_INSTRUCTION_CHARS: usize = 2000;

/// Trims and checks a preset; the error is shown to the user.
fn clean_preset_fields(name: &str, instruction: &str) -> Result<(String, String), String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    let instruction = instruction.trim().to_string();
    if name.is_empty() {
        return Err("Give the preset a name.".into());
    }
    if name.chars().count() > MAX_PRESET_NAME_CHARS {
        return Err(format!(
            "The name is too long (limit {MAX_PRESET_NAME_CHARS} characters)."
        ));
    }
    if instruction.is_empty() {
        return Err("Write the instruction the preset should send.".into());
    }
    if instruction.chars().count() > MAX_PRESET_INSTRUCTION_CHARS {
        return Err(format!(
            "The instruction is too long (limit {MAX_PRESET_INSTRUCTION_CHARS} characters)."
        ));
    }
    Ok((name, instruction))
}

/* ---------- URLs ---------- */

/// Validates and normalizes a base URL: http or https, a host, no user info, query or fragment.
pub fn normalize_base_url(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Enter a base URL.".into());
    }
    if s.chars().count() > MAX_URL_CHARS {
        return Err("The base URL is too long.".into());
    }
    let url = Url::parse(s)
        .map_err(|_| "That is not a valid URL (example: https://api.example.com/v1).")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("The URL must start with http:// or https:// and have a host name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Do not put a user name or password in the URL.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The URL must not contain ? or #.".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// `host` or `host:port`, as shown to the user.
pub fn host_label(url: &Url) -> String {
    let host = url.host_str().unwrap_or("?");
    match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

/// True only for this machine: `localhost`, `*.localhost`, 127.0.0.0/8 and ::1. A LAN address is remote
/// (the text leaves this computer), whatever it looks like.
pub fn is_local(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    let h = host.to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost")
}

fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Plain http is fine on this machine; anywhere else it needs the user's explicit OK.
fn needs_insecure_ok(url: &Url) -> bool {
    url.scheme() == "http" && !is_local(url)
}

fn parsed(e: &Environment) -> Option<Url> {
    Url::parse(&e.base_url).ok()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn key_id(env_id: &str) -> String {
    format!("ai.{env_id}")
}

fn clean_name(raw: &str, kind: Kind) -> String {
    let n: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    if n.trim().is_empty() {
        kind.default_name().to_string()
    } else {
        n.trim().to_string()
    }
}

fn valid_env_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 24
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/* ---------- config ---------- */

impl Environment {
    /// Creates an environment with no consent, no key and no models.
    fn new(id: String, kind: Kind, name: &str, base_url: String) -> Self {
        Environment {
            id,
            name: clean_name(name, kind),
            kind,
            base_url,
            model: None,
            consent: Consent::Unset,
            consent_origin: String::new(),
            allow_insecure: false,
            has_key: false,
            models: Vec::new(),
            models_at: 0,
        }
    }

    /// Consent is only real if it was given for this exact origin (and, for plain http to a remote host,
    /// with the warning accepted). Anything else is undecided. Hand-edited files cannot skip the question
    /// by pointing an old "granted" at a new host.
    fn consent_valid(&self) -> bool {
        let Some(url) = parsed(self) else {
            return false;
        };
        self.consent == Consent::Granted
            && self.consent_origin == origin(&url)
            && (!needs_insecure_ok(&url) || self.allow_insecure)
    }

    fn view(&self) -> EnvView {
        let url = parsed(self);
        EnvView {
            env: self.clone(),
            host: url.as_ref().map(host_label).unwrap_or_default(),
            local: url.as_ref().is_some_and(is_local),
            secure: url.as_ref().is_some_and(|u| u.scheme() == "https"),
            needs_insecure_ok: url.as_ref().is_some_and(needs_insecure_ok),
            key_required: self.kind.needs_key(),
            consent_valid: self.consent_valid(),
        }
    }
}

impl AiConfig {
    pub fn env(&self, id: &str) -> Option<&Environment> {
        self.environments.iter().find(|e| e.id == id)
    }

    fn env_mut(&mut self, id: &str) -> Result<&mut Environment, String> {
        self.environments
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| "That environment no longer exists.".to_string())
    }

    /// Reads the `ai` object of config.json. Never fails: bad entries are dropped, bad fields fall back.
    pub fn from_value(v: Option<&Value>) -> AiConfig {
        let Some(v) = v.filter(|v| v.is_object()) else {
            return AiConfig::default();
        };
        let mut cfg = AiConfig {
            enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            ..AiConfig::default()
        };
        for raw in v
            .get("environments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Ok(mut e) = serde_json::from_value::<Environment>(raw.clone()) else {
                continue;
            };
            let Ok(url) = normalize_base_url(&e.base_url) else {
                continue;
            };
            if !valid_env_id(&e.id)
                || cfg.env(&e.id).is_some()
                || cfg.environments.len() >= MAX_ENVIRONMENTS
            {
                continue;
            }
            e.base_url = url;
            e.name = clean_name(&e.name, e.kind);
            e.models.truncate(1000);
            if e.model
                .as_ref()
                .is_some_and(|m| !e.models.contains(m) || m.chars().count() > MAX_MODEL_CHARS)
            {
                e.model = None;
            }
            if e.consent == Consent::Granted && !e.consent_valid() {
                e.consent = Consent::Unset;
                e.consent_origin.clear();
            }
            cfg.environments.push(e);
        }
        for raw in v
            .get("presets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Ok(p) = serde_json::from_value::<Preset>(raw.clone()) else {
                continue;
            };
            let Ok((name, instruction)) = clean_preset_fields(&p.name, &p.instruction) else {
                continue;
            };
            if valid_env_id(&p.id)
                && cfg.presets.iter().all(|x| x.id != p.id)
                && cfg.presets.len() < MAX_PRESETS
            {
                cfg.presets.push(Preset {
                    id: p.id,
                    name,
                    instruction,
                });
            }
        }
        cfg.active = v
            .get("active")
            .and_then(Value::as_str)
            .filter(|id| cfg.env(id).is_some())
            .map(str::to_string);
        cfg
    }

    /// Adds a preset, or replaces the one with `id`.
    fn save_preset(
        &mut self,
        id: Option<&str>,
        name: &str,
        instruction: &str,
    ) -> Result<(), String> {
        let (name, instruction) = clean_preset_fields(name, instruction)?;
        match id {
            Some(id) => {
                let p = self
                    .presets
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or("That preset no longer exists.")?;
                p.name = name;
                p.instruction = instruction;
            }
            None => {
                if self.presets.len() >= MAX_PRESETS {
                    return Err("There are too many presets. Delete one first.".into());
                }
                let mut n = now_secs() * 1000 + self.presets.len() as u64;
                let id = loop {
                    let id = format!("p{n:x}");
                    if self.presets.iter().all(|p| p.id != id) {
                        break id;
                    }
                    n += 1;
                };
                self.presets.push(Preset {
                    id,
                    name,
                    instruction,
                });
            }
        }
        Ok(())
    }

    fn unique_id(&self) -> String {
        let mut n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        loop {
            let id = format!("e{n:x}");
            if self.env(&id).is_none() {
                return id;
            }
            n += 1;
        }
    }

    fn add(&mut self, kind: Kind, name: &str, base_url: &str) -> Result<String, String> {
        if self.environments.len() >= MAX_ENVIRONMENTS {
            return Err("There are too many environments. Remove one first.".into());
        }
        let url = normalize_base_url(base_url)?;
        let id = self.unique_id();
        self.environments
            .push(Environment::new(id.clone(), kind, name, url));
        if self.active.is_none() {
            self.active = Some(id.clone());
        }
        Ok(id)
    }

    /// What the status bar needs. Computed from the settings only: no keychain, no network.
    pub fn status(&self) -> AiStatus {
        let env = self.active.as_deref().and_then(|id| self.env(id)).map(|e| {
            let v = e.view();
            ActiveEnv {
                id: e.id.clone(),
                name: e.name.clone(),
                kind: e.kind,
                model: e.model.clone(),
                host: v.host,
                local: v.local,
                consent: e.consent,
                ready: v.consent_valid,
            }
        });
        AiStatus {
            enabled: self.enabled,
            env,
        }
    }
}

/* ---------- views sent to the frontend ---------- */

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEnv {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub model: Option<String>,
    pub host: String,
    /// This computer (true) or another machine (false). Drives the status bar badge.
    pub local: bool,
    pub consent: Consent,
    /// Connections are allowed right now (AI on is checked separately via `AiStatus::enabled`).
    pub ready: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub enabled: bool,
    pub env: Option<ActiveEnv>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvView {
    #[serde(flatten)]
    env: Environment,
    host: String,
    local: bool,
    secure: bool,
    needs_insecure_ok: bool,
    key_required: bool,
    consent_valid: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiView {
    enabled: bool,
    active: Option<String>,
    environments: Vec<EnvView>,
    presets: Vec<Preset>,
    status: AiStatus,
}

fn view_of(cfg: &AiConfig) -> AiView {
    AiView {
        enabled: cfg.enabled,
        active: cfg.active.clone(),
        environments: cfg.environments.iter().map(Environment::view).collect(),
        presets: cfg.presets.clone(),
        status: cfg.status(),
    }
}

/* ---------- the gate ---------- */

/// Proof that AI is on and the user allowed this environment's host. Only `permit` makes one, and every
/// network function in `net` takes one.
#[derive(Debug)]
pub struct Permit {
    pub env: Environment,
    pub key: Option<String>,
}

impl Permit {
    fn url(&self) -> Option<Url> {
        parsed(&self.env)
    }

    pub fn host(&self) -> String {
        self.url().as_ref().map(host_label).unwrap_or_default()
    }

    pub fn local(&self) -> bool {
        self.url().as_ref().is_some_and(is_local)
    }
}

/// The consent check on its own: no keychain, no network.
fn check<'a>(cfg: &'a AiConfig, id: &str) -> Result<&'a Environment, String> {
    if !cfg.enabled {
        return Err("AI is turned off. Turn it on in Settings > AI.".into());
    }
    let env = cfg.env(id).ok_or("That environment no longer exists.")?;
    let host = env.view().host;
    match env.consent {
        Consent::Denied => Err(format!(
            "You did not allow connections to {host}. No connection was made. Allow it in Settings > AI to use it."
        )),
        _ if env.consent_valid() => Ok(env),
        Consent::Granted => Err(format!(
            "The permission for this environment does not cover {host}. Allow it again in Settings > AI."
        )),
        _ => Err(format!(
            "Allow the connection to {host} in Settings > AI first."
        )),
    }
}

/// The only way to a `Permit`. `read_key` is called only after the consent check passes.
pub fn permit(
    cfg: &AiConfig,
    id: &str,
    read_key: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<Permit, String> {
    let env = check(cfg, id)?;
    let key = if env.has_key {
        Some(read_key(&key_id(&env.id))?.ok_or(
            "The API key is no longer in the OS keychain. Enter it again in Settings > AI.",
        )?)
    } else if env.kind.needs_key() {
        return Err("This environment needs an API key. Enter one in Settings > AI.".into());
    } else {
        None
    };
    Ok(Permit {
        env: env.clone(),
        key,
    })
}

/// Lists the models an environment offers. Refuses (with no request) unless the user allowed it.
pub async fn fetch_models(
    cfg: &AiConfig,
    id: &str,
    read_key: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<Vec<String>, String> {
    let p = permit(cfg, id, read_key)?;
    net::list_models(&p).await
}

/* ---------- state ---------- */

enum Slot {
    /// Aborts the running stream.
    Running(Box<dyn Fn() + Send + Sync>),
    /// Cancel arrived before the stream registered; the stream stops as soon as it does.
    Cancelled,
}

/// Running streams by request id, so `ai_cancel` can abort one.
#[derive(Default)]
pub struct AiState {
    streams: Mutex<HashMap<String, Slot>>,
}

impl AiState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.streams.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/* ---------- commands ---------- */

fn snapshot(app: &AppHandle) -> AiConfig {
    app.state::<SettingsState>().get().ai
}

/// Changes the AI config, saves it at once (consent decisions are not worth debouncing) and returns the
/// new view. `f` failing leaves the config as it was.
fn mutate(
    app: &AppHandle,
    f: impl FnOnce(&mut AiConfig) -> Result<(), String>,
) -> Result<AiView, String> {
    let state = app.state::<SettingsState>();
    let cfg = state.with_mut(|s| {
        let mut next = s.ai.clone();
        f(&mut next)?;
        s.ai = next.clone();
        Ok::<_, String>(next)
    })?;
    config::flush(app);
    Ok(view_of(&cfg))
}

#[tauri::command]
pub fn ai_get(app: AppHandle) -> AiView {
    view_of(&snapshot(&app))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableResult {
    view: AiView,
    /// "found" (a new Ollama environment was added, awaiting consent), "present" (one already exists) or
    /// "not_found".
    ollama: &'static str,
}

/// The "Enable AI" click. Turns AI on and looks for an Ollama install by checking files (never running
/// it, never connecting). If one is found and there is no Ollama environment yet, adds one with consent
/// undecided: the frontend then asks.
#[tauri::command]
pub async fn ai_enable(app: AppHandle) -> Result<EnableResult, String> {
    let has_ollama = snapshot(&app)
        .environments
        .iter()
        .any(|e| e.kind == Kind::Ollama);
    let found = if has_ollama {
        false
    } else {
        tauri::async_runtime::spawn_blocking(|| detect::find_ollama().is_some())
            .await
            .map_err(|e| e.to_string())?
    };
    let view = mutate(&app, |c| {
        c.enabled = true;
        if found {
            c.add(Kind::Ollama, "Ollama", OLLAMA_URL)?;
        }
        Ok(())
    })?;
    Ok(EnableResult {
        view,
        ollama: if has_ollama {
            "present"
        } else if found {
            "found"
        } else {
            "not_found"
        },
    })
}

#[tauri::command]
pub fn ai_disable(app: AppHandle) -> Result<AiView, String> {
    mutate(&app, |c| {
        c.enabled = false;
        Ok(())
    })
}

#[tauri::command]
pub fn ai_add_env(
    app: AppHandle,
    kind: Kind,
    name: String,
    base_url: String,
) -> Result<AiView, String> {
    mutate(&app, |c| c.add(kind, &name, &base_url).map(|_| ()))
}

/// Renames and/or re-points an environment. A different origin voids the consent, the models and the
/// selected model: the user has to allow the new host.
#[tauri::command]
pub fn ai_update_env(
    app: AppHandle,
    id: String,
    name: Option<String>,
    base_url: Option<String>,
) -> Result<AiView, String> {
    mutate(&app, |c| {
        let e = c.env_mut(&id)?;
        if let Some(n) = name {
            e.name = clean_name(&n, e.kind);
        }
        if let Some(u) = base_url {
            let url = normalize_base_url(&u)?;
            if url != e.base_url {
                e.base_url = url;
                e.consent = Consent::Unset;
                e.consent_origin.clear();
                e.allow_insecure = false;
                e.models.clear();
                e.models_at = 0;
                e.model = None;
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_remove_env(app: AppHandle, id: String) -> Result<AiView, String> {
    // Forget the key first; if the keychain refuses, the environment stays so the key is not orphaned.
    if snapshot(&app).env(&id).is_some_and(|e| e.has_key) {
        keychain::delete(&key_id(&id))?;
    }
    mutate(&app, |c| {
        c.environments.retain(|e| e.id != id);
        if c.active.as_deref() == Some(id.as_str()) {
            c.active = c.environments.first().map(|e| e.id.clone());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn ai_set_active(app: AppHandle, id: String) -> Result<AiView, String> {
    mutate(&app, |c| {
        c.env_mut(&id)?;
        c.active = Some(id);
        Ok(())
    })
}

/// Stores the key in the OS keychain. This is the last time the frontend sees it.
#[tauri::command]
pub async fn ai_set_key(app: AppHandle, id: String, key: String) -> Result<AiView, String> {
    let key = key.trim();
    if snapshot(&app).env(&id).is_none() {
        return Err("That environment no longer exists.".into());
    }
    keychain::set(&key_id(&id), key)?;
    mutate(&app, |c| {
        c.env_mut(&id)?.has_key = true;
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_clear_key(app: AppHandle, id: String) -> Result<AiView, String> {
    if snapshot(&app).env(&id).is_none() {
        return Err("That environment no longer exists.".into());
    }
    keychain::delete(&key_id(&id))?;
    mutate(&app, |c| {
        c.env_mut(&id)?.has_key = false;
        Ok(())
    })
}

/// Records the user's decision for one environment. Allow = the user pressed Allow for the host shown;
/// it does not connect by itself. Plain http to a non-local host also needs `allow_insecure` (the user
/// accepted the warning).
#[tauri::command]
pub fn ai_set_consent(
    app: AppHandle,
    id: String,
    granted: bool,
    allow_insecure: bool,
) -> Result<AiView, String> {
    mutate(&app, |c| {
        let e = c.env_mut(&id)?;
        let url = parsed(e).ok_or("The base URL is not valid.")?;
        if granted {
            if needs_insecure_ok(&url) && !allow_insecure {
                return Err(format!(
                    "{} uses plain http, which is not encrypted. Confirm the warning to allow it.",
                    host_label(&url)
                ));
            }
            e.consent = Consent::Granted;
            e.consent_origin = origin(&url);
            e.allow_insecure = needs_insecure_ok(&url);
        } else {
            e.consent = Consent::Denied;
            e.consent_origin.clear();
            e.allow_insecure = false;
        }
        Ok(())
    })
}

/// Fetches the model list from the environment itself and caches it. Refuses unless allowed.
#[tauri::command]
pub async fn ai_list_models(app: AppHandle, id: String) -> Result<AiView, String> {
    let cfg = snapshot(&app);
    let base = cfg.env(&id).map(|e| e.base_url.clone());
    let models = fetch_models(&cfg, &id, keychain::get).await?;
    mutate(&app, |c| {
        // The environment may have been edited or removed while we waited.
        if let Ok(e) = c.env_mut(&id)
            && Some(&e.base_url) == base.as_ref()
        {
            e.models = models;
            e.models_at = now_secs();
            if e.model.as_ref().is_some_and(|m| !e.models.contains(m)) {
                e.model = None;
            }
            if e.model.is_none() && e.models.len() == 1 {
                e.model = e.models.first().cloned();
            }
        }
        Ok(())
    })
}

/// Picks the model to use. It must be one the environment returned.
#[tauri::command]
pub fn ai_set_model(app: AppHandle, id: String, model: Option<String>) -> Result<AiView, String> {
    mutate(&app, |c| {
        let e = c.env_mut(&id)?;
        if let Some(m) = &model
            && !e.models.contains(m)
        {
            return Err("That model is not in this environment's list. Refresh the list.".into());
        }
        e.model = model;
        Ok(())
    })
}

/// What the frontend receives while a reply streams.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Chunk {
        text: String,
    },
    /// `truncated`: the model stopped at its output limit, so the text is incomplete.
    Done {
        truncated: bool,
    },
    Cancelled,
    Error {
        message: String,
    },
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Streams a reply into `on_event`. Refuses (before any request) unless allowed. One terminal event ends
/// it: Done, Cancelled or Error. `ai_cancel(request_id)` aborts it.
#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    id: String,
    request_id: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    num_ctx: Option<u32>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    if !valid_request_id(&request_id) {
        return Err("invalid request id".into());
    }
    let permit = permit(&snapshot(&app), &id, keychain::get)?;
    let opts = net::ChatOptions {
        max_tokens: max_tokens
            .unwrap_or(net::DEFAULT_MAX_TOKENS)
            .clamp(1, 200_000),
        // Only Ollama reads it; keep it within what a desktop can plausibly load.
        num_ctx: num_ctx.map(|n| n.clamp(512, 131_072)),
    };

    let events = on_event.clone();
    let task = tauri::async_runtime::spawn(async move {
        net::stream_chat(&permit, &messages, opts, |text| {
            events.send(StreamEvent::Chunk { text }).is_ok()
        })
        .await
    });
    let abort = task.inner().abort_handle();
    {
        let state = app.state::<AiState>();
        let mut streams = state.lock();
        if matches!(streams.get(&request_id), Some(Slot::Cancelled)) {
            abort.abort();
        }
        streams.insert(
            request_id.clone(),
            Slot::Running(Box::new(move || abort.abort())),
        );
    }

    let outcome = task.await;
    app.state::<AiState>().lock().remove(&request_id);
    let last = match outcome {
        Ok(Ok(finish)) => StreamEvent::Done {
            truncated: finish.truncated,
        },
        Ok(Err(message)) => StreamEvent::Error { message },
        Err(_) => StreamEvent::Cancelled,
    };
    let _ = on_event.send(last);
    Ok(())
}

/// Aborts a running stream: the task is dropped, which closes the connection to the server.
#[tauri::command]
pub fn ai_cancel(state: State<AiState>, request_id: String) {
    let mut streams = state.lock();
    if let Some(Slot::Running(abort)) = streams.get(&request_id) {
        abort();
        return;
    }
    if streams.len() > 64 {
        streams.retain(|_, s| matches!(s, Slot::Running(_))); // stale early-cancel markers
    }
    streams.insert(request_id, Slot::Cancelled);
}

/// Adds or edits a saved preset (a custom AI action: name + instruction).
#[tauri::command]
pub fn ai_save_preset(
    app: AppHandle,
    id: Option<String>,
    name: String,
    instruction: String,
) -> Result<AiView, String> {
    mutate(&app, |c| c.save_preset(id.as_deref(), &name, &instruction))
}

#[tauri::command]
pub fn ai_delete_preset(app: AppHandle, id: String) -> Result<AiView, String> {
    mutate(&app, |c| {
        c.presets.retain(|p| p.id != id);
        Ok(())
    })
}

/// Opens https://ollama.com in the default browser. One fixed address, run only when the user clicks the
/// link in Settings > AI (a plain `<a>` would navigate the app's own webview away). It opens a web page; it
/// never starts Ollama or installs anything.
#[tauri::command]
pub fn open_ollama_site() -> Result<(), String> {
    crate::files::open_url("https://ollama.com")
}

#[cfg(test)]
mod tests;
