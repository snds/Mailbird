//! Sending the wake-up. Every push is content-free: it names the device's
//! opaque account key and nothing else, so neither Apple, Google, nor an
//! ntfy server learns who wrote or what arrived. The phone syncs on its own
//! and decides what to show.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};

use crate::crypto;
use crate::store::Target;

/// What happened to a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    /// The push service says this device token is no longer valid: forget the device.
    Gone,
}

/// Apple Push Notification service, with token (`.p8`) authentication.
pub struct Apns {
    pub key_pkcs8: Vec<u8>,
    pub key_id: String,
    pub team_id: String,
    /// The app's bundle id.
    pub topic: String,
    pub url: String,
    pub sandbox_url: String,
}

/// Firebase Cloud Messaging HTTP v1, with a service account.
pub struct Fcm {
    pub project_id: String,
    pub client_email: String,
    pub key_pkcs8: Vec<u8>,
    pub token_uri: String,
    pub url: String,
}

impl Apns {
    /// From `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`. `None` when unset.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(file) = std::env::var("APNS_KEY_FILE") else { return Ok(None) };
        let need = |k: &str| std::env::var(k).map_err(|_| format!("APNS_KEY_FILE is set, so {k} is needed too"));
        let pem = std::fs::read_to_string(&file).map_err(|e| format!("can't read {file}: {e}"))?;
        Ok(Some(Self {
            key_pkcs8: crypto::pem_der(&pem)?,
            key_id: need("APNS_KEY_ID")?,
            team_id: need("APNS_TEAM_ID")?,
            topic: need("APNS_TOPIC")?,
            url: std::env::var("APNS_URL").unwrap_or_else(|_| "https://api.push.apple.com".into()),
            sandbox_url: std::env::var("APNS_SANDBOX_URL").unwrap_or_else(|_| "https://api.sandbox.push.apple.com".into()),
        }))
    }
}

impl Fcm {
    /// From `FCM_SERVICE_ACCOUNT_FILE` (the JSON key Firebase downloads). `None` when unset.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(file) = std::env::var("FCM_SERVICE_ACCOUNT_FILE") else { return Ok(None) };
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).map_err(|e| format!("can't read {file}: {e}"))?).map_err(|_| format!("{file} isn't a service-account JSON key"))?;
        let s = |k: &str| v[k].as_str().map(str::to_owned).ok_or_else(|| format!("{file} has no “{k}”"));
        Ok(Some(Self {
            project_id: s("project_id")?,
            client_email: s("client_email")?,
            key_pkcs8: crypto::pem_der(&s("private_key")?)?,
            token_uri: s("token_uri").unwrap_or_else(|_| "https://oauth2.googleapis.com/token".into()),
            url: std::env::var("FCM_URL").unwrap_or_else(|_| "https://fcm.googleapis.com".into()),
        }))
    }
}

pub struct Notifier {
    http: reqwest::Client,
    pub apns: Option<Apns>,
    pub fcm: Option<Fcm>,
    /// (token, issued at): APNs wants a fresh JWT at most hourly, and no more than every 20 minutes.
    apns_jwt: Mutex<Option<(String, i64)>>,
    /// (access token, expires at).
    fcm_token: Mutex<Option<(String, i64)>>,
}

fn is_local(url: &str) -> bool {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]"))).unwrap_or(false)
}

impl Notifier {
    pub fn new(apns: Option<Apns>, fcm: Option<Fcm>) -> Self {
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(pim_core::net::tls_config())
            .timeout(Duration::from_secs(20))
            .build()
            .expect("an HTTP client builds");
        Self { http, apns, fcm, apns_jwt: Mutex::new(None), fcm_token: Mutex::new(None) }
    }

    /// The payload every push carries.
    pub fn payload(account: &str, kind: &str) -> Value {
        json!({ "account": account, "kind": kind })
    }

    pub async fn send(&self, target: &Target, account: &str, kind: &str) -> Result<Delivery, String> {
        match target {
            Target::UnifiedPush { endpoint } => self.unified_push(endpoint, account, kind).await,
            Target::Apns { token, sandbox } => self.apns(token, *sandbox, account, kind).await,
            Target::Fcm { token } => self.fcm(token, account, kind).await,
        }
    }

    /// Checks an endpoint a device registers: https, or http only to this machine.
    pub fn check_endpoint(endpoint: &str) -> Result<(), String> {
        match reqwest::Url::parse(endpoint) {
            Ok(u) if u.scheme() == "https" || (u.scheme() == "http" && is_local(endpoint)) => Ok(()),
            _ => Err("a UnifiedPush endpoint must be an https:// URL".into()),
        }
    }

    async fn unified_push(&self, endpoint: &str, account: &str, kind: &str) -> Result<Delivery, String> {
        Self::check_endpoint(endpoint)?;
        let res = self.http.post(endpoint).header("Content-Type", "application/json").body(Self::payload(account, kind).to_string()).send().await.map_err(|e| format!("couldn't reach the UnifiedPush server: {e}"))?;
        match res.status().as_u16() {
            200..=299 => Ok(Delivery::Sent),
            404 | 410 => Ok(Delivery::Gone),
            s => Err(format!("the UnifiedPush server answered {s}")),
        }
    }

    fn apns_jwt(&self, a: &Apns) -> Result<String, String> {
        let now = pim_core::now();
        let mut cached = self.apns_jwt.lock().expect("jwt lock");
        if let Some((t, _)) = cached.as_ref().filter(|(_, at)| now - at < 45 * 60) {
            return Ok(t.clone());
        }
        let t = crypto::jwt_es256(&a.key_pkcs8, &json!({ "alg": "ES256", "kid": a.key_id }), &json!({ "iss": a.team_id, "iat": now }))?;
        *cached = Some((t.clone(), now));
        Ok(t)
    }

    async fn apns(&self, token: &str, sandbox: bool, account: &str, kind: &str) -> Result<Delivery, String> {
        let a = self.apns.as_ref().ok_or("this relay has no APNs key set up (APNS_KEY_FILE)")?;
        let base = if sandbox { &a.sandbox_url } else { &a.url };
        // A background push: iOS wakes the app to sync, and nothing shows by itself.
        let mut body = Self::payload(account, kind);
        body["aps"] = json!({ "content-available": 1 });
        let res = self
            .http
            .post(format!("{base}/3/device/{token}"))
            .header("authorization", format!("bearer {}", self.apns_jwt(a)?))
            .header("apns-topic", &a.topic)
            .header("apns-push-type", "background")
            .header("apns-priority", "5")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("couldn't reach APNs: {e}"))?;
        let status = res.status().as_u16();
        let reason = res.json::<Value>().await.ok().and_then(|v| v["reason"].as_str().map(str::to_owned)).unwrap_or_default();
        match status {
            200 => Ok(Delivery::Sent),
            410 => Ok(Delivery::Gone),
            400 if reason == "BadDeviceToken" || reason == "DeviceTokenNotForTopic" => Ok(Delivery::Gone),
            403 if reason == "ExpiredProviderToken" || reason == "InvalidProviderToken" => {
                *self.apns_jwt.lock().expect("jwt lock") = None;
                Err(format!("APNs refused the relay's key ({reason})"))
            }
            s => Err(format!("APNs answered {s} {reason}")),
        }
    }

    async fn fcm_token(&self, f: &Fcm) -> Result<String, String> {
        let now = pim_core::now();
        if let Some((t, _)) = self.fcm_token.lock().expect("token lock").as_ref().filter(|(_, exp)| *exp - 120 > now) {
            return Ok(t.clone());
        }
        let assertion = crypto::jwt_rs256(
            &f.key_pkcs8,
            &json!({ "alg": "RS256", "typ": "JWT" }),
            &json!({ "iss": f.client_email, "scope": "https://www.googleapis.com/auth/firebase.messaging", "aud": f.token_uri, "iat": now, "exp": now + 3600 }),
        )?;
        let res = self
            .http
            .post(&f.token_uri)
            .header("Content-Type", "application/x-www-form-urlencoded")
            // The assertion is base64url with dots: nothing to escape.
            .body(format!("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}"))
            .send()
            .await
            .map_err(|e| format!("couldn't reach Google's token service: {e}"))?;
        let v: Value = res.json().await.map_err(|_| "Google's token service sent an unreadable reply".to_string())?;
        let token = v["access_token"].as_str().ok_or_else(|| format!("Google refused the service account ({})", v["error"].as_str().unwrap_or("error")))?.to_owned();
        *self.fcm_token.lock().expect("token lock") = Some((token.clone(), now + v["expires_in"].as_i64().unwrap_or(3600)));
        Ok(token)
    }

    async fn fcm(&self, token: &str, account: &str, kind: &str) -> Result<Delivery, String> {
        let f = self.fcm.as_ref().ok_or("this relay has no FCM service account set up (FCM_SERVICE_ACCOUNT_FILE)")?;
        let access = self.fcm_token(f).await?;
        // A data message: Android wakes the app, and nothing shows by itself.
        let body = json!({ "message": { "token": token, "data": { "account": account, "kind": kind }, "android": { "priority": "high" } } });
        let res = self
            .http
            .post(format!("{}/v1/projects/{}/messages:send", f.url, f.project_id))
            .bearer_auth(access)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("couldn't reach FCM: {e}"))?;
        let status = res.status().as_u16();
        let v: Value = res.json().await.unwrap_or_default();
        let code = v["error"]["details"].as_array().into_iter().flatten().find_map(|d| d["errorCode"].as_str()).unwrap_or_default().to_owned();
        match status {
            200 => Ok(Delivery::Sent),
            404 => Ok(Delivery::Gone),
            400 | 403 if code == "UNREGISTERED" || code == "SENDER_ID_MISMATCH" => Ok(Delivery::Gone),
            s => Err(format!("FCM answered {s} {code}")),
        }
    }
}
