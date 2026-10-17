//! The model calls behind opt-in AI (ADR-0059): Anthropic's Messages API, or
//! the OpenAI-style chat API that Ollama, LM Studio, llama.cpp, and most
//! hosted services speak. One request per summary or set of replies, no
//! streaming, nothing kept.

use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::ai::{AiPrefs, AiProvider};
use crate::{Error, Result};

use super::tls_config;

/// Anthropic's API. Tests point the client somewhere else.
pub const ANTHROPIC_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// A local model on a laptop can take a while over a long thread.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Who answers, and how to reach them.
#[derive(Debug, Clone)]
pub struct Model {
    pub provider: AiProvider,
    pub url: String,
    pub model: String,
    pub key: Option<String>,
}

impl Model {
    /// The model the settings pick, with its key. `anthropic_url` is
    /// [`ANTHROPIC_URL`] outside tests.
    pub fn from_prefs(prefs: &AiPrefs, key: Option<String>, anthropic_url: &str) -> Result<Self> {
        let (url, model) = match prefs.provider {
            AiProvider::Off => return Err(Error::Invalid("AI is off. Turn it on in Settings → AI summaries and replies.".into())),
            AiProvider::Local => (prefs.local.url.clone(), prefs.local.model.clone()),
            AiProvider::Compatible => (prefs.compatible.url.clone(), prefs.compatible.model.clone()),
            AiProvider::Anthropic => (anthropic_url.trim_end_matches('/').to_string(), prefs.anthropic_model.clone()),
        };
        if model.is_empty() {
            return Err(Error::Invalid("Pick a model in Settings → AI summaries and replies.".into()));
        }
        let key = key.filter(|k| !k.trim().is_empty());
        if key.is_none() && prefs.provider != AiProvider::Local {
            return Err(Error::Auth("add your API key in Settings → AI summaries and replies".into()));
        }
        Ok(Self { provider: prefs.provider, url, model, key })
    }
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder().tls_backend_preconfigured(tls_config()).timeout(TIMEOUT).build().map_err(|e| Error::Network(e.to_string()))
}

fn where_(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Anthropic => "Anthropic",
        AiProvider::Local => "the model server",
        _ => "the AI service",
    }
}

fn send_err(provider: AiProvider, e: reqwest::Error) -> Error {
    let who = where_(provider);
    if e.is_timeout() {
        Error::Network(format!("{who} took too long to answer"))
    } else if e.is_connect() && provider == AiProvider::Local {
        Error::Network("nothing answered at the model server's address. Is Ollama or LM Studio running?".into())
    } else {
        Error::Network(format!("couldn't reach {who}: {e}"))
    }
}

/// An error answer, in words: the service's own message when it sends one.
async fn status_err(provider: AiProvider, res: reqwest::Response) -> Error {
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let said = body.pointer("/error/message").or_else(|| body.get("error")).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let who = where_(provider);
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Error::Auth(format!("{who} didn't accept the API key")),
        StatusCode::NOT_FOUND if !said.is_empty() => Error::Invalid(format!("{who} says: {said}")),
        StatusCode::NOT_FOUND => Error::Invalid(format!("{who} doesn't have that model, or the address is wrong")),
        StatusCode::TOO_MANY_REQUESTS => Error::Network(format!("{who} is busy or the key is over its limit. Try again in a minute.")),
        _ if !said.is_empty() => Error::Network(format!("{who} says: {said}")),
        _ => Error::Network(format!("{who} answered {status}")),
    }
}

/// Current Claude models take an effort setting; summaries and replies are
/// light work, so they ask for little thinking.
fn takes_effort(model: &str) -> bool {
    ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "claude-fable-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"].iter().any(|p| model.starts_with(p))
}

/// Models with a server-side fallback when their safety check declines.
fn has_fallback(model: &str) -> bool {
    ["claude-opus-5", "claude-sonnet-5-5", "claude-fable-5"].iter().any(|p| model.starts_with(p))
}

/// Asks the model once and returns its text.
pub async fn complete(model: &Model, system: &str, user: &str) -> Result<String> {
    let http = http()?;
    match model.provider {
        AiProvider::Anthropic => {
            let mut body = json!({
                "model": model.model,
                "max_tokens": 8000,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            });
            if takes_effort(&model.model) {
                body["output_config"] = json!({ "effort": "low" });
            }
            let mut req = http.post(format!("{}/v1/messages", model.url)).header("x-api-key", model.key.as_deref().unwrap_or("")).header("anthropic-version", ANTHROPIC_VERSION);
            if has_fallback(&model.model) {
                body["fallbacks"] = json!("default");
                req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            let res = req.json(&body).send().await.map_err(|e| send_err(model.provider, e))?;
            if !res.status().is_success() {
                return Err(status_err(model.provider, res).await);
            }
            let v: Value = res.json().await.map_err(|e| Error::Network(format!("Anthropic sent an answer Mailbird can't read: {e}")))?;
            if v["stop_reason"] == "refusal" {
                return Err(Error::Invalid("The model declined to answer for this conversation.".into()));
            }
            let text: String = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("");
            Ok(text)
        }
        AiProvider::Local | AiProvider::Compatible => {
            let body = json!({
                "model": model.model,
                "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
                "max_tokens": 2048,
                "temperature": 0.3,
                "stream": false,
            });
            let mut req = http.post(format!("{}/chat/completions", model.url)).json(&body);
            if let Some(k) = &model.key {
                req = req.bearer_auth(k);
            }
            let res = req.send().await.map_err(|e| send_err(model.provider, e))?;
            if !res.status().is_success() {
                return Err(status_err(model.provider, res).await);
            }
            let v: Value = res.json().await.map_err(|e| Error::Network(format!("{} sent an answer Mailbird can't read: {e}", where_(model.provider))))?;
            v.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_string).ok_or_else(|| Error::Network(format!("{} sent an answer without text", where_(model.provider))))
        }
        AiProvider::Off => Err(Error::Invalid("AI is off".into())),
    }
}

/// The models a server offers, newest first where it says. Doubles as the
/// connection check in Settings: it needs the address and key to be right.
pub async fn models(provider: AiProvider, url: &str, key: Option<&str>) -> Result<Vec<String>> {
    let http = http()?;
    let url = url.trim_end_matches('/');
    let req = match provider {
        AiProvider::Anthropic => http.get(format!("{url}/v1/models?limit=100")).header("x-api-key", key.unwrap_or("")).header("anthropic-version", ANTHROPIC_VERSION),
        AiProvider::Local | AiProvider::Compatible => {
            let r = http.get(format!("{url}/models"));
            match key.filter(|k| !k.is_empty()) {
                Some(k) => r.bearer_auth(k),
                None => r,
            }
        }
        AiProvider::Off => return Ok(vec![]),
    };
    let res = req.send().await.map_err(|e| send_err(provider, e))?;
    if !res.status().is_success() {
        return Err(status_err(provider, res).await);
    }
    let v: Value = res.json().await.map_err(|e| Error::Network(format!("{} sent a list Mailbird can't read: {e}", where_(provider))))?;
    let mut ids: Vec<String> = v["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).map(str::to_string).collect();
    // OpenAI's list mixes in models that can't chat.
    if provider == AiProvider::Compatible {
        ids.retain(|m| !["embedding", "whisper", "tts", "dall-e", "moderation", "transcribe", "image"].iter().any(|x| m.contains(x)));
    }
    ids.dedup();
    Ok(ids)
}
