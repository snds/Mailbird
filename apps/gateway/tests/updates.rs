//! Update checks on the gateway (ADR-0077): the owner sees the version and
//! the channel, checks now, and turns the automatic check off and on; a
//! newer image shows its version and the command that takes it. A team
//! member and a stranger see none of it, and writes need the X-Vale header.

use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use serde_json::{Value, json};
use vale_gateway::updates::{MAIN_ENDPOINT, ManifestSource, OFF_NOT_MAIN, UPDATE_COMMAND, Updates};
use vale_gateway::{Config, Gateway, Members, SealedFile, router};

const PASSWORD: &str = "gateway-password-for-tests";

/// The manifest a test serves, and every address asked for.
struct Manifest(&'static str, Mutex<Vec<String>>);

impl ManifestSource for Manifest {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        self.1.lock().unwrap().push(url.to_string());
        Box::pin(async move { Ok(self.0.as_bytes().to_vec()) })
    }
}

async fn serve(name: &str, updates: Option<Updates>) -> String {
    use base64::Engine;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = std::env::temp_dir().join(format!("gateway-updates-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let web = dir.join("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!doctype html><html><head></head></html>",
    )
    .unwrap();
    pim_app::secrets::install(Box::new(
        SealedFile::open(
            dir.join("secrets.json"),
            &base64::engine::general_purpose::STANDARD.encode([7u8; 32]),
        )
        .unwrap(),
    ));
    let state = pim_app::AppState::open(&dir.join("data")).unwrap();
    let config = Config {
        password: PASSWORD.into(),
        members: Members::open(dir.join("members.json")).unwrap(),
        web_dir: web,
        secure_cookies: false,
        public_url: None,
    };
    let gw = match updates {
        Some(u) => Gateway::with_updates(state, config, u),
        None => Gateway::new(state, config),
    };
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, router(gw)).await.unwrap() });
    base
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .unwrap()
}

#[tokio::test]
async fn the_owner_checks_for_updates_and_sees_the_command_for_a_newer_image() {
    let source = Arc::new(Manifest(
        r#"{"version":"0.1.0-main.20261109120000","image":"ghcr.io/snds/vale-gateway"}"#,
        Mutex::default(),
    ));
    let updates = Updates::new(
        semver::Version::parse("0.1.0-main.20261108090000").unwrap(),
        Some(source.clone()),
    );
    let base = serve("main", Some(updates)).await;
    let (owner, ana, stranger) = (client(), client(), client());
    let post = |c: &reqwest::Client, path: &str, body: Value| {
        c.post(format!("{base}{path}"))
            .header("X-Vale", "1")
            .json(&body)
            .send()
    };
    let get = |c: &reqwest::Client, path: &str| c.get(format!("{base}{path}")).send();

    // A stranger: nothing, and nothing is checked.
    assert_eq!(get(&stranger, "/api/updates").await.unwrap().status(), 401);
    assert_eq!(
        post(&stranger, "/api/updates/check", json!({}))
            .await
            .unwrap()
            .status(),
        401
    );
    assert!(source.1.lock().unwrap().is_empty());

    // The owner, before any check: the version, the channel, the switch on.
    assert_eq!(
        post(&owner, "/api/session", json!({ "password": PASSWORD }))
            .await
            .unwrap()
            .status(),
        204
    );
    let s: Value = get(&owner, "/api/updates")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["version"], "0.1.0-main.20261108090000");
    assert_eq!(s["channel"], "main");
    assert_eq!(s["enabled"], true);
    assert_eq!(s["autoCheck"], true);
    assert_eq!(s["state"], "idle");
    assert_eq!(
        s["line"],
        "Vale gateway checks for updates when it starts and every six hours."
    );
    assert!(s.get("command").is_none());

    // A team member sees none of it.
    let added: Value = post(
        &owner,
        "/api/members",
        json!({ "name": "Ana", "email": "ana@example.com" }),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        post(
            &ana,
            "/api/join",
            json!({ "code": added["code"], "password": "ana-password-12" })
        )
        .await
        .unwrap()
        .status(),
        204
    );
    assert_eq!(get(&ana, "/api/updates").await.unwrap().status(), 403);
    assert_eq!(
        post(&ana, "/api/updates/check", json!({}))
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        post(&ana, "/api/updates/auto", json!({ "on": false }))
            .await
            .unwrap()
            .status(),
        403
    );
    assert!(source.1.lock().unwrap().is_empty());

    // Writes need the header, even from the owner.
    let no_header = owner
        .post(format!("{base}/api/updates/check"))
        .send()
        .await
        .unwrap();
    assert_eq!(no_header.status(), 403);
    assert!(source.1.lock().unwrap().is_empty());

    // Check for updates: one read of the manifest beside the image, and the command.
    let s: Value = post(&owner, "/api/updates/check", json!({}))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(*source.1.lock().unwrap(), vec![MAIN_ENDPOINT.to_string()]);
    assert_eq!(s["state"], "available");
    assert_eq!(s["offered"], "0.1.0-main.20261109120000");
    assert_eq!(s["line"], "Version 0.1.0-main.20261109120000 is out.");
    assert_eq!(s["command"], UPDATE_COMMAND);
    assert_eq!(s["image"], "ghcr.io/snds/vale-gateway");
    assert!(s["checkedAt"].as_i64().unwrap() > 0);
    let again: Value = get(&owner, "/api/updates")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["state"], "available");

    // The switch: off, kept off, then on again.
    let s: Value = post(&owner, "/api/updates/auto", json!({ "on": false }))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["autoCheck"], false);
    let s: Value = get(&owner, "/api/updates")
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["autoCheck"], false);
    let s: Value = post(&owner, "/api/updates/auto", json!({ "on": true }))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["autoCheck"], true);
}

#[tokio::test]
async fn a_build_from_source_says_it_doesnt_check() {
    let base = serve("source", None).await;
    let owner = client();
    assert_eq!(
        owner
            .post(format!("{base}/api/session"))
            .header("X-Vale", "1")
            .json(&json!({ "password": PASSWORD }))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let s: Value = owner
        .get(format!("{base}/api/updates"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Tests run unstamped (the crate's version): not a main-channel build.
    if vale_gateway::updates::running().pre.is_empty() {
        assert_eq!(s["enabled"], false);
        assert_eq!(s["line"], OFF_NOT_MAIN);
        let checked: Value = owner
            .post(format!("{base}/api/updates/check"))
            .header("X-Vale", "1")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(checked["state"], "idle", "nothing is fetched");
    }
}
