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
//! It's self-hosted: the owner's password, sessions in an HttpOnly cookie,
//! and secrets sealed in a file with `GATEWAY_KEY`. The owner can add team
//! members (ADR-0063), who sign in with their own password and work the
//! mail with them: a shared inbox. Members reach mail only.
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

mod members;
pub use members::Members;

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
pub(crate) fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) fn random_token() -> String {
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
    /// The owner's password, 16+ characters.
    pub password: String,
    /// The team (ADR-0063): `members.json` in the data folder.
    pub members: Members,
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

/// Who a session is: the owner, or one of their team.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Who {
    pub id: String,
    pub name: String,
    pub owner: bool,
}

impl Who {
    fn teammate(&self) -> Value {
        json!({ "id": self.id, "name": self.name })
    }
}

/// The owner's id in assignments and notes.
const OWNER_ID: &str = "owner";

/// What a team member may do: their mail, and the team's side of it. Not
/// accounts, settings, notes, calendars, or contacts, which stay the
/// owner's (ADR-0063).
const MEMBER_COMMANDS: &[&str] = &[
    "list_splits",
    "inbox_overview",
    "bundle_mark_read",
    "bundle_archive",
    "unarchive_bundle",
    "swipe_actions",
    "key_bindings",
    "provider_capabilities",
    "list_accounts",
    "sync_now",
    "list_messages",
    "get_thread",
    "set_thread_seen",
    "set_thread_flagged",
    "set_thread_archived",
    "snooze_thread",
    "unsnooze_thread",
    "attachment_data",
    "queue_send",
    "cancel_send",
    "list_outbox",
    "reschedule_send",
    "set_follow_up",
    "cancel_follow_up",
    "unsubscribe",
    "list_templates",
    "list_signatures",
    "screener_status",
    "list_senders",
    "suggest_recipients",
    "sender_profile",
    "contact_photos",
    "local_times",
    "mail_prefs",
    "ai_settings",
    "summarize_thread",
    "suggest_replies",
    "thread_team",
    "thread_assignments",
    "assign_thread",
    "add_thread_comment",
    "remove_thread_comment",
];

/// Events a member's page hears: mail's, not the owner's notes or reminders.
const MEMBER_EVENTS: &[&str] = &["mail:changed", "outbox:changed", "accounts:changed", "compose:changed", "inbox-team:changed", "inbox:here"];

/// How long "who's here" lasts without the page saying so again.
const HERE_FOR: Duration = Duration::from_secs(70);

pub struct Gateway {
    app: AppHandle,
    state: Shared,
    events: broadcast::Sender<(String, Value)>,
    config: Config,
    /// token → (last used, who).
    sessions: Mutex<HashMap<String, (Instant, Who)>>,
    /// Who has which conversation open: person id → (thread, name, when).
    here: Mutex<HashMap<String, (String, String, Instant)>>,
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
        Arc::new(Self { app, state, events, config, sessions: Mutex::new(HashMap::new()), here: Mutex::new(HashMap::new()), failures: Mutex::new((Instant::now(), 0)), bookings: Mutex::new((Instant::now(), 0)) })
    }

    fn session(&self, headers: &HeaderMap) -> Option<Who> {
        let token = cookie(headers, COOKIE)?;
        let mut sessions = self.sessions.lock().expect("sessions lock");
        sessions.retain(|_, (used, _)| used.elapsed() < SESSION_IDLE);
        let (_, (used, who)) = sessions.iter_mut().find(|(t, _)| same(t, &token))?;
        *used = Instant::now();
        let who = who.clone();
        drop(sessions);
        // The owner goes by their first account's name, which can change (or arrive) after signing in.
        Some(if who.owner { self.owner() } else { who })
    }

    fn start_session(&self, who: Who) -> Response {
        let token = random_token();
        self.sessions.lock().expect("sessions lock").insert(token.clone(), (Instant::now(), who));
        let mut res = StatusCode::NO_CONTENT.into_response();
        res.headers_mut().insert(header::SET_COOKIE, self.cookie_header(&token, SESSION_IDLE.as_secs()));
        res
    }

    /// The owner, named as their first account names them (as their comments are).
    fn owner(&self) -> Who {
        let name = self.state.store.lock().ok().and_then(|s| s.accounts().ok()).and_then(|a| a.into_iter().next()).map(|a| if a.config.display_name.trim().is_empty() { a.config.address } else { a.config.display_name });
        Who { id: OWNER_ID.into(), name: name.unwrap_or_else(|| "Owner".into()), owner: true }
    }

    /// Who has each conversation open, for every page.
    fn broadcast_here(&self) {
        let mut here = self.here.lock().expect("here lock");
        here.retain(|_, (_, _, at)| at.elapsed() < HERE_FOR);
        let mut threads: HashMap<String, Vec<Value>> = HashMap::new();
        for (id, (thread, name, _)) in here.iter() {
            threads.entry(thread.clone()).or_default().push(json!({ "id": id, "name": name }));
        }
        let _ = self.events.send(("inbox:here".into(), json!({ "threads": threads })));
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
// `wasm-unsafe-eval` lets the on-device text reader (Tesseract, ADR-0045) compile its
// WebAssembly; it doesn't allow `eval` of scripts.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:*; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
        // The team (ADR-0063): the owner adds and removes people; an invitation sets a password.
        .route("/api/members", get(list_members).post(add_member))
        .route("/api/members/{id}", axum::routing::delete(remove_member))
        .route("/api/members/{id}/invite", post(reinvite_member))
        .route("/api/join", post(join))
        .route("/api/here", post(here))
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
    let body = match gw.session(&headers) {
        Some(w) => json!({ "gateway": true, "signedIn": true, "me": { "id": w.id, "name": w.name, "role": if w.owner { "owner" } else { "member" } } }),
        None => json!({ "gateway": true, "signedIn": false }),
    };
    let mut res = Json(body).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[derive(Deserialize)]
struct SignIn {
    password: String,
    /// A team member's; the owner leaves it out.
    #[serde(default)]
    email: Option<String>,
}

/// Counts a failed sign-in, and makes the next guess wait.
async fn failed(gw: &Gateway) {
    {
        let mut f = gw.failures.lock().expect("failures lock");
        if f.0.elapsed() >= FAILURE_WINDOW {
            *f = (Instant::now(), 0);
        }
        f.1 += 1;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
}

fn locked_out(gw: &Gateway) -> bool {
    let f = gw.failures.lock().expect("failures lock");
    f.0.elapsed() < FAILURE_WINDOW && f.1 >= MAX_FAILURES
}

async fn sign_in(State(gw): State<Gw>, headers: HeaderMap, Json(body): Json<SignIn>) -> Response {
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    if locked_out(&gw) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many wrong passwords — wait a few minutes");
    }
    // A team member (ADR-0063): their email and their own password.
    if let Some(email) = body.email.as_deref().filter(|e| !e.trim().is_empty()) {
        let (email, password) = (email.to_owned(), body.password.clone());
        let g = gw.clone();
        // PBKDF2 takes a moment: off the async threads.
        let found = tokio::task::spawn_blocking(move || g.config.members.check(&email, &password)).await.ok().flatten();
        return match found {
            Some(m) => gw.start_session(Who { id: m.id, name: m.name, owner: false }),
            None => {
                failed(&gw).await;
                err(StatusCode::UNAUTHORIZED, "that email and password don't match")
            }
        };
    }
    if !same(&body.password, &gw.config.password) {
        // A pause makes guessing slow even inside the limit.
        failed(&gw).await;
        return err(StatusCode::UNAUTHORIZED, "that's not the gateway password");
    }
    gw.start_session(gw.owner())
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
    let Some(who) = gw.session(&headers) else { return err(StatusCode::UNAUTHORIZED, "sign in first") };
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    if !who.owner && !MEMBER_COMMANDS.contains(&name.as_str()) {
        return err(StatusCode::FORBIDDEN, "only the gateway's owner can do that");
    }
    let mut args: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap_or(Value::Null) };
    // Who's acting comes from the session, whatever the page sent.
    if matches!(name.as_str(), "assign_thread" | "add_thread_comment" | "remove_thread_comment") {
        if !args.is_object() {
            args = json!({});
        }
        args["by"] = who.teammate();
        args["owner"] = Value::Bool(who.owner);
        if name == "assign_thread" {
            match args.get("to").and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_owned) {
                None => {}
                Some(id) => match gw.teammate(&id) {
                    Some(t) => args["to"] = t,
                    None => return err(StatusCode::BAD_REQUEST, "they aren't on the team"),
                },
            }
        }
    }
    match pim_app::dispatch(&gw.app, &gw.state, &name, args).await {
        Ok(Output::Json(v)) => Json(v).into_response(),
        Ok(Output::Bytes(b)) => ([(header::CONTENT_TYPE, "application/octet-stream")], b).into_response(),
        Err(e) if e.starts_with("unknown command") => err(StatusCode::NOT_FOUND, e),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn events(State(gw): State<Gw>, headers: HeaderMap) -> Response {
    let Some(who) = gw.session(&headers) else { return err(StatusCode::UNAUTHORIZED, "sign in first") };
    let rx = gw.events.subscribe();
    let owner = who.owner;
    let stream = futures::stream::unfold(rx, move |mut rx| async move {
        loop {
            match rx.recv().await {
                // A member hears mail's events only.
                Ok((name, _)) if !owner && !MEMBER_EVENTS.contains(&name.as_str()) => continue,
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
    if gw.session(&headers).is_none() {
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

// ── The team (ADR-0063) ─────────────────────────────────────────────────────

impl Gateway {
    /// Someone you can assign to: the owner, or a member who has joined.
    fn teammate(&self, id: &str) -> Option<Value> {
        if id == OWNER_ID {
            return Some(self.owner().teammate());
        }
        self.config.members.get(id).filter(|m| !m.pending()).map(|m| json!({ "id": m.id, "name": m.name }))
    }

    /// Someone joined or left: every page refreshes who's on the team.
    fn team_changed(&self) {
        let _ = self.events.send(("inbox-team:changed".into(), json!({ "threadId": "" })));
    }

    fn end_sessions_of(&self, id: &str) {
        self.sessions.lock().expect("sessions lock").retain(|_, (_, w)| w.id != id);
        self.here.lock().expect("here lock").remove(id);
    }
}

fn member_json(m: &members::Member, owner_view: bool) -> Value {
    if owner_view {
        json!({ "id": m.id, "name": m.name, "email": m.email, "role": "member", "pending": m.pending(), "created": m.created })
    } else {
        json!({ "id": m.id, "name": m.name, "role": "member" })
    }
}

/// Everyone on the team, owner first. Members see names, for assigning;
/// the owner also sees addresses and who hasn't joined yet.
async fn list_members(State(gw): State<Gw>, headers: HeaderMap) -> Response {
    let Some(who) = gw.session(&headers) else { return err(StatusCode::UNAUTHORIZED, "sign in first") };
    let owner = gw.owner();
    let mut out = vec![json!({ "id": owner.id, "name": owner.name, "role": "owner" })];
    out.extend(gw.config.members.list().iter().filter(|m| who.owner || !m.pending()).map(|m| member_json(m, who.owner)));
    let mut res = Json(Value::Array(out)).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Why this request can't change the team, if it can't: only the owner can.
fn not_owner(gw: &Gateway, headers: &HeaderMap) -> Option<Response> {
    let Some(who) = gw.session(headers) else { return Some(err(StatusCode::UNAUTHORIZED, "sign in first")) };
    if !csrf_ok(headers) {
        return Some(err(StatusCode::FORBIDDEN, "missing the X-Mailbird header"));
    }
    (!who.owner).then(|| err(StatusCode::FORBIDDEN, "only the gateway's owner can do that"))
}

#[derive(Deserialize)]
struct NewMember {
    name: String,
    email: String,
}

/// Adds someone. The answer carries their invitation code, once: the page
/// turns it into a link for the owner to send.
async fn add_member(State(gw): State<Gw>, headers: HeaderMap, Json(body): Json<NewMember>) -> Response {
    if let Some(r) = not_owner(&gw, &headers) {
        return r;
    }
    match gw.config.members.add(&body.name, &body.email) {
        Ok((m, code)) => Json(json!({ "member": member_json(&m, true), "code": code, "days": members::INVITE_DAYS })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn reinvite_member(State(gw): State<Gw>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Response {
    if let Some(r) = not_owner(&gw, &headers) {
        return r;
    }
    match gw.config.members.reinvite(&id) {
        Ok((m, code)) => Json(json!({ "member": member_json(&m, true), "code": code, "days": members::INVITE_DAYS })).into_response(),
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

/// Takes someone off the team: they're signed out now, and what was assigned to them goes back to nobody.
async fn remove_member(State(gw): State<Gw>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Response {
    if let Some(r) = not_owner(&gw, &headers) {
        return r;
    }
    match gw.config.members.remove(&id) {
        Ok(m) => {
            gw.end_sessions_of(&m.id);
            let _ = pim_app::dispatch(&gw.app, &gw.state, "unassign_member", json!({ "memberId": m.id })).await;
            gw.broadcast_here();
            gw.team_changed();
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct Join {
    code: String,
    password: String,
}

/// Opening an invitation: they choose a password and are signed in.
async fn join(State(gw): State<Gw>, headers: HeaderMap, Json(body): Json<Join>) -> Response {
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    if locked_out(&gw) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many tries — wait a few minutes");
    }
    let g = gw.clone();
    let accepted = tokio::task::spawn_blocking(move || g.config.members.accept(&body.code, &body.password)).await.unwrap_or_else(|_| Err("try again".into()));
    match accepted {
        Ok(m) => {
            gw.team_changed();
            gw.start_session(Who { id: m.id, name: m.name, owner: false })
        }
        Err(e) => {
            if e.contains("doesn't work") {
                failed(&gw).await;
            }
            err(StatusCode::BAD_REQUEST, e)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Here {
    thread_id: Option<String>,
}

/// The page says which conversation is open (or none); everyone hears who's where.
async fn here(State(gw): State<Gw>, headers: HeaderMap, Json(body): Json<Here>) -> Response {
    let Some(who) = gw.session(&headers) else { return err(StatusCode::UNAUTHORIZED, "sign in first") };
    if !csrf_ok(&headers) {
        return err(StatusCode::FORBIDDEN, "missing the X-Mailbird header");
    }
    {
        let mut here = gw.here.lock().expect("here lock");
        match body.thread_id.filter(|t| !t.is_empty() && t.len() <= 200) {
            Some(t) => here.insert(who.id.clone(), (t, who.name.clone(), Instant::now())),
            None => here.remove(&who.id),
        };
    }
    gw.broadcast_here();
    StatusCode::NO_CONTENT.into_response()
}
