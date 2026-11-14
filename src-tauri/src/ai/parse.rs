//! Pure parsing for the four AI wire formats: streamed chat replies and model lists. No I/O, so every
//! format is covered by fixture-string tests. Input is raw bytes as they arrive from the socket (chunks can
//! split a line, or even a multi-byte character, anywhere).

use serde_json::Value;

use super::Kind;

/// What a stream produces, in order. After `Done` or `Error` the parser ignores further input.
#[derive(Debug, PartialEq, Eq)]
pub enum Item {
    Text(String),
    /// The model stopped because it hit its output limit: the text so far is incomplete. Comes before `Done`.
    Truncated,
    Done,
    Error(String),
}

/// Incremental parser for one streamed reply.
/// - Ollama: newline-delimited JSON objects.
/// - OpenAI-compatible, Anthropic, Gemini (`alt=sse`): server-sent events, one JSON object per `data:` line.
pub struct StreamParser {
    kind: Kind,
    buf: Vec<u8>,
    finished: bool,
}

impl StreamParser {
    pub fn new(kind: Kind) -> Self {
        StreamParser {
            kind,
            buf: Vec::new(),
            finished: false,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Item> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        self.buf.extend_from_slice(bytes);
        // `\n` never occurs inside a multi-byte UTF-8 sequence, so a complete line is always decodable.
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            self.line(&String::from_utf8_lossy(&line), &mut out);
            if self.finished {
                self.buf.clear();
                break;
            }
        }
        out
    }

    /// Call when the connection ends. Handles a last line with no newline. A stream with no terminator is an
    /// error, except Gemini, which has none: its end of stream is the end of the reply.
    pub fn finish(&mut self) -> Vec<Item> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            self.line(&String::from_utf8_lossy(&rest), &mut out);
        }
        if !self.finished {
            self.finished = true;
            out.push(if self.kind == Kind::Gemini {
                Item::Done
            } else {
                Item::Error(
                    "The server closed the connection before the reply was complete.".into(),
                )
            });
        }
        out
    }

    fn line(&mut self, raw: &str, out: &mut Vec<Item>) {
        let line = raw.trim_end_matches(['\n', '\r']);
        let payload = if self.kind == Kind::Ollama {
            line
        } else {
            // SSE: comments (":"), "event:", "id:", "retry:" and blank lines carry nothing we need.
            match line.strip_prefix("data:") {
                Some(rest) => rest.strip_prefix(' ').unwrap_or(rest),
                None => return,
            }
        };
        let payload = payload.trim();
        if payload.is_empty() {
            return;
        }
        let items = match self.kind {
            Kind::Ollama => ollama_line(payload),
            Kind::OpenaiCompatible => openai_event(payload),
            Kind::Anthropic => anthropic_event(payload),
            Kind::Gemini => gemini_event(payload),
        };
        for it in items {
            let last = matches!(it, Item::Done | Item::Error(_));
            out.push(it);
            if last {
                self.finished = true;
                return;
            }
        }
    }
}

/// The human-readable message in an API error object, whatever the provider's shape.
pub fn error_message(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    e.as_str()
        .or_else(|| e.get("message").and_then(Value::as_str))
        .map(str::to_string)
}

fn text(s: &str) -> Vec<Item> {
    if s.is_empty() {
        Vec::new()
    } else {
        vec![Item::Text(s.to_string())]
    }
}

fn ollama_line(payload: &str) -> Vec<Item> {
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return Vec::new();
    };
    if let Some(m) = error_message(&v) {
        return vec![Item::Error(m)];
    }
    let mut out = text(
        v.pointer("/message/content")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    if v.get("done").and_then(Value::as_bool) == Some(true) {
        if v.get("done_reason").and_then(Value::as_str) == Some("length") {
            out.push(Item::Truncated);
        }
        out.push(Item::Done);
    }
    out
}

fn openai_event(payload: &str) -> Vec<Item> {
    if payload == "[DONE]" {
        return vec![Item::Done];
    }
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return Vec::new();
    };
    if let Some(m) = error_message(&v) {
        return vec![Item::Error(m)];
    }
    let mut out = Vec::new();
    let mut finished = false;
    let mut cut = false;
    // `choices` can be empty (a trailing usage chunk) and `content` can be null (role-only first chunk).
    for c in v
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.extend(text(
            c.pointer("/delta/content")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ));
        finished |= c.get("finish_reason").is_some_and(|f| !f.is_null());
        cut |= c.get("finish_reason").and_then(Value::as_str) == Some("length");
    }
    if cut {
        out.push(Item::Truncated);
    }
    if finished {
        out.push(Item::Done);
    }
    out
}

fn anthropic_event(payload: &str) -> Vec<Item> {
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return Vec::new();
    };
    match v.get("type").and_then(Value::as_str) {
        Some("content_block_delta") => text(
            if v.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                v.pointer("/delta/text").and_then(Value::as_str)
            } else {
                None // thinking / tool-input deltas
            }
            .unwrap_or(""),
        ),
        Some("message_delta") => {
            if v.pointer("/delta/stop_reason").and_then(Value::as_str) == Some("max_tokens") {
                vec![Item::Truncated]
            } else {
                Vec::new()
            }
        }
        Some("message_stop") => vec![Item::Done],
        Some("error") => vec![Item::Error(
            error_message(&v).unwrap_or_else(|| "The API reported an error.".into()),
        )],
        _ => Vec::new(), // message_start, ping, content_block_start/stop
    }
}

/// Finish reasons that mean the reply was cut off by a safety system, not completed.
const GEMINI_BLOCKED: &[&str] = &[
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
];

fn gemini_event(payload: &str) -> Vec<Item> {
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return Vec::new();
    };
    if let Some(m) = error_message(&v) {
        return vec![Item::Error(m)];
    }
    if let Some(r) = v
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return vec![Item::Error(format!(
            "The request was blocked by the model ({r})."
        ))];
    }
    let mut out = Vec::new();
    for c in v
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for p in c
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            // Skip "thought" summaries; only the answer is text we hand back.
            if p.get("thought").and_then(Value::as_bool) != Some(true) {
                out.extend(text(p.get("text").and_then(Value::as_str).unwrap_or("")));
            }
        }
        if c.get("finishReason").and_then(Value::as_str) == Some("MAX_TOKENS") {
            out.push(Item::Truncated);
        }
        if let Some(r) = c.get("finishReason").and_then(Value::as_str)
            && GEMINI_BLOCKED.contains(&r)
        {
            out.push(Item::Error(format!("The model stopped the reply ({r}).")));
            return out;
        }
    }
    out
}

/* ---------- model lists ---------- */

const MAX_MODELS: usize = 1000;

fn names<'a>(
    v: &'a Value,
    array: &str,
    field: &'a str,
) -> Result<impl Iterator<Item = (&'a Value, &'a str)>, String> {
    let list = v
        .get(array)
        .and_then(Value::as_array)
        .ok_or("The server's reply is not a model list. Check the base URL.")?;
    Ok(list
        .iter()
        .filter_map(move |m| m.get(field).and_then(Value::as_str).map(|n| (m, n))))
}

/// Parses a model-list response body into sorted, de-duplicated model ids.
pub fn parse_models(kind: Kind, body: &str) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| "The server's reply is not JSON. Check the base URL.".to_string())?;
    if let Some(m) = error_message(&v) {
        return Err(m);
    }
    let mut out: Vec<String> = match kind {
        // Ollama /api/tags: {"models":[{"name":"llama3.2:latest",...}]}
        Kind::Ollama => names(&v, "models", "name")?
            .map(|(_, n)| n.to_string())
            .collect(),
        // OpenAI /models and Anthropic /v1/models: {"data":[{"id":...}]}
        Kind::OpenaiCompatible | Kind::Anthropic => names(&v, "data", "id")?
            .map(|(_, n)| n.to_string())
            .collect(),
        // Gemini /models: {"models":[{"name":"models/gemini-2.0-flash","supportedGenerationMethods":[..]}]}
        // Only models that can generate text are useful here (the list also has embedding models).
        Kind::Gemini => names(&v, "models", "name")?
            .filter(|(m, _)| {
                m.get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_none_or(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
            })
            .map(|(_, n)| n.strip_prefix("models/").unwrap_or(n).to_string())
            .collect(),
    };
    out.sort();
    out.dedup();
    out.truncate(MAX_MODELS);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds `input` in pieces of `step` bytes (any split point must give the same result) and collects text.
    fn run(kind: Kind, input: &str, step: usize) -> (String, Vec<Item>) {
        let mut p = StreamParser::new(kind);
        let mut items = Vec::new();
        for piece in input.as_bytes().chunks(step) {
            items.extend(p.feed(piece));
        }
        items.extend(p.finish());
        let text = items
            .iter()
            .filter_map(|i| match i {
                Item::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        (text, items)
    }

    fn check(kind: Kind, input: &str, want: &str) {
        for step in [input.len(), 1, 3, 7, 64] {
            let (text, items) = run(kind, input, step);
            assert_eq!(text, want, "step {step}");
            assert_eq!(items.last(), Some(&Item::Done), "step {step}: {items:?}");
            assert_eq!(
                items.iter().filter(|i| **i == Item::Done).count(),
                1,
                "exactly one Done"
            );
        }
    }

    const OLLAMA: &str = concat!(
        r#"{"model":"llama3.2","created_at":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"Hel"},"done":false}"#,
        "\n",
        r#"{"model":"llama3.2","message":{"role":"assistant","content":"lo é"},"done":false}"#,
        "\r\n",
        r#"{"model":"llama3.2","message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}"#,
        "\n",
        r#"{"model":"llama3.2","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":3}"#,
        "\n",
    );

    #[test]
    fn ollama_ndjson() {
        check(Kind::Ollama, OLLAMA, "Hello é");
    }

    #[test]
    fn ollama_final_line_without_newline_and_error_line() {
        let no_nl = OLLAMA.trim_end();
        check(Kind::Ollama, no_nl, "Hello é");
        let (_, items) = run(Kind::Ollama, "{\"error\":\"model 'x' not found\"}\n", 5);
        assert_eq!(items, vec![Item::Error("model 'x' not found".into())]);
    }

    const OPENAI: &str = concat!(
        ": keep-alive comment\n\n",
        "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" there\"},\"finish_reason\":null}]}\r\n\r\n",
        "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"total_tokens\":9}}\n\n",
        "data: [DONE]\n\n",
    );

    #[test]
    fn openai_sse() {
        check(Kind::OpenaiCompatible, OPENAI, "Hi there");
    }

    #[test]
    fn openai_done_marker_alone_and_data_without_space() {
        check(
            Kind::OpenaiCompatible,
            "data:{\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata:[DONE]\n",
            "x",
        );
    }

    #[test]
    fn openai_error_event() {
        let input =
            "data: {\"error\":{\"message\":\"Rate limit reached\",\"type\":\"rate_limit\"}}\n\n";
        let (_, items) = run(Kind::OpenaiCompatible, input, 9);
        assert_eq!(items, vec![Item::Error("Rate limit reached".into())]);
    }

    const ANTHROPIC: &str = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: ping\n",
        "data: {\"type\":\"ping\"}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"...\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\", world\"}}\n\n",
        "event: content_block_stop\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );

    #[test]
    fn anthropic_sse() {
        check(Kind::Anthropic, ANTHROPIC, "Hello, world");
    }

    #[test]
    fn anthropic_error_event() {
        let input = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let (_, items) = run(Kind::Anthropic, input, 11);
        assert_eq!(items, vec![Item::Error("Overloaded".into())]);
    }

    const GEMINI: &str = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Bonjour\"}],\"role\":\"model\"},\"index\":0}],\"usageMetadata\":{}}\r\n\r\n",
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"(thinking)\",\"thought\":true},{\"text\":\" le monde\"}],\"role\":\"model\"},\"index\":0}]}\r\n\r\n",
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"!\"}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}]}\r\n\r\n",
    );

    #[test]
    fn gemini_sse_ends_with_the_stream() {
        // No terminator in this format: closing the connection is "done".
        check(Kind::Gemini, GEMINI, "Bonjour le monde!");
    }

    #[test]
    fn gemini_blocked_and_error() {
        let blocked = "data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n\n";
        assert_eq!(
            run(Kind::Gemini, blocked, 8).1,
            vec![Item::Error(
                "The request was blocked by the model (SAFETY).".into()
            )]
        );
        let stopped = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"a\"}]},\"finishReason\":\"SAFETY\"}]}\n\n";
        assert_eq!(
            run(Kind::Gemini, stopped, 100).1,
            vec![
                Item::Text("a".into()),
                Item::Error("The model stopped the reply (SAFETY).".into())
            ]
        );
        let err = "data: {\"error\":{\"code\":400,\"message\":\"API key not valid.\"}}\n\n";
        assert_eq!(
            run(Kind::Gemini, err, 100).1,
            vec![Item::Error("API key not valid.".into())]
        );
    }

    #[test]
    fn output_limit_is_reported_as_truncated_for_every_format() {
        let cases: [(Kind, &str); 4] = [
            (
                Kind::Ollama,
                "{\"message\":{\"content\":\"a\"},\"done\":false}
{\"message\":{\"content\":\"\"},\"done\":true,\"done_reason\":\"length\"}
",
            ),
            (
                Kind::OpenaiCompatible,
                "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}

data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}

data: [DONE]

",
            ),
            (
                Kind::Anthropic,
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}

data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}

data: {\"type\":\"message_stop\"}

",
            ),
            (
                Kind::Gemini,
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"a\"}]},\"finishReason\":\"MAX_TOKENS\"}]}

",
            ),
        ];
        for (kind, input) in cases {
            let (text, items) = run(kind, input, 5);
            assert_eq!(text, "a", "{kind:?}");
            assert!(items.contains(&Item::Truncated), "{kind:?}: {items:?}");
            assert_eq!(items.last(), Some(&Item::Done), "{kind:?}");
        }
        // A normal finish is not reported as truncated.
        assert!(!run(Kind::Ollama, OLLAMA, 9).1.contains(&Item::Truncated));
        assert!(
            !run(Kind::Anthropic, ANTHROPIC, 9)
                .1
                .contains(&Item::Truncated)
        );
    }

    #[test]
    fn truncated_stream_is_an_error_except_gemini() {
        let cut = "data: {\"choices\":[{\"delta\":{\"content\":\"par\"}}]}\n\n";
        let (_, items) = run(Kind::OpenaiCompatible, cut, 4);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], Item::Text("par".into()));
        assert!(matches!(&items[1], Item::Error(m) if m.contains("closed the connection")));
        let (_, items) = run(
            Kind::Ollama,
            "{\"message\":{\"content\":\"x\"},\"done\":false}\n",
            100,
        );
        assert!(matches!(items.last(), Some(Item::Error(_))));
    }

    #[test]
    fn nothing_is_emitted_after_done() {
        let mut p = StreamParser::new(Kind::OpenaiCompatible);
        let first =
            p.feed(b"data: [DONE]\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n");
        assert_eq!(first, vec![Item::Done]);
        assert!(p.feed(b"data: more\n").is_empty());
        assert!(p.finish().is_empty());
    }

    #[test]
    fn garbage_lines_are_skipped() {
        let input = "data: not json\n\nevent: x\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n";
        check(Kind::OpenaiCompatible, input, "ok");
    }

    #[test]
    fn model_lists() {
        let ollama = r#"{"models":[{"name":"qwen2.5:7b","size":1},{"name":"llama3.2:latest"},{"name":"llama3.2:latest"}]}"#;
        assert_eq!(
            parse_models(Kind::Ollama, ollama).unwrap(),
            ["llama3.2:latest", "qwen2.5:7b"]
        );
        let openai =
            r#"{"object":"list","data":[{"id":"gpt-4o","object":"model"},{"id":"gpt-4o-mini"}]}"#;
        assert_eq!(
            parse_models(Kind::OpenaiCompatible, openai).unwrap(),
            ["gpt-4o", "gpt-4o-mini"]
        );
        let anthropic = r#"{"data":[{"id":"claude-sonnet-5-5","display_name":"S","type":"model"}],"has_more":false}"#;
        assert_eq!(
            parse_models(Kind::Anthropic, anthropic).unwrap(),
            ["claude-sonnet-5-5"]
        );
        let gemini = r#"{"models":[
            {"name":"models/gemini-2.0-flash","supportedGenerationMethods":["generateContent","countTokens"]},
            {"name":"models/text-embedding-004","supportedGenerationMethods":["embedContent"]}]}"#;
        assert_eq!(
            parse_models(Kind::Gemini, gemini).unwrap(),
            ["gemini-2.0-flash"]
        );
        assert_eq!(
            parse_models(Kind::Ollama, r#"{"models":[]}"#).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn model_list_errors_are_readable() {
        assert!(
            parse_models(Kind::Ollama, "<html>")
                .unwrap_err()
                .contains("not JSON")
        );
        assert!(
            parse_models(Kind::OpenaiCompatible, r#"{"ok":true}"#)
                .unwrap_err()
                .contains("not a model list")
        );
        assert_eq!(
            parse_models(
                Kind::Anthropic,
                r#"{"error":{"message":"invalid x-api-key"}}"#
            )
            .unwrap_err(),
            "invalid x-api-key"
        );
    }
}
