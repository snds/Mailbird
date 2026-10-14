//! The app's relay client (`pim_core::net::push_relay`) against this relay.

use std::sync::Arc;

use mailbird_push_relay::{api, crypto, notify, store, watch};
use pim_core::net::push_relay::{PushTarget, RelayClient, account_key};
use pim_core::{AccountConfig, Error, Provider, Security, ServerConfig};

const TOKEN: &str = "relay-token-for-tests-123";

fn imap_config(port: u16) -> AccountConfig {
    AccountConfig {
        display_name: "Ana".into(),
        address: "ana@example.com".into(),
        username: "ana@example.com".into(),
        provider: Provider::ICloud,
        imap: ServerConfig { host: "127.0.0.1".into(), port, security: Security::Plain },
        smtp: ServerConfig { host: "127.0.0.1".into(), port, security: Security::Plain },
        jmap: None,
        dav: None,
        oauth: None,
    }
}

#[tokio::test]
async fn the_app_talks_to_the_relay() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let relay = watch::Relay::new(store::Store::in_memory(), notify::Notifier::new(None, None), crypto::Sealer::new(&crypto::new_key()).unwrap());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let app = api::router(Arc::new(api::Api { relay: relay.clone(), token: TOKEN.into(), public_url: Some("https://relay.example.com".into()) }));
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

    assert!(matches!(RelayClient::new(&base, "wrong-token-wrong-token").unwrap().info().await, Err(Error::Auth(_))));
    let c = RelayClient::new(&base, TOKEN).unwrap();
    let info = c.info().await.unwrap();
    assert!(info.targets.unifiedpush && !info.targets.apns && info.outlook);

    let device = "desktop-test-0001";
    assert!(matches!(c.register(device, &PushTarget::Apns { token: "t".into(), sandbox: false }).await, Err(Error::Network(m)) if m.contains("no APNs key")), "the relay's own words come through");
    c.register(device, &PushTarget::UnifiedPush { endpoint: "https://ntfy.example.com/topic".into() }).await.unwrap();

    let key = account_key("6f1c0b2e-8c4d-4b51-9d7e-0a1b2c3d4e5f");
    // A port nothing listens on: the IMAP server is "down".
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    c.watch(device, &key, &imap_config(closed), "app-password").await.unwrap();
    let (url, state) = c.watch_outlook(device, "acct-outlook-1").await.unwrap();
    assert!(url.starts_with("https://relay.example.com/graph/") && state.len() > 20);
    assert_eq!(c.watch_outlook(device, "acct-outlook-1").await.unwrap(), (url, state), "stable across calls");

    let status = c.status(device).await.unwrap().unwrap();
    assert_eq!(status[&key].kind, "imap");
    assert_eq!(status["acct-outlook-1"].kind, "graph");
    // The IMAP server isn't there: the watch says so instead of pushing.
    for _ in 0..50 {
        if c.status(device).await.unwrap().unwrap()[&key].error.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(c.status(device).await.unwrap().unwrap()[&key].error.as_deref().is_some_and(|e| e.contains("refused")), "the relay's error reaches the app");

    c.unwatch(device, &key).await.unwrap();
    assert!(!c.status(device).await.unwrap().unwrap().contains_key(&key));
    c.forget(device).await.unwrap();
    assert_eq!(c.status(device).await.unwrap(), None);
}
