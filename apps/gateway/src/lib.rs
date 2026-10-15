//! The web gateway (ADR-0016): the Mailbird web app with real accounts.
//!
//! Browsers can't speak IMAP or SMTP, so the web build talks to this small
//! server, which runs the same `pim-app` and `pim-core` as the desktop app:
//!
//! - `POST /api/core/{command}` runs one command through `pim_app::dispatch`,
//!   with the same JSON arguments the desktop app's IPC carries.
//! - `GET /api/events` streams change events (Server-Sent Events), as Tauri
//!   events do on the desktop.
//! - Everything else serves the built web app, with a single-page fallback.
//!
//! It's for one person and self-hosted: one password, sessions in an
//! HttpOnly cookie, and secrets sealed in a file with `GATEWAY_KEY`.
//! Hosting it for others would make it the kind of server Google's
//! restricted-scope assessment covers (ADR-0004), so it isn't built for that.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use futures::Stream;
use pim_app::secrets::SecretStore;
use pim_app::{AppHandle, Host, Output, Shared};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

/// How long a session lasts without use.
const SESSION_IDLE: Duration = Duration::from_secs(30 * 24 * 3600);
/// Failed sign-ins allowed per window before the gateway makes you wait.
const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(5 * 60);
const COOKIE: &str = "mb_session";
/// Booking attempts from the public pages, across all links, per window.
const MAX_BOOKINGS: u32 = 30;
const BOOKING_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Compares secrets without leaking where they differ through timing.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    SystemRandom::new().fill(&mut b).expect("the OS random source works");
    URL_SAFE_NO_PAD.encode(b)
}

// ── Secrets: a sealed file ──────────────────────────────────────────────────

/// Account passwords and tokens in `secrets.json`, each sealed with
/// AES-256-GCM under `GATEWAY_KEY`: a copied data folder alone doesn't give
/// them away. Written atomically, mode 0600.
pub struct SealedFile {
    path: PathBuf,
    key: LessSafeKey,
    values: Mutex<HashMap<String, String>>,
}

impl SealedFile {
    pub fn open(path: PathBuf, key_b64: &str) -> Result<Self, String> {
        let bytes = STANDARD.decode(key_b64.trim()).map_err(|_| "GATEWAY_KEY isn't base64".to_string())?;
        let key = UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| "GATEWAY_KEY must be 32 bytes (openssl rand -base64 32)".to_string())?;
        let values = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{} is damaged: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(format!("can't read {}: {e}", path.display())),
        };
        Ok(Self { path, key: LessSafeKey::new(key), values: Mutex::new(values) })
    }

    fn seal(&self, plain: &str) -> String {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new().fill(&mut nonce).expect("the OS random source works");
        let mut buf = plain.as_bytes().to_vec();
        self.key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf).expect("sealing in memory can't fail");
        let mut out = nonce.to_vec();
        out.extend(buf);
        STANDARD.encode(out)
    }

    fn unseal(&self, sealed: &str) -> Result<String, String> {
        let bad = || "a stored secret can't be opened — was GATEWAY_KEY changed?".to_string();
        let bytes = STANDARD.decode(sealed).map_err(|_| bad())?;
        if bytes.len() < NONCE_LEN {
            return Err(bad());
        }
        let (nonce, ct) = bytes.split_at(NONCE_LEN);
        let mut ct = ct.to_vec();
        let plain = self.key.open_in_place(Nonce::try_assume_unique_for_key(nonce).map_err(|_| bad())?, Aad::empty(), &mut ct).map_err(|_| bad())?;
        String::from_utf8(plain.to_vec()).map_err(|_| bad())
    }

    fn save(&self, values: &HashMap<String, String>) -> Result<(), String> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(values).expect("secrets serialize")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("couldn't save secrets: {e}"))
    }
}

impl SecretStore for SealedFile {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let v = self.values.lock().expect("secrets lock").get(key).cloned();
        v.map(|s| self.unseal(&s)).transpose()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut values = self.values.lock().expect("secrets lock");
        values.insert(key.to_owned(), self.seal(value));
        self.save(&values)
    }

    fn delete(&self, key: &str) {
        let mut values = self.values.lock().expect("secrets lock");
        if values.remove(key).is_some() {
            let _ = self.save(&values);
        }
    }
}

// ── Host: events to the browser ─────────────────────────────────────────────

/// The gateway's side of `pim_app::Host`: events go to every open page.
struct GatewayHost {
    events: broadcast::Sender<(String, Value)>,
}

impl Host for GatewayHost {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.events.send((event.to_owned(), payload));
    }

    /// Reminders already reach the page as `reminder` events; there's no
    /// desktop to notify on a server.
    fn notify(&self, _title: &str, _body: &str) -> Result<(), String> {
        Ok(())
    }

    /// Browser sign-in (OAuth): the page opens the provider's site. Its
    /// loopback redirect only comes back when the gateway runs on the same
    /// computer as the browser.
    fn open_url(&self, url: &str) -> Result<(), String> {
        let _ = self.events.send(("open-url".into(), Value::String(url.to_owned())));
        Ok(())
    }

    fn download_dir(&self) -> Result<PathBuf, String> {
        Err("downloads go through the browser here".into())
    }

    fn open_path(&self, _path: &Path) -> Result<(), String> {
        Err("files open from the browser here".into())
    }
}

// ── Sessions ────────────────────────────────────────────────────────────────

pub struct Config {
    /// The one password, 16+ characters.
    pub password: String,
    /// Where the built web app is (`apps/web/dist`).
    pub web_dir: PathBuf,
    /// Mark the cookie `Secure`. Off only for plain http on this machine.
    pub secure_cookies: bool,
    /// The address people reach this gateway at ("https://cal.example"),
    /// when set: booking invitations then carry their manage link (ADR-0031).
    /// From configuration only, never from a request, so a booker can't
    /// point someone else's invitation at another site.
    pub public_url: Option<String>,
}

pub struct Gateway {
    app: AppHandle,
    state: Shared,
    events: broadcast::Sender<(String, Value)>,
    config: Config,
    /// token → last used.
    sessions: Mutex<HashMap<String, Instant>>,
    /// (window start, failures in it).
    failures: Mutex<(Instant, u32)>,
    /// (window start, booking attempts in it) from public pages.
    bookings: Mutex<(Instant, u32)>,
}

type Gw = Arc<Gateway>;

impl Gateway {
    /// Starts the app's background workers (sync, push, outbox) too.
    pub fn new(state: Shared, config: Config) -> Gw {
        let (events, _) = broadcast::channel(256);
        let app = AppHandle::new(GatewayHost { events: events.clone() });
        pim_app::workers::start(app.clone(), state.clone());
        Arc::new(Self { app, state, events, config, sessions: Mutex::new(HashMap::new()), failures: Mutex::new((Instant::now(), 0)), bookings: Mutex::new((Instant::now(), 0)) })
    }

    fn session(&self, headers: &HeaderMap) -> bool {
        let Some(token) = cookie(headers, COOKIE) else { return false };
        let mut sessions = self.sessions.lock().expect("sessions lock");
        sessions.retain(|_, used| used.elapsed() < SESSION_IDLE);
        match sessions.iter_mut().find(|(t, _)| same(t, &token)) {
            Some((_, used)) => {
                *used = Instant::now();
                true
            }
            None => false,
        }
    }

    fn cookie_header(&self, token: &str, max_age: u64) -> HeaderValue {
        let secure = if self.config.secure_cookies { "; Secure" } else { "" };
        HeaderValue::from_str(&format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}")).expect("a valid cookie")
    }
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_owned())
    })
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

/// Writes must carry `X-Mailbird: 1`. A form or `fetch` from another site
/// can't add it without a CORS preflight, which the gateway never allows.
fn csrf_ok(headers: &HeaderMap) -> bool {
    headers.get("x-mailbird").and_then(|v| v.to_str().ok()) == Some("1")
}

// ── Routes ──────────────────────────────────────────────────────────────────

/// Headers on every response: no framing, no sniffing, no referrers, and a
/// content policy that only lets the app talk to itself (plus a notes relay
/// over wss, and remote images when you choose to load them).
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:*; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

pub fn router(gw: Gw) -> Router {
    let index = gw.config.web_dir.join("index.html");
    let page: axum::routing::MethodRouter = get(move || app_page(index.clone()));
    // Files as they are; the page itself, and every deep link, get the marked page.
    let spa = ServeDir::new(&gw.config.web_dir).append_index_html_on_directories(false).fallback(page.clone());
    Router::new()
        .route_service("/", page.clone())
        .route_service("/index.html", page)
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/session", get(get_session).post(sign_in).delete(sign_out))
        // Note images arrive as base64 (up to 10 MB each, ADR-0044); axum's 2 MB default is too small.
        .route("/api/core/{name}", post(core).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/api/events", get(events))
        .route("/api/attachments/{id}", get(attachment))
        // Public: a scheduling link's page reads its free times and books one (ADR-0026).
        .route("/api/book/{token}", get(booking_page).post(booking))
        // Public too: a booking's own page, opened by its private code (ADR-0031).
        .route("/api/book/{token}/b/{code}", get(managed_booking).post(change_booking))
        .route("/api/{*rest}", axum::routing::any(|| async { err(StatusCode::NOT_FOUND, "no such API") }))
        .fallback_service(spa)
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP)))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .with_state(gw)
}

/// The web app's page, marked so it knows a gateway serves it. Read on each
/// request, so a rebuilt web app shows up without a restart.
async fn app_page(index: PathBuf) -> Response {
    let Ok(html) = tokio::fs::read_to_string(&index).await else {
        return err(StatusCode::NOT_FOUND, "the web app isn't built");
    };
    let html = html.replacen("<head>", &format!("<head>{GATEWAY_META}"), 1);
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], html).into_response()
}

/// Lets the page ask for a session only when it's on a gateway. A static
/// host (the demo) then makes no API calls, and logs no 404s.
pub const GATEWAY_META: &str = r#"<meta name="mailbird-gateway" content="1">"#;

async fn get_session(State(gw): State<Gw>, headers: HeaderMap) -> Response {
    // Tells the web app it's on a gateway, and whether to ask for the password.
    let mut res = Json(json!({ "gateway": true, "signedIn": gw.session(&headers) })).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[derive(Deserialize)]
struct SignIn {
    password: String,
}

async fn sign_in(State(gw): State<Gw>, headers: HeaderMap, Json(body): Json<SignIn>) -> Response {
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    {
        let f = gw.failures.lock().expect("failures lock");
        if f.0.elapsed() < FAILURE_WINDOW && f.1 >= MAX_FAILURES {
            return err(StatusCode::TOO_MANY_REQUESTS, "too many wrong passwords — wait a few minutes");
        }
    }
    if !same(&body.password, &gw.config.password) {
        {
            let mut f = gw.failures.lock().expect("failures lock");
            if f.0.elapsed() >= FAILURE_WINDOW {
                *f = (Instant::now(), 0);
            }
            f.1 += 1;
        }
        // A pause makes guessing slow even inside the limit.
        tokio::time::sleep(Duration::from_millis(500)).await;
        return err(StatusCode::UNAUTHORIZED, "that's not the gateway password");
    }
    let token = random_token();
    gw.sessions.lock().expect("sessions lock").insert(token.clone(), Instant::now());
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(header::SET_COOKIE, gw.cookie_header(&token, SESSION_IDLE.as_secs()));
    res
}

async fn sign_out(State(gw): State<Gw>, headers: HeaderMap) -> Response {
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    if let Some(token) = cookie(&headers, COOKIE) {
        gw.sessions.lock().expect("sessions lock").retain(|t, _| !same(t, &token));
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(header::SET_COOKIE, gw.cookie_header("", 0));
    res
}

async fn core(State(gw): State<Gw>, UrlPath(name): UrlPath<String>, headers: HeaderMap, body: Bytes) -> Response {
    if !gw.session(&headers) {
        return err(StatusCode::UNAUTHORIZED, "sign in first");
    }
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    let args: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap_or(Value::Null) };
    match pim_app::dispatch(&gw.app, &gw.state, &name, args).await {
        Ok(Output::Json(v)) => Json(v).into_response(),
        Ok(Output::Bytes(b)) => ([(header::CONTENT_TYPE, "application/octet-stream")], b).into_response(),
        Err(e) if e.starts_with("unknown command") => err(StatusCode::NOT_FOUND, e),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn events(State(gw): State<Gw>, headers: HeaderMap) -> Response {
    if !gw.session(&headers) {
        return err(StatusCode::UNAUTHORIZED, "sign in first");
    }
    let rx = gw.events.subscribe();
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok((name, payload)) => return Some((Ok::<_, Infallible>(Event::default().event(name).data(payload.to_string())), rx)),
                // A slow page missed some events: it refetches on the next one anyway.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    sse(stream).into_response()
}

fn sse(stream: impl Stream<Item = Result<Event, Infallible>> + Send + 'static) -> Sse<impl Stream<Item = Result<Event, Infallible>> + Send> {
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
}

// ── Scheduling links: the only routes that need no session ─────────────────

/// What a visitor's request returns. Unknown and deleted links look the same.
fn public_result(r: Result<Output, String>) -> Response {
    let mut res = match r {
        Ok(Output::Json(v)) => Json(v).into_response(),
        Ok(Output::Bytes(_)) => err(StatusCode::INTERNAL_SERVER_ERROR, "unexpected reply"),
        Err(e) if e.contains("isn't active") => err(StatusCode::NOT_FOUND, e),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    };
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Tokens are 32 hex characters; anything else never reaches the core.
fn token_ok(t: &str) -> bool {
    t.len() == 32 && t.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn booking_page(State(gw): State<Gw>, UrlPath(token): UrlPath<String>) -> Response {
    if !token_ok(&token) {
        return err(StatusCode::NOT_FOUND, "this booking link isn't active");
    }
    public_result(pim_app::dispatch(&gw.app, &gw.state, "public_booking", json!({ "token": token })).await)
}

async fn booking(State(gw): State<Gw>, UrlPath(token): UrlPath<String>, headers: HeaderMap, body: Bytes) -> Response {
    // Same rule as the app's writes: another site's form can't book for someone.
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    if !token_ok(&token) {
        return err(StatusCode::NOT_FOUND, "this booking link isn't active");
    }
    {
        let mut b = gw.bookings.lock().expect("bookings lock");
        if b.0.elapsed() >= BOOKING_WINDOW {
            *b = (Instant::now(), 0);
        }
        if b.1 >= MAX_BOOKINGS {
            return err(StatusCode::TOO_MANY_REQUESTS, "lots of bookings just now — try again in a few minutes");
        }
        b.1 += 1;
    }
    let Ok(request) = serde_json::from_slice::<Value>(&body) else { return err(StatusCode::BAD_REQUEST, "that booking wasn't readable") };
    let manage_base = gw.config.public_url.as_deref().map(|u| format!("{}/book/{token}/b/", u.trim_end_matches('/')));
    public_result(pim_app::dispatch(&gw.app, &gw.state, "book_slot", json!({ "token": token, "request": request, "manageBase": manage_base })).await)
}

async fn managed_booking(State(gw): State<Gw>, UrlPath((token, code)): UrlPath<(String, String)>) -> Response {
    if !token_ok(&token) || !token_ok(&code) {
        return err(StatusCode::NOT_FOUND, "this booking link isn't active");
    }
    public_result(pim_app::dispatch(&gw.app, &gw.state, "managed_booking", json!({ "token": token, "code": code })).await)
}

async fn change_booking(State(gw): State<Gw>, UrlPath((token, code)): UrlPath<(String, String)>, headers: HeaderMap, body: Bytes) -> Response {
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    if !token_ok(&token) || !token_ok(&code) {
        return err(StatusCode::NOT_FOUND, "this booking link isn't active");
    }
    // Changes count against the same limit as new bookings.
    {
        let mut b = gw.bookings.lock().expect("bookings lock");
        if b.0.elapsed() >= BOOKING_WINDOW {
            *b = (Instant::now(), 0);
        }
        if b.1 >= MAX_BOOKINGS {
            return err(StatusCode::TOO_MANY_REQUESTS, "lots of bookings just now — try again in a few minutes");
        }
        b.1 += 1;
    }
    let Ok(change) = serde_json::from_slice::<Value>(&body) else { return err(StatusCode::BAD_REQUEST, "that change wasn't readable") };
    public_result(pim_app::dispatch(&gw.app, &gw.state, "change_booking", json!({ "token": token, "code": code, "change": change })).await)
}

/// An attachment as a download, with its own file name.
async fn attachment(State(gw): State<Gw>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Response {
    if !gw.session(&headers) {
        return err(StatusCode::UNAUTHORIZED, "sign in first");
    }
    let found = gw.state.store.lock().map_err(|_| "the mail database is unavailable".to_string()).and_then(|s| s.attachment(&id).map_err(|e| e.to_string()));
    match found {
        Ok((info, bytes)) => {
            // RFC 6266: an ASCII fallback plus the UTF-8 name.
            let ascii: String = info.filename.chars().map(|c| if c.is_ascii_alphanumeric() || ".-_ ".contains(c) { c } else { '_' }).collect();
            let utf8: String = info.filename.bytes().map(|b| if b.is_ascii_alphanumeric() || b".-_".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
            Response::builder()
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{utf8}"))
                .body(Body::from(bytes))
                .expect("a valid response")
        }
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}
