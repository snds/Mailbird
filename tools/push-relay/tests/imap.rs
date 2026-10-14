//! The relay watching a real IMAP server (Dovecot) with IDLE. Needs the test
//! servers from `tools/test-mail-servers/start.sh`, so it's ignored by
//! default; CI runs it in the mail-integration job with `--ignored`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::routing::post;
use mailbird_push_relay::{api, crypto, notify, store, watch};
use pim_core::{AccountConfig, Provider, Security, ServerConfig};
use serde_json::json;

const TOKEN: &str = "relay-token-for-tests-123";

fn config() -> AccountConfig {
    AccountConfig {
        display_name: "Test User".into(),
        address: "tester@localhost.test".into(),
        username: "tester".into(),
        provider: Provider::Generic,
        imap: ServerConfig { host: "127.0.0.1".into(), port: 1143, security: Security::Plain },
        smtp: ServerConfig { host: "127.0.0.1".into(), port: 2525, security: Security::Plain },
        jmap: None,
        dav: None,
        oauth: None,
    }
}

#[tokio::test]
#[ignore = "needs the Dovecot test server (tools/test-mail-servers/start.sh)"]
async fn imap_idle_wakes_the_phone() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let got: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up = format!("http://{}/up/phone", l.local_addr().unwrap());
    let g = got.clone();
    tokio::spawn(async move {
        let app = Router::new().route("/up/phone", post(|State(g): State<Arc<Mutex<Vec<String>>>>, body: String| async move { g.lock().unwrap().push(body) })).with_state(g);
        axum::serve(l, app).await.unwrap()
    });

    let relay = watch::Relay::with_debounce(store::Store::in_memory(), notify::Notifier::new(None, None), crypto::Sealer::new(&crypto::new_key()).unwrap(), 1);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let app = api::router(Arc::new(api::Api { relay: relay.clone(), token: TOKEN.into(), public_url: None }));
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let http = reqwest::Client::new();
    http.put(format!("{base}/v1/devices/phone-0001")).bearer_auth(TOKEN).json(&json!({ "platform": "unifiedpush", "endpoint": up })).send().await.unwrap();
    let r = http.put(format!("{base}/v1/devices/phone-0001/watches/acct-imap-1")).bearer_auth(TOKEN).json(&json!({ "kind": "imap", "config": config(), "secret": "secret" })).send().await.unwrap();
    assert_eq!(r.status(), 200);

    // Give IDLE a moment to start, then deliver a message.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", 1143)).await.unwrap();
    let mut client = async_imap::Client::new(tcp);
    client.read_response().await.unwrap();
    let mut s = client.login("tester", "secret").await.map_err(|(e, _)| e).unwrap();
    let raw = "From: Ana <ana@example.com>\r\nTo: tester@localhost.test\r\nSubject: Relay ping\r\nMessage-ID: <relay-ping@example.com>\r\n\r\nHi\r\n";
    s.append("INBOX", None, None, raw.as_bytes()).await.unwrap();
    let _ = s.logout().await;

    for _ in 0..100 {
        if !got.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let pushes = got.lock().unwrap().clone();
    assert_eq!(pushes.first().map(|b| serde_json::from_str::<serde_json::Value>(b).unwrap()), Some(json!({ "account": "acct-imap-1", "kind": "mail" })), "IDLE saw the new message");
    let status: HashMap<String, serde_json::Value> = http.get(format!("{base}/v1/devices/phone-0001")).bearer_auth(TOKEN).send().await.unwrap().json::<serde_json::Value>().await.unwrap()["watches"].as_object().unwrap().clone().into_iter().collect();
    assert!(status["acct-imap-1"]["status"]["error"].is_null());
}
