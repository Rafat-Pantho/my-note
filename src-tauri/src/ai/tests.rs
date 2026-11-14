//! Gate, config and end-to-end tests. The network tests run against throwaway servers on 127.0.0.1 that
//! count the connections they receive.

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::json;
use tauri::async_runtime::block_on;

use super::net::{self, ChatMessage, ChatOptions, Role};
use super::*;

/* ---------- helpers ---------- */

fn env(kind: Kind, base: &str) -> Environment {
    Environment::new("e1".into(), kind, "Test", normalize_base_url(base).unwrap())
}

fn allow(mut e: Environment) -> Environment {
    e.consent = Consent::Granted;
    e.consent_origin = origin(&parsed(&e).unwrap());
    e.model = Some("m".into());
    e
}

fn cfg_of(e: Environment) -> AiConfig {
    AiConfig {
        enabled: true,
        active: Some(e.id.clone()),
        environments: vec![e],
        ..AiConfig::default()
    }
}

fn user(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: text.into(),
    }]
}

/// A key reader that fails the test if it is ever called.
fn no_keychain(_: &str) -> Result<Option<String>, String> {
    panic!("the keychain must not be read when consent is missing");
}

struct Mock {
    base: String,
    hits: Arc<AtomicUsize>,
}

impl Mock {
    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

/// Serves on a free local port. `handler` gets the request head (request line + headers) and the socket.
/// Every accepted connection is counted, whatever it asks.
fn serve(handler: impl Fn(&str, &mut TcpStream) + Send + Sync + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let handler = Arc::new(handler);
    let counter = hits.clone();
    thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            counter.fetch_add(1, Ordering::SeqCst);
            let handler = handler.clone();
            thread::spawn(move || {
                let head = read_head(&mut s);
                handler(&head, &mut s);
            });
        }
    });
    Mock {
        base: format!("http://{addr}"),
        hits,
    }
}

/// Reads the request head and discards any body.
fn read_head(s: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    while !buf.ends_with(b"\r\n\r\n") {
        if s.read(&mut byte).unwrap_or(0) == 0 {
            break;
        }
        buf.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let len = head
        .to_lowercase()
        .lines()
        .find_map(|l| {
            l.strip_prefix("content-length:")
                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
        })
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    let _ = s.read_exact(&mut body);
    head
}

fn reply(s: &mut TcpStream, status: &str, ctype: &str, body: &str) {
    let _ = write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Headers for a body that ends when the connection closes.
fn stream_head(s: &mut TcpStream, ctype: &str) {
    let _ = write!(
        s,
        "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nConnection: close\r\n\r\n"
    );
}

fn request_path(head: &str) -> &str {
    head.split_whitespace().nth(1).unwrap_or("")
}

fn collect_stream(cfg: &AiConfig, key: Option<&str>) -> Result<String, String> {
    let p = permit(cfg, "e1", |_| Ok(key.map(String::from)))?;
    block_on(async {
        let mut out = String::new();
        net::stream_chat(&p, &user("hi"), ChatOptions::default(), |t| {
            out.push_str(&t);
            true
        })
        .await?;
        Ok(out)
    })
}

fn models(cfg: &AiConfig, key: Option<&str>) -> Result<Vec<String>, String> {
    block_on(fetch_models(cfg, "e1", |_| Ok(key.map(String::from))))
}

/* ---------- urls ---------- */

#[test]
fn base_urls_are_validated_and_normalized() {
    assert_eq!(
        normalize_base_url(" http://localhost:11434/ ").unwrap(),
        "http://localhost:11434"
    );
    assert_eq!(
        normalize_base_url("https://api.openai.com/v1/").unwrap(),
        "https://api.openai.com/v1"
    );
    for bad in [
        "",
        "api.openai.com",
        "ftp://x.test",
        "file:///etc/passwd",
        "https://user:pw@x.test",
        "https://x.test/v1?key=1",
        "https://x.test/#frag",
        "javascript:alert(1)",
    ] {
        assert!(normalize_base_url(bad).is_err(), "{bad}");
    }
}

#[test]
fn only_this_machine_is_local() {
    let local = |s: &str| is_local(&Url::parse(s).unwrap());
    assert!(local("http://localhost:11434"));
    assert!(local("http://LOCALHOST"));
    assert!(local("http://foo.localhost:8080"));
    assert!(local("http://127.0.0.1:1234/v1"));
    assert!(local("http://127.5.5.5"));
    assert!(local("http://[::1]:8080"));
    assert!(!local("http://192.168.1.20:11434"));
    assert!(!local("http://10.0.0.5"));
    assert!(!local("http://localhost.evil.test"));
    assert!(!local("http://notlocalhost"));
    assert!(!local("https://api.openai.com/v1"));
    assert!(!local("http://0.0.0.0:11434"));
}

#[test]
fn plain_http_needs_ok_only_off_this_machine() {
    let needs = |s: &str| needs_insecure_ok(&Url::parse(s).unwrap());
    assert!(!needs("http://localhost:11434"));
    assert!(!needs("https://api.openai.com"));
    assert!(needs("http://192.168.1.20:11434"));
    assert!(needs("http://example.com/v1"));
}

/* ---------- config ---------- */

#[test]
fn ai_is_off_by_default() {
    let c = AiConfig::default();
    assert!(!c.enabled);
    assert!(c.environments.is_empty() && c.active.is_none());
    assert!(!c.status().enabled && c.status().env.is_none());
    assert_eq!(AiConfig::from_value(None), c);
    assert_eq!(AiConfig::from_value(Some(&json!("junk"))), c);
}

#[test]
fn config_round_trips() {
    let mut c = AiConfig::default();
    let id = c.add(Kind::Ollama, "Ollama", OLLAMA_URL).unwrap();
    let e = c.env_mut(&id).unwrap();
    e.models = vec!["a".into(), "b".into()];
    e.model = Some("b".into());
    e.consent = Consent::Granted;
    e.consent_origin = "http://localhost:11434".into();
    c.enabled = true;
    let back = AiConfig::from_value(Some(&serde_json::to_value(&c).unwrap()));
    assert_eq!(back, c);
    assert_eq!(back.active.as_deref(), Some(id.as_str()));
}

#[test]
fn loading_drops_bad_entries_and_untrusted_consent() {
    let good = json!({ "id": "e1", "name": "Good", "kind": "ollama", "baseUrl": "http://localhost:11434/",
        "consent": "granted", "consentOrigin": "http://localhost:11434",
        "models": ["a", "b"], "model": "zzz" });
    let moved = json!({ "id": "e2", "name": "Moved", "kind": "anthropic", "baseUrl": "https://evil.test",
        "consent": "granted", "consentOrigin": "https://api.anthropic.com" });
    let insecure = json!({ "id": "e3", "name": "Lan", "kind": "ollama", "baseUrl": "http://192.168.1.2:11434",
        "consent": "granted", "consentOrigin": "http://192.168.1.2:11434", "allowInsecure": false });
    let bad_url = json!({ "id": "e4", "name": "x", "kind": "gemini", "baseUrl": "not a url" });
    let bad_kind =
        json!({ "id": "e5", "name": "x", "kind": "skynet", "baseUrl": "https://x.test" });
    let bad_id =
        json!({ "id": "../x", "name": "x", "kind": "gemini", "baseUrl": "https://x.test" });
    let dup = json!({ "id": "e1", "name": "Dup", "kind": "gemini", "baseUrl": "https://x.test" });
    let cfg = AiConfig::from_value(Some(&json!({
        "enabled": true, "active": "e2",
        "environments": [good, moved, insecure, bad_url, bad_kind, bad_id, dup]
    })));
    let ids: Vec<&str> = cfg.environments.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["e1", "e2", "e3"]);
    assert!(cfg.enabled);
    assert_eq!(cfg.active.as_deref(), Some("e2"));
    let e1 = cfg.env("e1").unwrap();
    assert_eq!(e1.base_url, "http://localhost:11434");
    assert_eq!(e1.consent, Consent::Granted);
    assert_eq!(e1.model, None, "a model that is not in the list is dropped");
    assert_eq!(
        cfg.env("e2").unwrap().consent,
        Consent::Unset,
        "consent for another host does not carry over"
    );
    assert_eq!(
        cfg.env("e3").unwrap().consent,
        Consent::Unset,
        "remote plain http needs the accepted warning"
    );
    // An active id that points nowhere is cleared.
    let cfg = AiConfig::from_value(Some(&json!({ "active": "nope", "environments": [] })));
    assert_eq!(cfg.active, None);
}

#[test]
fn first_environment_becomes_active_and_limit_applies() {
    let mut c = AiConfig::default();
    let a = c
        .add(Kind::OpenaiCompatible, "  ", "https://a.test/v1")
        .unwrap();
    let b = c.add(Kind::Gemini, "G", "https://b.test").unwrap();
    assert_eq!(c.active.as_deref(), Some(a.as_str()));
    assert_ne!(a, b);
    assert_eq!(
        c.env(&a).unwrap().name,
        "OpenAI-compatible",
        "blank name gets the kind's default"
    );
    assert!(c.add(Kind::Ollama, "x", "ftp://nope").is_err());
    while c.environments.len() < MAX_ENVIRONMENTS {
        c.add(Kind::Ollama, "x", OLLAMA_URL).unwrap();
    }
    assert!(c.add(Kind::Ollama, "x", OLLAMA_URL).is_err());
}

#[test]
fn status_shows_active_environment_and_local_or_remote() {
    let mut c = cfg_of(allow(env(Kind::Ollama, OLLAMA_URL)));
    let s = c.status();
    let e = s.env.unwrap();
    assert!(s.enabled && e.local && e.ready);
    assert_eq!(
        (e.host.as_str(), e.name.as_str()),
        ("localhost:11434", "Test")
    );

    c.environments[0] = allow(env(Kind::Anthropic, "https://api.anthropic.com"));
    let e = c.status().env.unwrap();
    assert!(!e.local && e.ready);
    assert_eq!(e.host, "api.anthropic.com");

    c.environments[0].consent = Consent::Denied;
    assert!(!c.status().env.unwrap().ready);
}

/* ---------- consent gate ---------- */

#[test]
fn gate_refuses_without_consent() {
    let base = "https://api.example.com/v1";
    let mut c = cfg_of(env(Kind::OpenaiCompatible, base));
    c.environments[0].has_key = true;
    let err = |c: &AiConfig| permit(c, "e1", no_keychain).unwrap_err();

    assert!(
        err(&c).contains("Allow the connection to api.example.com"),
        "unset"
    );

    c.environments[0].consent = Consent::Denied;
    assert!(err(&c).contains("did not allow"), "denied");

    let mut granted = allow(c.environments[0].clone());
    granted.consent_origin = "https://other.test".into();
    c.environments[0] = granted;
    assert!(
        err(&c).contains("does not cover"),
        "granted for another origin"
    );

    c.environments[0] = allow(c.environments[0].clone());
    assert!(
        permit(&c, "missing", no_keychain)
            .unwrap_err()
            .contains("no longer exists")
    );
    c.enabled = false;
    assert!(err(&c).contains("AI is turned off"), "AI off beats consent");
}

#[test]
fn gate_opens_with_consent_and_reads_the_key_only_then() {
    let mut e = allow(env(Kind::Anthropic, "https://api.anthropic.com"));
    e.has_key = true;
    let c = cfg_of(e);
    let p = permit(&c, "e1", |id| {
        assert_eq!(id, "ai.e1");
        Ok(Some("sk-test".into()))
    })
    .unwrap();
    assert_eq!(p.key.as_deref(), Some("sk-test"));

    // A stored key that vanished from the keychain is a readable error, not a keyless request.
    assert!(
        permit(&c, "e1", |_| Ok(None))
            .unwrap_err()
            .contains("no longer in the OS keychain")
    );

    // Key-only providers refuse to run without one.
    let c = cfg_of(allow(env(Kind::Gemini, "https://g.test")));
    assert!(
        permit(&c, "e1", no_keychain)
            .unwrap_err()
            .contains("needs an API key")
    );
    // A local server may run without one.
    let c = cfg_of(allow(env(
        Kind::OpenaiCompatible,
        "http://localhost:1234/v1",
    )));
    assert!(permit(&c, "e1", no_keychain).unwrap().key.is_none());
}

#[test]
fn plain_http_to_a_remote_host_needs_the_warning_accepted() {
    let mut e = allow(env(Kind::Ollama, "http://192.168.1.20:11434"));
    assert!(!e.consent_valid());
    assert!(permit(&cfg_of(e.clone()), "e1", no_keychain).is_err());
    e.allow_insecure = true;
    assert!(e.consent_valid());
    assert!(permit(&cfg_of(e), "e1", no_keychain).is_ok());
}

/* ---------- consent denied: zero requests ---------- */

#[test]
fn denied_unset_off_and_moved_environments_make_zero_requests() {
    let mock = serve(|_, s| {
        reply(
            s,
            "200 OK",
            "application/json",
            r#"{"models":[{"name":"llama3"}]}"#,
        )
    });
    let base = mock.base.clone();

    let mut denied = env(Kind::Ollama, &base);
    denied.consent = Consent::Denied;
    let unset = env(Kind::Ollama, &base);
    let mut moved = allow(env(Kind::Ollama, &base));
    moved.consent_origin = "http://localhost:11434".into();
    let mut off = cfg_of(allow(env(Kind::Ollama, &base)));
    off.enabled = false;

    for cfg in [cfg_of(denied), cfg_of(unset), cfg_of(moved), off] {
        // Every entry point: listing and streaming both go through the gate.
        assert!(block_on(fetch_models(&cfg, "e1", no_keychain)).is_err());
        assert!(permit(&cfg, "e1", no_keychain).is_err());
    }
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        mock.hits(),
        0,
        "no connection may be attempted without consent"
    );

    // Control: the same server is reachable once the user has allowed it, so the zero above means something.
    let list = models(&cfg_of(allow(env(Kind::Ollama, &base))), None).unwrap();
    assert_eq!(list, ["llama3"]);
    assert_eq!(mock.hits(), 1);
}

/* ---------- end to end against mock servers ---------- */

#[test]
fn ollama_list_and_stream() {
    let mock = serve(|head, s| match request_path(head) {
        "/api/tags" => reply(
            s,
            "200 OK",
            "application/json",
            r#"{"models":[{"name":"qwen"},{"name":"llama3"}]}"#,
        ),
        "/api/chat" => {
            stream_head(s, "application/x-ndjson");
            let _ = s.write_all(b"{\"message\":{\"content\":\"Hel\"},\"done\":false}\n{\"message\":{\"content\":\"lo\"},\"done\":false}\n");
            let _ = s.write_all(b"{\"message\":{\"content\":\"\"},\"done\":true}\n");
        }
        _ => reply(s, "404 Not Found", "text/plain", "nope"),
    });
    let cfg = cfg_of(allow(env(Kind::Ollama, &mock.base)));
    assert_eq!(models(&cfg, None).unwrap(), ["llama3", "qwen"]);
    assert_eq!(collect_stream(&cfg, None).unwrap(), "Hello");
}

#[test]
fn openai_compatible_list_and_stream_send_the_bearer_key() {
    let mock = serve(|head, s| {
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer sk-test"),
            "{head}"
        );
        match request_path(head) {
            "/v1/models" => reply(
                s,
                "200 OK",
                "application/json",
                r#"{"data":[{"id":"gpt-x"}]}"#,
            ),
            "/v1/chat/completions" => {
                stream_head(s, "text/event-stream");
                let _ = s.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"!\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
            }
            _ => reply(s, "404 Not Found", "text/plain", ""),
        }
    });
    let mut e = allow(env(Kind::OpenaiCompatible, &format!("{}/v1", mock.base)));
    e.has_key = true;
    let cfg = cfg_of(e);
    assert_eq!(models(&cfg, Some("sk-test")).unwrap(), ["gpt-x"]);
    assert_eq!(collect_stream(&cfg, Some("sk-test")).unwrap(), "Hi!");
}

#[test]
fn anthropic_list_and_stream_send_their_headers() {
    let mock = serve(|head, s| {
        let h = head.to_lowercase();
        assert!(
            h.contains("x-api-key: sk-ant") && h.contains("anthropic-version: 2023-06-01"),
            "{head}"
        );
        assert!(!h.contains("authorization:"));
        match request_path(head).split('?').next().unwrap() {
            "/v1/models" => reply(
                s,
                "200 OK",
                "application/json",
                r#"{"data":[{"id":"claude-x"}],"has_more":false}"#,
            ),
            "/v1/messages" => {
                stream_head(s, "text/event-stream");
                let _ = s.write_all(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Yo\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
            }
            _ => reply(s, "404 Not Found", "text/plain", ""),
        }
    });
    let mut e = allow(env(Kind::Anthropic, &mock.base));
    e.has_key = true;
    let cfg = cfg_of(e);
    assert_eq!(models(&cfg, Some("sk-ant")).unwrap(), ["claude-x"]);
    assert_eq!(collect_stream(&cfg, Some("sk-ant")).unwrap(), "Yo");
}

#[test]
fn gemini_list_and_stream_end_with_the_connection() {
    let mock = serve(|head, s| {
        assert!(
            head.to_lowercase().contains("x-goog-api-key: g-key"),
            "{head}"
        );
        assert!(
            !request_path(head).contains("g-key"),
            "the key must not be in the URL"
        );
        let path = request_path(head).split('?').next().unwrap().to_string();
        if path == "/v1beta/models" {
            reply(
                s,
                "200 OK",
                "application/json",
                r#"{"models":[{"name":"models/gem","supportedGenerationMethods":["generateContent"]}]}"#,
            );
        } else if path == "/v1beta/models/m:streamGenerateContent" {
            stream_head(s, "text/event-stream");
            let _ = s.write_all(b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Sal\"}]}}]}\r\n\r\ndata: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ut\"}]},\"finishReason\":\"STOP\"}]}\r\n\r\n");
        } else {
            reply(s, "404 Not Found", "text/plain", &path);
        }
    });
    let mut e = allow(env(Kind::Gemini, &format!("{}/v1beta", mock.base)));
    e.has_key = true;
    let cfg = cfg_of(e);
    assert_eq!(models(&cfg, Some("g-key")).unwrap(), ["gem"]);
    assert_eq!(collect_stream(&cfg, Some("g-key")).unwrap(), "Salut");
}

#[test]
fn http_errors_have_readable_messages() {
    let mock = serve(|head, s| match request_path(head) {
        "/api/tags" => reply(
            s,
            "401 Unauthorized",
            "application/json",
            r#"{"error":"bad token"}"#,
        ),
        "/api/chat" => reply(
            s,
            "404 Not Found",
            "application/json",
            r#"{"error":"model 'm' not found"}"#,
        ),
        _ => reply(
            s,
            "503 Service Unavailable",
            "text/html",
            "<html>down</html>",
        ),
    });
    let cfg = cfg_of(allow(env(Kind::Ollama, &mock.base)));
    let e = models(&cfg, None).unwrap_err();
    assert!(
        e.contains("rejected the API key (401)") && e.contains("bad token"),
        "{e}"
    );
    let e = collect_stream(&cfg, None).unwrap_err();
    assert!(
        e.contains("404") && e.contains("model 'm' not found"),
        "{e}"
    );

    let cfg = cfg_of(allow(env(Kind::OpenaiCompatible, &mock.base)));
    let e = models(&cfg, None).unwrap_err();
    assert!(
        e.contains("server error (503)") && !e.contains("html"),
        "{e}"
    );
}

#[test]
fn nothing_listening_is_reported_as_not_running() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port(); // freed on drop
    let cfg = cfg_of(allow(env(
        Kind::Ollama,
        &format!("http://127.0.0.1:{port}"),
    )));
    let e = models(&cfg, None).unwrap_err();
    assert!(
        e.contains("Could not connect") && e.contains("Is the server running?"),
        "{e}"
    );
}

#[test]
fn not_a_model_server_is_reported() {
    let mock = serve(|_, s| reply(s, "200 OK", "text/html", "<html>hello</html>"));
    let cfg = cfg_of(allow(env(Kind::OpenaiCompatible, &mock.base)));
    assert!(models(&cfg, None).unwrap_err().contains("not JSON"));
}

#[test]
fn redirects_are_not_followed() {
    // The key must never follow a redirect to a host the user did not approve.
    let target = serve(|_, s| reply(s, "200 OK", "application/json", r#"{"data":[]}"#));
    let location = format!("{}/models", target.base);
    let origin_server = serve(move |_, s| {
        let _ = write!(
            s,
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
    });
    let cfg = cfg_of(allow(env(Kind::OpenaiCompatible, &origin_server.base)));
    let e = models(&cfg, None).unwrap_err();
    assert!(e.contains("302"), "{e}");
    thread::sleep(Duration::from_millis(200));
    assert_eq!(target.hits(), 0);
}

#[test]
fn aborting_a_stream_closes_the_connection() {
    let closed = Arc::new(AtomicBool::new(false));
    let flag = closed.clone();
    let mock = serve(move |_, s| {
        stream_head(s, "application/x-ndjson");
        // Endless reply, one piece every 20 ms, until the client goes away.
        loop {
            if s.write_all(b"{\"message\":{\"content\":\"x\"},\"done\":false}\n")
                .is_err()
                || s.flush().is_err()
            {
                flag.store(true, Ordering::SeqCst);
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let cfg = cfg_of(allow(env(Kind::Ollama, &mock.base)));
    let p = permit(&cfg, "e1", no_keychain).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let task = tauri::async_runtime::spawn(async move {
        net::stream_chat(&p, &user("hi"), ChatOptions::default(), |t| {
            tx.send(t).is_ok()
        })
        .await
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "x");
    task.inner().abort_handle().abort(); // what `ai_cancel` does
    assert!(block_on(task).is_err(), "the task reports it was cancelled");

    let start = Instant::now();
    while !closed.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        closed.load(Ordering::SeqCst),
        "the server saw the connection close"
    );
}

#[test]
fn stopping_from_the_callback_also_ends_the_request() {
    let closed = Arc::new(AtomicBool::new(false));
    let flag = closed.clone();
    let mock = serve(move |_, s| {
        stream_head(s, "text/event-stream");
        loop {
            if s.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"y\"}}]}\n\n")
                .is_err()
            {
                flag.store(true, Ordering::SeqCst);
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let cfg = cfg_of(allow(env(Kind::OpenaiCompatible, &mock.base)));
    let p = permit(&cfg, "e1", no_keychain).unwrap();
    let mut got = String::new();
    block_on(net::stream_chat(
        &p,
        &user("hi"),
        ChatOptions::default(),
        |t| {
            got.push_str(&t);
            false // the receiver is gone
        },
    ))
    .unwrap();
    assert_eq!(got, "y");
    let start = Instant::now();
    while !closed.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(closed.load(Ordering::SeqCst));
}

#[test]
fn request_ids_are_restricted() {
    assert!(valid_request_id("r-1_a"));
    assert!(!valid_request_id(""));
    assert!(!valid_request_id("a b"));
    assert!(!valid_request_id(&"a".repeat(65)));
}

#[test]
fn presets_are_validated_saved_and_loaded() {
    let mut c = AiConfig::default();
    c.save_preset(None, "  Pirate  ", "  Rewrite as a pirate.  ")
        .unwrap();
    assert_eq!(c.presets[0].name, "Pirate");
    assert_eq!(c.presets[0].instruction, "Rewrite as a pirate.");
    let id = c.presets[0].id.clone();
    c.save_preset(Some(&id), "Pirate 2", "Arr.").unwrap();
    assert_eq!(
        (c.presets.len(), c.presets[0].name.as_str()),
        (1, "Pirate 2")
    );
    assert!(c.save_preset(Some("nope"), "x", "y").is_err());
    assert!(c.save_preset(None, "  ", "y").unwrap_err().contains("name"));
    assert!(
        c.save_preset(None, "x", " ")
            .unwrap_err()
            .contains("instruction")
    );
    assert!(c.save_preset(None, &"n".repeat(61), "y").is_err());
    assert!(c.save_preset(None, "x", &"i".repeat(2001)).is_err());
    while c.presets.len() < MAX_PRESETS {
        c.save_preset(None, "p", "i").unwrap();
    }
    assert!(
        c.save_preset(None, "p", "i")
            .unwrap_err()
            .contains("too many")
    );
    let ids: std::collections::HashSet<_> = c.presets.iter().map(|p| p.id.clone()).collect();
    assert_eq!(ids.len(), MAX_PRESETS, "ids are unique");
    // Round trip, and bad entries in the file are dropped.
    let mut v = serde_json::to_value(&c).unwrap();
    v["presets"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "../x", "name": "bad", "instruction": "i" }));
    v["presets"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "pz", "name": "", "instruction": "i" }));
    let back = AiConfig::from_value(Some(&v));
    assert_eq!(back.presets, c.presets);
}
