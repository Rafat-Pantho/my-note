//! The only place that talks to the network. Every call needs a `Permit`, which `ai::permit` hands out only
//! when AI is on and the user has allowed this exact host. Request building and error wording are pure and
//! unit tested; the I/O functions are covered by the mock-server tests in `ai::tests`.

use std::{sync::OnceLock, time::Duration};

use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue},
    redirect,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    Kind, Permit,
    parse::{self, Item, StreamParser},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest silence allowed between two chunks of a reply. Generous: a local model may need a while to load.
const READ_TIMEOUT: Duration = Duration::from_secs(180);
const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_MAX_TOKENS: u32 = 4096;
const MAX_LIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// A request ready to send: nothing here touches the network.
#[derive(Debug)]
pub struct Prepared {
    pub url: Url,
    pub headers: HeaderMap,
    pub body: Option<Vec<u8>>,
}

fn secret_header(name: &'static str, value: &str) -> Result<(HeaderName, HeaderValue), String> {
    let mut v = HeaderValue::from_str(value)
        .map_err(|_| "The API key has characters that cannot be sent.")?;
    v.set_sensitive(true); // never shown in debug output
    Ok((HeaderName::from_static(name), v))
}

/// Per-provider authentication. Keys travel in headers, never in the URL (URLs end up in logs and errors).
fn auth_headers(kind: Kind, key: Option<&str>) -> Result<HeaderMap, String> {
    let mut h = HeaderMap::new();
    match kind {
        Kind::Anthropic => {
            h.insert(
                "anthropic-version",
                HeaderValue::from_static(ANTHROPIC_VERSION),
            );
            if let Some(k) = key {
                let (n, v) = secret_header("x-api-key", k)?;
                h.insert(n, v);
            }
        }
        Kind::Gemini => {
            if let Some(k) = key {
                let (n, v) = secret_header("x-goog-api-key", k)?;
                h.insert(n, v);
            }
        }
        Kind::Ollama | Kind::OpenaiCompatible => {
            if let Some(k) = key {
                let mut v = HeaderValue::from_str(&format!("Bearer {k}"))
                    .map_err(|_| "The API key has characters that cannot be sent.")?;
                v.set_sensitive(true);
                h.insert(AUTHORIZATION, v);
            }
        }
    }
    Ok(h)
}

fn join(base: &str, path: &str) -> Result<Url, String> {
    Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
        .map_err(|e| format!("Invalid base URL: {e}"))
}

pub fn list_request(kind: Kind, base: &str, key: Option<&str>) -> Result<Prepared, String> {
    let path = match kind {
        Kind::Ollama => "/api/tags",
        Kind::OpenaiCompatible => "/models",
        Kind::Anthropic => "/v1/models?limit=1000",
        Kind::Gemini => "/models?pageSize=1000",
    };
    Ok(Prepared {
        url: join(base, path)?,
        headers: auth_headers(kind, key)?,
        body: None,
    })
}

/// Gemini puts the model in the URL path, so it must be a plain id.
fn plain_model_id(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 128
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn chat_request(
    kind: Kind,
    base: &str,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
    key: Option<&str>,
) -> Result<Prepared, String> {
    if messages.is_empty() {
        return Err("There is nothing to send.".into());
    }
    let role = |r: Role| match r {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    let plain = || -> Vec<Value> {
        messages
            .iter()
            .map(|m| json!({ "role": role(m.role), "content": m.content }))
            .collect()
    };
    let (path, body) = match kind {
        Kind::Ollama => (
            "/api/chat".to_string(),
            json!({ "model": model, "messages": plain(), "stream": true }),
        ),
        Kind::OpenaiCompatible => (
            "/chat/completions".to_string(),
            json!({ "model": model, "messages": plain(), "stream": true }),
        ),
        Kind::Anthropic => {
            // The system prompt is a top-level field, not a message.
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m.role == Role::System)
                .map(|m| m.content.as_str())
                .collect();
            let rest: Vec<Value> = messages
                .iter()
                .filter(|m| m.role != Role::System)
                .map(|m| json!({ "role": role(m.role), "content": m.content }))
                .collect();
            if rest.is_empty() {
                return Err("There is nothing to send.".into());
            }
            let mut b = json!({
                "model": model, "max_tokens": max_tokens, "stream": true, "messages": rest
            });
            if !system.is_empty() {
                b["system"] = system.join("\n\n").into();
            }
            ("/v1/messages".to_string(), b)
        }
        Kind::Gemini => {
            if !plain_model_id(model) {
                return Err("The model name cannot be used in a request.".into());
            }
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m.role == Role::System)
                .map(|m| m.content.as_str())
                .collect();
            let contents: Vec<Value> = messages
                .iter()
                .filter(|m| m.role != Role::System)
                .map(|m| {
                    let r = if m.role == Role::Assistant {
                        "model"
                    } else {
                        "user"
                    };
                    json!({ "role": r, "parts": [{ "text": m.content }] })
                })
                .collect();
            if contents.is_empty() {
                return Err("There is nothing to send.".into());
            }
            let mut b = json!({ "contents": contents });
            if !system.is_empty() {
                b["systemInstruction"] = json!({ "parts": [{ "text": system.join("\n\n") }] });
            }
            (format!("/models/{model}:streamGenerateContent?alt=sse"), b)
        }
    };
    let mut headers = auth_headers(kind, key)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(Prepared {
        url: join(base, &path)?,
        headers,
        body: Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?),
    })
}

/* ---------- error wording ---------- */

/// The provider's own explanation, if the body has one. HTML pages and long text are dropped.
fn detail(body: &str) -> Option<String> {
    let t = body.trim();
    let msg = serde_json::from_str::<Value>(t)
        .ok()
        .and_then(|v| parse::error_message(&v))
        .or_else(|| {
            (!t.is_empty() && !t.starts_with('<') && t.len() < 300).then(|| t.to_string())
        })?;
    let msg: String = msg.chars().take(240).collect();
    (!msg.trim().is_empty()).then_some(msg)
}

/// A readable message for a non-2xx answer.
pub fn status_error(status: u16, body: &str, host: &str) -> String {
    let head = match status {
        401 => format!("{host} rejected the API key (401). Check the key."),
        403 => format!("{host} denied access (403). The key may not be allowed to do this."),
        404 => format!("{host} answered 404 (not found). Check the base URL and the model name."),
        408 | 504 => format!("{host} timed out ({status})."),
        429 => format!("{host} says too many requests or no quota left (429)."),
        500..=599 => format!("{host} had a server error ({status})."),
        _ => format!("{host} answered with error {status}."),
    };
    match detail(body) {
        Some(d) => format!("{head} {d}"),
        None => head,
    }
}

/// A readable message for a failure before or during the answer (not running, timeout, TLS...).
pub fn transport_error(e: &reqwest::Error, host: &str, local: bool) -> String {
    let mut chain = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        chain.push_str(" | ");
        chain.push_str(&s.to_string());
        src = s.source();
    }
    let lower = chain.to_lowercase();
    if e.is_timeout() {
        format!("Timed out waiting for {host}.")
    } else if lower.contains("certificate") {
        format!("The security certificate of {host} could not be verified.")
    } else if e.is_connect() {
        if local {
            format!("Could not connect to {host}. Is the server running?")
        } else {
            format!("Could not connect to {host}. Check the address and your network connection.")
        }
    } else {
        // The root cause reads better than reqwest's own "error sending request for url (...)".
        let reason = std::error::Error::source(e).map_or_else(|| e.to_string(), |s| s.to_string());
        format!("The request to {host} failed. {reason}")
    }
}

/* ---------- I/O ---------- */

/// Two clients: one for this machine that never uses a proxy (text for localhost must not go to a proxy),
/// one for everything else. Built on first use, never at startup. No redirects: a redirect could carry the
/// API key to a host the user did not approve.
fn client(local: bool) -> Result<&'static Client, String> {
    static LOCAL: OnceLock<Result<Client, String>> = OnceLock::new();
    static REMOTE: OnceLock<Result<Client, String>> = OnceLock::new();
    let cell = if local { &LOCAL } else { &REMOTE };
    cell.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default(); // Err = already installed
        let mut b = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .redirect(redirect::Policy::none());
        if local {
            b = b.no_proxy();
        }
        b.build()
            .map_err(|e| format!("Could not set up networking: {e}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

async fn send(
    p: &Permit,
    req: Prepared,
    timeout: Option<Duration>,
) -> Result<reqwest::Response, String> {
    let c = client(p.local())?;
    let mut rb = if req.body.is_some() {
        c.post(req.url)
    } else {
        c.get(req.url)
    };
    rb = rb.headers(req.headers);
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    if let Some(t) = timeout {
        rb = rb.timeout(t);
    }
    rb.send()
        .await
        .map_err(|e| transport_error(&e, &p.host(), p.local()))
}

/// Reads the body as text, stopping at `limit` bytes.
async fn read_text(mut r: reqwest::Response, limit: usize, p: &Permit) -> Result<String, String> {
    let mut buf = Vec::new();
    while let Some(chunk) = r
        .chunk()
        .await
        .map_err(|e| transport_error(&e, &p.host(), p.local()))?
    {
        buf.extend_from_slice(&chunk);
        if buf.len() >= limit {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Asks the environment which models it offers. Sends no user text.
pub async fn list_models(p: &Permit) -> Result<Vec<String>, String> {
    let req = list_request(p.env.kind, &p.env.base_url, p.key.as_deref())?;
    let resp = send(p, req, Some(LIST_TIMEOUT)).await?;
    let status = resp.status();
    let limit = if status.is_success() {
        MAX_LIST_BYTES
    } else {
        MAX_ERROR_BYTES
    };
    let body = read_text(resp, limit, p).await?;
    if !status.is_success() {
        return Err(status_error(status.as_u16(), &body, &p.host()));
    }
    parse::parse_models(p.env.kind, &body)
}

/// Streams a reply. `on_text` gets each piece of text and returns false to stop early. Dropping this future
/// (task abort) drops the response, which closes the connection and so stops the server's work too.
pub async fn stream_chat(
    p: &Permit,
    messages: &[ChatMessage],
    max_tokens: Option<u32>,
    mut on_text: impl FnMut(String) -> bool,
) -> Result<(), String> {
    let model = p
        .env
        .model
        .as_deref()
        .ok_or("No model is selected for this environment.")?;
    let req = chat_request(
        p.env.kind,
        &p.env.base_url,
        model,
        messages,
        max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        p.key.as_deref(),
    )?;
    let mut resp = send(p, req, None).await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = read_text(resp, MAX_ERROR_BYTES, p).await?;
        return Err(status_error(status, &body, &p.host()));
    }
    let mut parser = StreamParser::new(p.env.kind);
    loop {
        let chunk = resp
            .chunk()
            .await
            .map_err(|e| transport_error(&e, &p.host(), p.local()))?;
        let eof = chunk.is_none();
        let items = match chunk {
            Some(bytes) => parser.feed(&bytes),
            None => parser.finish(),
        };
        for item in items {
            match item {
                Item::Text(t) => {
                    if !on_text(t) {
                        return Ok(());
                    }
                }
                Item::Done => return Ok(()),
                Item::Error(m) => return Err(m),
            }
        }
        if eof {
            // `finish` always ends with Done or Error, so this is unreachable in practice.
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs() -> Vec<ChatMessage> {
        vec![
            ChatMessage {
                role: Role::System,
                content: "Be brief.".into(),
            },
            ChatMessage {
                role: Role::User,
                content: "Hi".into(),
            },
            ChatMessage {
                role: Role::Assistant,
                content: "Hello".into(),
            },
            ChatMessage {
                role: Role::User,
                content: "Bye".into(),
            },
        ]
    }

    fn body(p: &Prepared) -> Value {
        serde_json::from_slice(p.body.as_ref().unwrap()).unwrap()
    }

    #[test]
    fn list_urls_and_auth_per_kind() {
        let r = list_request(Kind::Ollama, "http://localhost:11434", None).unwrap();
        assert_eq!(r.url.as_str(), "http://localhost:11434/api/tags");
        assert!(r.headers.is_empty() && r.body.is_none());

        let r = list_request(
            Kind::OpenaiCompatible,
            "https://api.openai.com/v1",
            Some("sk-1"),
        )
        .unwrap();
        assert_eq!(r.url.as_str(), "https://api.openai.com/v1/models");
        assert_eq!(r.headers[AUTHORIZATION], "Bearer sk-1");
        assert!(r.headers[AUTHORIZATION].is_sensitive());

        let r = list_request(Kind::Anthropic, "https://api.anthropic.com", Some("k")).unwrap();
        assert_eq!(r.url.path(), "/v1/models");
        assert_eq!(r.headers["x-api-key"], "k");
        assert_eq!(r.headers["anthropic-version"], ANTHROPIC_VERSION);

        let r = list_request(
            Kind::Gemini,
            "https://generativelanguage.googleapis.com/v1beta/",
            Some("g"),
        )
        .unwrap();
        assert_eq!(r.url.path(), "/v1beta/models");
        assert_eq!(r.headers["x-goog-api-key"], "g");
        assert!(
            !r.url.as_str().contains("key="),
            "the key is never put in the URL"
        );
    }

    #[test]
    fn keys_with_bad_characters_are_rejected_not_sent() {
        assert!(list_request(Kind::Anthropic, "https://x.test", Some("a\nb")).is_err());
    }

    #[test]
    fn ollama_and_openai_chat_bodies() {
        let r = chat_request(
            Kind::Ollama,
            "http://localhost:11434",
            "llama3.2",
            &msgs(),
            100,
            None,
        )
        .unwrap();
        assert_eq!(r.url.path(), "/api/chat");
        let b = body(&r);
        assert_eq!(
            (b["model"].as_str(), b["stream"].as_bool()),
            (Some("llama3.2"), Some(true))
        );
        assert_eq!(b["messages"].as_array().unwrap().len(), 4);
        assert_eq!(b["messages"][0]["role"], "system");

        let r = chat_request(
            Kind::OpenaiCompatible,
            "http://localhost:1234/v1",
            "m",
            &msgs(),
            100,
            None,
        )
        .unwrap();
        assert_eq!(r.url.as_str(), "http://localhost:1234/v1/chat/completions");
        assert_eq!(body(&r)["stream"], true);
        assert!(
            r.headers.get(AUTHORIZATION).is_none(),
            "no key, no auth header"
        );
    }

    #[test]
    fn anthropic_chat_body_moves_system_out() {
        let r = chat_request(
            Kind::Anthropic,
            "https://api.anthropic.com",
            "claude-x",
            &msgs(),
            777,
            Some("k"),
        )
        .unwrap();
        assert_eq!(r.url.path(), "/v1/messages");
        let b = body(&r);
        assert_eq!(b["system"], "Be brief.");
        assert_eq!(b["max_tokens"], 777);
        assert_eq!(b["stream"], true);
        let roles: Vec<&str> = b["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
    }

    #[test]
    fn gemini_chat_body_and_url() {
        let r = chat_request(
            Kind::Gemini,
            "https://g.test/v1beta",
            "gemini-2.0-flash",
            &msgs(),
            1,
            Some("k"),
        )
        .unwrap();
        assert_eq!(
            r.url.path(),
            "/v1beta/models/gemini-2.0-flash:streamGenerateContent"
        );
        assert_eq!(r.url.query(), Some("alt=sse"));
        let b = body(&r);
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], "Be brief.");
        assert_eq!(b["contents"][1]["role"], "model");
        assert_eq!(b["contents"][2]["parts"][0]["text"], "Bye");
        // A model name that could break out of the path is refused.
        assert!(chat_request(Kind::Gemini, "https://g.test", "a/../b", &msgs(), 1, None).is_err());
        assert!(chat_request(Kind::Gemini, "https://g.test", "a?x=1", &msgs(), 1, None).is_err());
    }

    #[test]
    fn empty_conversation_is_refused() {
        assert!(chat_request(Kind::Ollama, "http://localhost:1", "m", &[], 1, None).is_err());
        let only_system = [ChatMessage {
            role: Role::System,
            content: "x".into(),
        }];
        assert!(
            chat_request(
                Kind::Anthropic,
                "https://a.test",
                "m",
                &only_system,
                1,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn status_errors_are_readable() {
        let h = "api.example.com";
        assert!(status_error(401, "", h).contains("rejected the API key (401)"));
        assert!(status_error(403, "", h).contains("denied access (403)"));
        assert!(status_error(404, "", h).contains("404"));
        assert!(status_error(429, "", h).contains("429"));
        assert!(status_error(503, "", h).contains("server error (503)"));
        let with = status_error(404, r#"{"error":"model 'x' not found"}"#, h);
        assert!(with.ends_with("model 'x' not found"), "{with}");
        let nested = status_error(400, r#"{"error":{"message":"bad request body"}}"#, h);
        assert!(nested.contains("bad request body"));
        // HTML error pages are not shown.
        assert!(!status_error(502, "<html><body>Bad gateway</body></html>", h).contains("html"));
    }
}
