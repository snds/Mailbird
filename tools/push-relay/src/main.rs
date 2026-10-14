//! `mailbird-push-relay`: configuration comes from the environment (see README.md).

use std::sync::Arc;

use mailbird_push_relay::{api, crypto, notify, store, watch};

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("push-relay: {msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    // `--health`: the container's health check asks the running relay.
    if std::env::args().nth(1).as_deref() == Some("--health") {
        let address = env("RELAY_ADDRESS").unwrap_or_else(|| "127.0.0.1:8787".into()).replace("0.0.0.0", "127.0.0.1");
        let ok = tokio::net::TcpStream::connect(&address).await.is_ok();
        std::process::exit(if ok { 0 } else { 1 });
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let token = env("RELAY_TOKEN").unwrap_or_else(|| fail("set RELAY_TOKEN (16+ characters; openssl rand -base64 24)"));
    if token.len() < 16 {
        fail("RELAY_TOKEN must be at least 16 characters");
    }
    let data = env("RELAY_DATA").unwrap_or_else(|| "./data".into());
    let key = env("RELAY_KEY").unwrap_or_else(|| fail(format!("set RELAY_KEY to seal stored passwords (for example: {})", crypto::new_key())));
    let sealer = crypto::Sealer::new(&key).unwrap_or_else(|e| fail(e));
    let store = store::Store::open(&data).unwrap_or_else(|e| fail(e));
    let apns = notify::Apns::from_env().unwrap_or_else(|e| fail(e));
    let fcm = notify::Fcm::from_env().unwrap_or_else(|e| fail(e));
    let public_url = env("RELAY_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_owned());
    if public_url.as_deref().is_some_and(|u| !u.starts_with("https://")) {
        fail("RELAY_PUBLIC_URL must be https:// (Microsoft only calls https webhooks)");
    }
    let address = env("RELAY_ADDRESS").unwrap_or_else(|| "127.0.0.1:8787".into());

    let relay = watch::Relay::new(store, notify::Notifier::new(apns, fcm), sealer);
    relay.reconcile();
    let n = &relay.notifier;
    eprintln!(
        "push-relay {} on {address}: APNs {}, FCM {}, UnifiedPush on, Outlook {}; watching {} mailboxes",
        env!("CARGO_PKG_VERSION"),
        if n.apns.is_some() { "on" } else { "off" },
        if n.fcm.is_some() { "on" } else { "off" },
        if public_url.is_some() { "on" } else { "off (no RELAY_PUBLIC_URL)" },
        relay.watching()
    );
    let app = api::router(Arc::new(api::Api { relay, token, public_url }));
    let listener = tokio::net::TcpListener::bind(&address).await.unwrap_or_else(|e| fail(format!("can't listen on {address}: {e}")));
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap_or_else(|e| fail(e));
}
