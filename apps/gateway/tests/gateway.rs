//! The gateway over HTTP: sign-in, sessions, the CSRF header, commands
//! through the shared dispatcher, the event stream, attachments, secrets
//! sealed on disk, and the web app with its single-page fallback.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use mailbird_gateway::{Config, Gateway, SealedFile, router};
use pim_app::secrets::SecretStore;
use serde_json::{Value, json};

const PASSWORD: &str = "gateway-password-for-tests";

fn key() -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode([7u8; 32])
}

#[tokio::test]
async fn gateway_end_to_end() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = std::env::temp_dir().join(format!("gateway-test-{}", std::process::id()));
    let web = dir.join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><html><head><title>Mailbird</title></head></html>").unwrap();
    std::fs::write(web.join("assets/app.js"), "console.log('hi')").unwrap();

    let secrets = SealedFile::open(dir.join("secrets.json"), &key()).unwrap();
    pim_app::secrets::install(Box::new(secrets));
    let state = pim_app::AppState::open(&dir.join("data")).unwrap();
    let gw = Gateway::new(state, Config { password: PASSWORD.into(), web_dir: web.clone(), secure_cookies: false });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, router(gw)).await.unwrap() });

    let anon = reqwest::Client::new();
    let http = reqwest::Client::builder().cookie_store(true).build().unwrap();
    let core = |c: &reqwest::Client, name: &str, args: Value| c.post(format!("{base}/api/core/{name}")).header("X-Mailbird", "1").json(&args).send();

    // Not signed in: the page learns it's a gateway; the API refuses.
    let s: Value = anon.get(format!("{base}/api/session")).send().await.unwrap().json().await.unwrap();
    assert_eq!(s, json!({ "gateway": true, "signedIn": false }));
    assert_eq!(core(&anon, "list_accounts", Value::Null).await.unwrap().status(), 401);
    assert_eq!(anon.get(format!("{base}/api/events")).send().await.unwrap().status(), 401);

    // Sign-in: CSRF header required, wrong password refused, right one sets an HttpOnly, SameSite=Strict cookie.
    assert_eq!(http.post(format!("{base}/api/session")).json(&json!({ "password": PASSWORD })).send().await.unwrap().status(), 403, "no X-Mailbird header");
    assert_eq!(http.post(format!("{base}/api/session")).header("X-Mailbird", "1").json(&json!({ "password": "wrong" })).send().await.unwrap().status(), 401);
    let ok = http.post(format!("{base}/api/session")).header("X-Mailbird", "1").json(&json!({ "password": PASSWORD })).send().await.unwrap();
    assert_eq!(ok.status(), 204);
    let cookie = ok.headers()["set-cookie"].to_str().unwrap().to_owned();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"), "{cookie}");
    let s: Value = http.get(format!("{base}/api/session")).send().await.unwrap().json().await.unwrap();
    assert_eq!(s["signedIn"], true);

    // Commands: the same dispatcher and arguments as the desktop app.
    assert_eq!(http.post(format!("{base}/api/core/list_accounts")).json(&Value::Null).send().await.unwrap().status(), 403, "writes need the header even when signed in");
    let accounts: Value = core(&http, "list_accounts", Value::Null).await.unwrap().json().await.unwrap();
    assert_eq!(accounts, json!([]));
    let unknown = core(&http, "drop_everything", Value::Null).await.unwrap();
    assert_eq!(unknown.status(), 404);
    let bad = core(&http, "get_thread", json!({})).await.unwrap();
    assert_eq!(bad.status(), 400);
    assert!(bad.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("bad arguments"));

    // Events: a change shows up on the stream.
    let mut stream = http.get(format!("{base}/api/events")).send().await.unwrap().bytes_stream();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let note: Value = core(&http, "create_note", json!({ "input": { "markdown": "# From the gateway" } })).await.unwrap().json().await.unwrap();
    assert_eq!(note["title"], "From the gateway");
    let mut seen = String::new();
    while !seen.contains("event: notes:changed") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next()).await.expect("an event within 5 s").unwrap().unwrap();
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }

    // Secrets go to the sealed file, never in the clear.
    let relay = core(&http, "set_notes_relay", json!({ "relay": { "url": "wss://relay.example.com", "token": "notes-relay-secret-token" } })).await.unwrap();
    assert!(relay.status().is_success(), "{:?}", relay.text().await);
    let on_disk = std::fs::read_to_string(dir.join("secrets.json")).unwrap();
    assert!(!on_disk.contains("notes-relay-secret-token"), "sealed: {on_disk}");
    let reopened = SealedFile::open(dir.join("secrets.json"), &key()).unwrap();
    assert_eq!(reopened.get("notes-relay").unwrap().as_deref(), Some("notes-relay-secret-token"));
    use base64::Engine;
    assert!(SealedFile::open(dir.join("secrets.json"), &base64::engine::general_purpose::STANDARD.encode([9u8; 32])).unwrap().get("notes-relay").is_err(), "another key can't open them");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("secrets.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // Attachments: unknown ids are 404, and need a session.
    assert_eq!(anon.get(format!("{base}/api/attachments/nope")).send().await.unwrap().status(), 401);
    assert_eq!(http.get(format!("{base}/api/attachments/nope")).send().await.unwrap().status(), 404);

    // The web app, with security headers and a single-page fallback.
    let page = anon.get(format!("{base}/mail/inbox")).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let h = page.headers().clone();
    let html = page.text().await.unwrap();
    assert!(html.contains("<title>Mailbird</title>") && html.contains(mailbird_gateway::GATEWAY_META), "deep links get the marked app page");
    let root = anon.get(format!("{base}/")).send().await.unwrap().text().await.unwrap();
    assert!(root.contains(mailbird_gateway::GATEWAY_META), "so does the root");
    assert_eq!(h["x-frame-options"], "DENY");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert!(h["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
    assert_eq!(anon.get(format!("{base}/assets/app.js")).send().await.unwrap().text().await.unwrap(), "console.log('hi')");
    assert_eq!(anon.get(format!("{base}/api/nothing")).send().await.unwrap().status(), 404, "unknown API paths don't fall back to the page");

    // Sign out: the session ends.
    assert_eq!(http.delete(format!("{base}/api/session")).header("X-Mailbird", "1").send().await.unwrap().status(), 204);
    assert_eq!(core(&http, "list_accounts", Value::Null).await.unwrap().status(), 401);

    // Too many wrong passwords: the gateway makes you wait.
    let mut last = 0;
    for _ in 0..12 {
        last = anon.post(format!("{base}/api/session")).header("X-Mailbird", "1").json(&json!({ "password": "guess" })).send().await.unwrap().status().as_u16();
    }
    assert_eq!(last, 429);
    let _ = Arc::new(());
    let _ = std::fs::remove_dir_all(dir);
}
