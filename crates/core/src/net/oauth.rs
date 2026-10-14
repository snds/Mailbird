//! OAuth 2.0 for installed apps (RFC 8252): the authorization-code flow with
//! PKCE (RFC 7636) and a loopback redirect.
//!
//! 1. [`Flow::start`] binds a random port on 127.0.0.1 and builds the
//!    provider's sign-in URL. The shell opens that in the system browser
//!    (never an embedded webview, which providers block and which would see
//!    the password).
//! 2. [`Flow::finish`] waits for the browser to come back to the port with a
//!    `code`, checks `state`, and trades the code for tokens.
//! 3. [`refresh`] trades the refresh token for a new access token when the
//!    old one is about to expire.
//!
//! Tokens go to the keychain as a [`TokenSet`]; nothing here touches the store.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::{Error, OAuthIssuer, Result, now};

use super::{TIMEOUT, tls_config};

/// How long the sign-in page may stay open before we give up waiting.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before the access token actually expires.
const EARLY: i64 = 120;

/// Scopes per provider. Google: Gmail read/label/send (restricted), Calendar
/// and Contacts over CalDAV/CardDAV, and the basic identity claims.
pub fn scopes(issuer: OAuthIssuer) -> &'static [&'static str] {
    match issuer {
        OAuthIssuer::Google => &[
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/carddav",
        ],
        OAuthIssuer::Microsoft => &[
            "openid",
            "email",
            "profile",
            "offline_access",
            "https://graph.microsoft.com/Mail.ReadWrite",
            "https://graph.microsoft.com/Mail.Send",
            "https://graph.microsoft.com/Calendars.ReadWrite",
            "https://graph.microsoft.com/Contacts.ReadWrite",
        ],
    }
}

/// An OAuth client: the app's registration with a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub client_id: String,
    /// Google issues one to "Desktop app" clients and requires it at the token
    /// endpoint. It is not confidential in an installed app (Google's own
    /// words); PKCE is what protects the code.
    #[serde(default)]
    pub client_secret: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
}

pub fn endpoints(issuer: OAuthIssuer) -> Endpoints {
    match issuer {
        OAuthIssuer::Google => Endpoints {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
        },
        // "common" lets both work/school and personal Microsoft accounts sign in.
        OAuthIssuer::Microsoft => Endpoints {
            authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
            token: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
        },
    }
}

/// What the keychain holds for an OAuth account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

impl TokenSet {
    pub fn fresh(&self) -> bool {
        self.expires_at - EARLY > now()
    }
}

/// Who signed in, from the ID token's claims.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub email: Option<String>,
    pub name: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    id_token: Option<String>,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A PKCE verifier (43 characters from 32 random bytes) and its S256 challenge.
pub fn pkce() -> (String, String) {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).expect("the OS random source works");
    let verifier = b64url(&bytes);
    (verifier.clone(), challenge(&verifier))
}

pub fn challenge(verifier: &str) -> String {
    b64url(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref())
}

fn random_state() -> String {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut bytes).expect("the OS random source works");
    b64url(&bytes)
}

fn query_escape(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The provider's sign-in page for this flow.
pub fn authorize_url(issuer: OAuthIssuer, ep: &Endpoints, client: &Client, redirect: &str, challenge: &str, state: &str, login_hint: Option<&str>) -> String {
    let mut q = vec![
        ("response_type", "code".to_string()),
        ("client_id", client.client_id.clone()),
        ("redirect_uri", redirect.to_string()),
        ("scope", scopes(issuer).join(" ")),
        ("code_challenge", challenge.to_string()),
        ("code_challenge_method", "S256".to_string()),
        ("state", state.to_string()),
    ];
    if issuer == OAuthIssuer::Google {
        // A refresh token, every time (Google only returns one on consent).
        q.push(("access_type", "offline".into()));
        q.push(("prompt", "consent".into()));
    }
    if let Some(h) = login_hint.filter(|h| !h.is_empty()) {
        q.push(("login_hint", h.to_string()));
    }
    let query: Vec<String> = q.into_iter().map(|(k, v)| format!("{k}={}", query_escape(&v))).collect();
    format!("{}?{}", ep.authorize, query.join("&"))
}

/// The ID token's `email` and `name`. Its signature isn't checked: it came
/// straight from the token endpoint over TLS (OpenID Connect Core §3.1.3.7).
pub fn identity(id_token: &str) -> Identity {
    let claims = id_token
        .split('.')
        .nth(1)
        .and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    let Some(c) = claims else { return Identity::default() };
    let s = |k: &str| c[k].as_str().filter(|v| !v.is_empty()).map(str::to_owned);
    Identity { email: s("email").or_else(|| s("preferred_username")), name: s("name") }
}

/// Reads `code` and `state` from the browser's request line
/// (`GET /?code=…&state=… HTTP/1.1`). An `error` (the person said no)
/// becomes an [`Error::Auth`].
pub fn parse_callback(request_line: &str) -> Result<(String, String)> {
    let target = request_line.split_whitespace().nth(1).unwrap_or_default();
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or_default();
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = percent_decode(v);
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(Error::Auth(if e == "access_denied" { "sign-in was cancelled".into() } else { format!("the provider refused the sign-in ({e})") }));
    }
    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err(Error::Auth("the sign-in page came back without a code".into())),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center\"><h1 style=\"font-size:1.25rem\">You're signed in</h1><p>You can close this tab and go back to the app.</p>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sign-in didn't finish</title><body style=\"font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center\"><h1 style=\"font-size:1.25rem\">Sign-in didn't finish</h1><p>Go back to the app to try again.</p>";

/// One sign-in in progress.
pub struct Flow {
    listener: TcpListener,
    pub issuer: OAuthIssuer,
    pub endpoints: Endpoints,
    pub client: Client,
    pub redirect: String,
    /// Open this in the system browser.
    pub url: String,
    verifier: String,
    state: String,
}

impl Flow {
    pub async fn start(issuer: OAuthIssuer, endpoints: Endpoints, client: Client, login_hint: Option<&str>) -> Result<Self> {
        if client.client_id.trim().is_empty() {
            return Err(Error::Invalid("set up an OAuth client for this provider first".into()));
        }
        // RFC 8252 §7.3: the loopback IP literal, any free port.
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| Error::Network(format!("couldn't open the sign-in port: {e}")))?;
        let port = listener.local_addr().map_err(|e| Error::Network(e.to_string()))?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let (verifier, challenge) = pkce();
        let state = random_state();
        let url = authorize_url(issuer, &endpoints, &client, &redirect, &challenge, &state, login_hint);
        Ok(Self { listener, issuer, endpoints, client, redirect, url, verifier, state })
    }

    /// Waits for the browser to return, then trades the code for tokens.
    pub async fn finish(self, timeout: Duration) -> Result<(TokenSet, Identity)> {
        let code = tokio::time::timeout(timeout, self.accept())
            .await
            .map_err(|_| Error::Auth("sign-in timed out — try again".into()))??;
        exchange(&self.endpoints, &self.client, &code, &self.verifier, &self.redirect).await
    }

    async fn accept(&self) -> Result<String> {
        loop {
            let (mut sock, _) = self.listener.accept().await.map_err(|e| Error::Network(e.to_string()))?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            let line = head.lines().next().unwrap_or_default().to_string();
            // Browsers also ask for /favicon.ico; only the redirect has a query.
            if !line.contains('?') {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let result = parse_callback(&line).and_then(|(code, state)| {
                if state == self.state { Ok(code) } else { Err(Error::Auth("the sign-in reply didn't match this request".into())) }
            });
            let page = if result.is_ok() { DONE_PAGE } else { FAILED_PAGE };
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{page}", page.len());
            let _ = sock.write_all(reply.as_bytes()).await;
            let _ = sock.shutdown().await;
            return result;
        }
    }
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| Error::Network(e.to_string()))
}

async fn token_request(token_url: &str, client: &Client, mut form: Vec<(&str, String)>) -> Result<TokenResponse> {
    form.push(("client_id", client.client_id.clone()));
    if let Some(secret) = &client.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    let body: String = form.iter().map(|(k, v)| format!("{k}={}", query_escape(v))).collect::<Vec<_>>().join("&");
    let res = http()?
        .post(token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| Error::Network(e.to_string()))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| Error::Network(e.to_string()))?;
    if !status.is_success() {
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let code = v["error"].as_str().unwrap_or("error");
        // invalid_grant: the refresh token was revoked, expired, or the password changed.
        return Err(Error::Auth(if code == "invalid_grant" {
            "the provider signed this account out — sign in again".into()
        } else {
            format!("the provider refused the token request ({code})")
        }));
    }
    serde_json::from_str(&text).map_err(|_| Error::Network("the provider sent an unreadable token reply".into()))
}

/// Trades an authorization code for tokens.
pub async fn exchange(ep: &Endpoints, client: &Client, code: &str, verifier: &str, redirect: &str) -> Result<(TokenSet, Identity)> {
    let r = token_request(&ep.token, client, vec![
        ("grant_type", "authorization_code".into()),
        ("code", code.into()),
        ("code_verifier", verifier.into()),
        ("redirect_uri", redirect.into()),
    ])
    .await?;
    let refresh_token = r.refresh_token.ok_or_else(|| Error::Auth("the provider didn't allow offline access — sign in again".into()))?;
    let identity = r.id_token.as_deref().map(identity).unwrap_or_default();
    Ok((TokenSet { access_token: r.access_token, refresh_token, expires_at: now() + r.expires_in.unwrap_or(3600) }, identity))
}

/// A new access token. Providers may rotate the refresh token (Microsoft
/// does); the old one is kept when they don't.
pub async fn refresh(token_url: &str, client: &Client, tokens: &TokenSet) -> Result<TokenSet> {
    let r = token_request(token_url, client, vec![("grant_type", "refresh_token".into()), ("refresh_token", tokens.refresh_token.clone())]).await?;
    Ok(TokenSet {
        access_token: r.access_token,
        refresh_token: r.refresh_token.unwrap_or_else(|| tokens.refresh_token.clone()),
        expires_at: now() + r.expires_in.unwrap_or(3600),
    })
}

/// Tells the provider to forget this sign-in (Google's revocation endpoint,
/// RFC 7009). Microsoft has no endpoint for this; its tokens just expire.
pub async fn revoke(issuer: OAuthIssuer, tokens: &TokenSet) -> Result<()> {
    if issuer != OAuthIssuer::Google {
        return Ok(());
    }
    http()?
        .post("https://oauth2.googleapis.com/revoke")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("token={}", query_escape(&tokens.refresh_token)))
        .send()
        .await
        .map_err(|e| Error::Network(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let (v, c) = pkce();
        assert_eq!(v.len(), 43);
        assert_eq!(c, challenge(&v));
    }

    #[test]
    fn google_sign_in_url() {
        let client = Client { client_id: "abc.apps.googleusercontent.com".into(), client_secret: None };
        let url = authorize_url(OAuthIssuer::Google, &endpoints(OAuthIssuer::Google), &client, "http://127.0.0.1:5555", "CH", "ST", Some("me@gmail.com"));
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc.apps.googleusercontent.com"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5555"));
        assert!(url.contains("scope=openid%20email%20profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify"));
        assert!(url.contains("code_challenge=CH&code_challenge_method=S256&state=ST"));
        assert!(url.contains("access_type=offline&prompt=consent&login_hint=me%40gmail.com"));
    }

    #[test]
    fn callbacks() {
        assert_eq!(parse_callback("GET /?state=a%2Bb&code=4%2F0Ab_c HTTP/1.1").unwrap(), ("4/0Ab_c".to_string(), "a+b".to_string()));
        assert!(matches!(parse_callback("GET /?error=access_denied&state=x HTTP/1.1"), Err(Error::Auth(m)) if m.contains("cancelled")));
        assert!(parse_callback("GET /?state=x HTTP/1.1").is_err());
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn identity_from_id_token() {
        let payload = b64url(br#"{"email":"ada@gmail.com","name":"Ada Lovelace","sub":"1"}"#);
        let id = identity(&format!("e30.{payload}.sig"));
        assert_eq!(id, Identity { email: Some("ada@gmail.com".into()), name: Some("Ada Lovelace".into()) });
        assert_eq!(identity("garbage"), Identity::default());
        let ms = b64url(br#"{"preferred_username":"sam@contoso.com"}"#);
        assert_eq!(identity(&format!("x.{ms}.y")).email.as_deref(), Some("sam@contoso.com"));
    }

    #[tokio::test]
    async fn loopback_flow_checks_state() {
        let client = Client { client_id: "id".into(), client_secret: None };
        let ep = Endpoints { authorize: "https://example.test/auth".into(), token: "http://127.0.0.1:1/token".into() };
        let flow = Flow::start(OAuthIssuer::Google, ep, client, None).await.unwrap();
        let redirect = flow.redirect.clone();
        let task = tokio::spawn(async move { flow.accept().await });
        // A favicon request first, then a reply for some other sign-in.
        let http = http().unwrap();
        assert_eq!(http.get(format!("{redirect}/favicon.ico")).send().await.unwrap().status(), 404);
        let page = http.get(format!("{redirect}/?code=c&state=wrong")).send().await.unwrap().text().await.unwrap();
        assert!(page.contains("didn't finish"));
        assert!(matches!(task.await.unwrap(), Err(Error::Auth(_))));
    }
}
