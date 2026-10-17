//! Opt-in AI's model calls (ADR-0059) against a fake model server on
//! 127.0.0.1 that speaks both Anthropic's Messages API and the OpenAI-style
//! chat API. Runs offline, in the normal test suite.

#![cfg(feature = "net")]

use std::sync::{Arc, Mutex};

use pim_core::ai::{self, AiPrefs, AiProvider, Endpoint};
use pim_core::net::ai::{Model, complete, models};
use pim_core::Error;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One request: method, path, headers (names lowercased), and JSON body.
type Seen = (String, String, Vec<(String, String)>, Value);

#[derive(Default)]
struct Fake {
    seen: Vec<Seen>,
    /// The next answer's text; `refuse` makes the Anthropic side decline.
    answer: String,
    refuse: bool,
}

async fn serve(fake: Arc<Mutex<Fake>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let fake = fake.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    let head_end = loop {
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i;
                        }
                        let mut chunk = [0u8; 8192];
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let (method, path) = (first.next().unwrap().to_owned(), first.next().unwrap().to_owned());
                    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
                    let len: usize = headers.iter().find(|(k, _)| k == "content-length").map(|(_, v)| v.parse().unwrap()).unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let mut chunk = [0u8; 8192];
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let body: Value = serde_json::from_slice(&buf[head_end + 4..head_end + 4 + len]).unwrap_or(Value::Null);
                    buf.drain(..head_end + 4 + len);
                    let (status, reply) = answer(&fake, &method, &path, &headers, body);
                    let text = reply.to_string();
                    let res = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
                    if sock.write_all(res.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    base
}

fn answer(fake: &Mutex<Fake>, method: &str, path: &str, headers: &[(String, String)], body: Value) -> (&'static str, Value) {
    let mut f = fake.lock().unwrap();
    f.seen.push((method.into(), path.into(), headers.to_vec(), body.clone()));
    let header = |k: &str| headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.as_str());
    match (method, path) {
        ("POST", "/v1/messages") => {
            if header("x-api-key") != Some("sk-ant-test") {
                return ("401 Unauthorized", json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }));
            }
            if f.refuse {
                return ("200 OK", json!({ "content": [], "stop_reason": "refusal", "stop_details": { "type": "refusal", "category": null } }));
            }
            ("200 OK", json!({ "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": f.answer }], "stop_reason": "end_turn" }))
        }
        ("GET", p) if p.starts_with("/v1/models") && header("x-api-key").is_some() => ("200 OK", json!({ "data": [{ "id": "claude-opus-5-5" }, { "id": "claude-haiku-5-5" }] })),
        ("POST", "/v1/chat/completions") => {
            if body["model"] == "missing" {
                return ("404 Not Found", json!({ "error": { "message": "model \"missing\" not found, try pulling it first" } }));
            }
            ("200 OK", json!({ "choices": [{ "message": { "role": "assistant", "content": f.answer } }] }))
        }
        ("GET", "/v1/models") => ("200 OK", json!({ "object": "list", "data": [{ "id": "llama3.2" }, { "id": "qwen3:8b" }, { "id": "text-embedding-3-small" }] })),
        _ => ("404 Not Found", json!({})),
    }
}

fn local(base: &str, model: &str) -> AiPrefs {
    AiPrefs { provider: AiProvider::Local, local: Endpoint { url: format!("{base}/v1"), model: model.into() }, ..Default::default() }
}

#[tokio::test]
async fn a_local_model_answers_without_a_key() {
    let fake = Arc::new(Mutex::new(Fake { answer: "<think>Short thread.</think>\n- Ana wants the lake house on the 12th.\n- You'll call them.".into(), ..Default::default() }));
    let base = serve(fake.clone()).await;
    let m = Model::from_prefs(&local(&base, "llama3.2"), None, &base).unwrap();
    let text = complete(&m, ai::SUMMARY_SYSTEM, "Subject: Offsite").await.unwrap();
    assert_eq!(ai::read_summary(&text).unwrap(), vec!["Ana wants the lake house on the 12th.", "You'll call them."]);
    let f = fake.lock().unwrap();
    let (_, _, headers, body) = f.seen.last().unwrap();
    assert_eq!(body["model"], "llama3.2");
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["content"], "Subject: Offsite");
    assert!(!headers.iter().any(|(k, _)| k == "authorization"), "no key, no Authorization header");
}

#[tokio::test]
async fn models_list_and_wrong_model_explain_themselves() {
    let fake = Arc::new(Mutex::new(Fake::default()));
    let base = serve(fake.clone()).await;
    assert_eq!(models(AiProvider::Local, &format!("{base}/v1"), None).await.unwrap(), vec!["llama3.2", "qwen3:8b", "text-embedding-3-small"]);
    assert_eq!(models(AiProvider::Compatible, &format!("{base}/v1"), Some("sk-x")).await.unwrap(), vec!["llama3.2", "qwen3:8b"], "embedding models can't chat");
    assert!(fake.lock().unwrap().seen.last().unwrap().2.contains(&("authorization".into(), "Bearer sk-x".into())));
    let m = Model::from_prefs(&local(&base, "missing"), None, &base).unwrap();
    let e = complete(&m, "s", "u").await.unwrap_err();
    assert!(e.to_string().contains("try pulling it first"), "{e}");
    // Nothing listening.
    let gone = Model::from_prefs(&local("http://127.0.0.1:9", "llama3.2"), None, &base).unwrap();
    let e = complete(&gone, "s", "u").await.unwrap_err();
    assert!(e.to_string().contains("Is Ollama or LM Studio running?"), "{e}");
}

#[tokio::test]
async fn anthropic_gets_the_key_low_effort_and_a_fallback() {
    let fake = Arc::new(Mutex::new(Fake { answer: r#"["Yes, the 12th works.", "Could we do the 19th?", "Let me check and get back to you."]"#.into(), ..Default::default() }));
    let base = serve(fake.clone()).await;
    let prefs = AiPrefs { provider: AiProvider::Anthropic, ..Default::default() };
    assert!(matches!(Model::from_prefs(&prefs, None, &base), Err(Error::Auth(_))), "a hosted service needs a key");
    let m = Model::from_prefs(&prefs, Some("sk-ant-test".into()), &base).unwrap();
    let replies = ai::read_replies(&complete(&m, ai::REPLY_SYSTEM, "thread").await.unwrap()).unwrap();
    assert_eq!(replies.len(), 3);
    {
        let f = fake.lock().unwrap();
        let (_, path, headers, body) = f.seen.last().unwrap();
        assert_eq!(path, "/v1/messages");
        assert!(headers.contains(&("anthropic-version".into(), "2023-06-01".into())));
        assert!(headers.contains(&("anthropic-beta".into(), "server-side-fallback-2026-07-01".into())));
        assert_eq!((body["model"].as_str(), body["fallbacks"].as_str(), body["output_config"]["effort"].as_str()), (Some("claude-opus-5-5"), Some("default"), Some("low")));
        assert_eq!(body["system"], ai::REPLY_SYSTEM);
        assert!(body.get("thinking").is_none() && body.get("temperature").is_none(), "Opus 5.5 takes neither");
    }

    // A model without a server-side fallback isn't sent one.
    let haiku = Model::from_prefs(&AiPrefs { anthropic_model: "claude-haiku-5-5".into(), ..prefs.clone() }, Some("sk-ant-test".into()), &base).unwrap();
    complete(&haiku, "s", "u").await.unwrap();
    assert!(fake.lock().unwrap().seen.last().unwrap().3.get("fallbacks").is_none());

    let wrong = Model::from_prefs(&prefs, Some("sk-ant-nope".into()), &base).unwrap();
    assert!(matches!(complete(&wrong, "s", "u").await, Err(Error::Auth(m)) if m.contains("didn't accept the API key")));

    fake.lock().unwrap().refuse = true;
    let e = complete(&m, "s", "u").await.unwrap_err();
    assert!(e.to_string().contains("declined"), "{e}");

    assert_eq!(models(AiProvider::Anthropic, &base, Some("sk-ant-test")).await.unwrap(), vec!["claude-opus-5-5", "claude-haiku-5-5"]);
}

#[test]
fn off_or_without_a_model_says_where_to_go() {
    let e = Model::from_prefs(&AiPrefs::default(), None, "x").unwrap_err();
    assert!(e.to_string().contains("Settings"));
    let e = Model::from_prefs(&local("http://localhost:11434", ""), None, "x").unwrap_err();
    assert!(e.to_string().contains("Pick a model"));
}
