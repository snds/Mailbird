//! Opt-in AI (ADR-0059): its settings, the API keys (kept in the secret
//! store, never in SQLite or the web layer), and the two things it does,
//! summarize a conversation and suggest replies. A conversation is sent only
//! when one of those is asked for.

use pim_core::ai::{self, AiPrefs, AiProvider};
use pim_core::net::ai::{ANTHROPIC_URL, Model, complete, models};
use serde::Serialize;

use crate::Shared;
use crate::commands::{Res, with_store};
use crate::secrets;

/// Settings as the UI sees them: the choices, and which keys are saved
/// (never the keys themselves).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub prefs: AiPrefs,
    pub keys: AiKeys,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeys {
    pub local: bool,
    pub anthropic: bool,
    pub compatible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub points: Vec<String>,
    /// How many of the thread's messages the model read (the newest).
    pub used: usize,
    pub total: usize,
    pub provider: AiProvider,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replies {
    pub replies: Vec<String>,
    pub provider: AiProvider,
    pub model: String,
}

/// Where Anthropic's API is; tests set `MAILBIRD_AI_ANTHROPIC_URL` to a fake.
fn anthropic_url() -> String {
    std::env::var("MAILBIRD_AI_ANTHROPIC_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| ANTHROPIC_URL.into())
}

fn key(provider: AiProvider) -> Res<Option<String>> {
    match ai::ai_key_name(provider) {
        Some(name) => secrets::find(name),
        None => Ok(None),
    }
}

pub fn ai_settings(state: &Shared) -> Res<AiSettings> {
    let prefs = with_store(state, |s| s.ai_prefs())?;
    let has = |p| key(p).ok().flatten().is_some();
    Ok(AiSettings { prefs, keys: AiKeys { local: has(AiProvider::Local), anthropic: has(AiProvider::Anthropic), compatible: has(AiProvider::Compatible) } })
}

pub fn set_ai_prefs(state: &Shared, prefs: AiPrefs) -> Res<AiSettings> {
    with_store(state, |s| s.set_ai_prefs(&prefs))?;
    ai_settings(state)
}

/// Saves a provider's key, or forgets it (`None` or blank).
pub fn set_ai_key(state: &Shared, provider: AiProvider, key: Option<String>) -> Res<AiSettings> {
    let name = ai::ai_key_name(provider).ok_or("this choice has no key")?;
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => secrets::set(name, &k)?,
        None => secrets::delete(name),
    }
    ai_settings(state)
}

/// The models a provider offers, with the saved address and key. Settings
/// uses it to fill the model list and to check the connection.
pub async fn ai_models(state: &Shared, provider: AiProvider) -> Res<Vec<String>> {
    let prefs = with_store(state, |s| s.ai_prefs())?;
    let url = match provider {
        AiProvider::Local => prefs.local.url,
        AiProvider::Compatible => prefs.compatible.url,
        AiProvider::Anthropic => anthropic_url(),
        AiProvider::Off => return Ok(vec![]),
    };
    let key = key(provider)?;
    if key.is_none() && provider != AiProvider::Local {
        return Err("Add your API key first.".into());
    }
    models(provider, &url, key.as_deref()).await.map_err(|e| e.to_string())
}

/// The model in use and the thread as it will read it.
fn prepare(state: &Shared, thread_id: &str) -> Res<(Model, ai::ThreadText)> {
    let (prefs, messages, me) = with_store(state, |s| {
        let messages = s.thread(thread_id)?;
        let me = match messages.first() {
            Some(m) => s.account(&m.summary.account_id).map(|a| a.config.address).unwrap_or_default(),
            None => String::new(),
        };
        Ok((s.ai_prefs()?, messages, me))
    })?;
    if messages.is_empty() {
        return Err("This conversation is no longer here.".into());
    }
    let model = Model::from_prefs(&prefs, key(prefs.provider)?, &anthropic_url()).map_err(|e| e.to_string())?;
    Ok((model, ai::thread_text(&messages, &me)))
}

pub async fn summarize_thread(state: &Shared, thread_id: String) -> Res<Summary> {
    let (model, thread) = prepare(state, &thread_id)?;
    let answer = complete(&model, ai::SUMMARY_SYSTEM, &thread.text).await.map_err(|e| e.to_string())?;
    let points = ai::read_summary(&answer).map_err(|e| e.to_string())?;
    Ok(Summary { points, used: thread.used, total: thread.total, provider: model.provider, model: model.model })
}

pub async fn suggest_replies(state: &Shared, thread_id: String) -> Res<Replies> {
    let (model, thread) = prepare(state, &thread_id)?;
    let answer = complete(&model, ai::REPLY_SYSTEM, &thread.text).await.map_err(|e| e.to_string())?;
    let replies = ai::read_replies(&answer).map_err(|e| e.to_string())?;
    Ok(Replies { replies, provider: model.provider, model: model.model })
}
