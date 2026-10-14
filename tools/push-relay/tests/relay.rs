//! The relay end to end, offline: its HTTP API, a JMAP mailbox watched
//! over a fake EventSource, Outlook's webhook, and pushes delivered to fake
//! UnifiedPush, APNs, and FCM servers that check what they're sent
//! (APNs and FCM signatures included).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mailbird_push_relay::{api, crypto, notify, store, watch};
use pim_core::{AccountConfig, JmapConfig, Provider, Security, ServerConfig};
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde_json::{Value, json};

const TOKEN: &str = "relay-token-for-tests-123";

#[derive(Default)]
struct Received {
    /// (path, headers, body)
    pushes: Vec<(String, HashMap<String, String>, String)>,
    /// APNs device tokens that answer 410.
    dead: Vec<String>,
    fcm_tokens_issued: u32,
}

async fn serve(app: Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    base
}

fn headers_map(h: &HeaderMap) -> HashMap<String, String> {
    h.iter().map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or_default().to_owned())).collect()
}

/// UnifiedPush endpoints, APNs, and FCM in one fake.
async fn push_services(rx: Arc<Mutex<Received>>) -> String {
    async fn up(State(rx): State<Arc<Mutex<Received>>>, Path(topic): Path<String>, h: HeaderMap, body: String) -> StatusCode {
        rx.lock().unwrap().pushes.push((format!("/up/{topic}"), headers_map(&h), body));
        if topic == "gone" { StatusCode::GONE } else { StatusCode::OK }
    }
    async fn apns(State(rx): State<Arc<Mutex<Received>>>, Path(token): Path<String>, h: HeaderMap, body: String) -> Response {
        let mut r = rx.lock().unwrap();
        r.pushes.push((format!("/3/device/{token}"), headers_map(&h), body));
        if r.dead.contains(&token) { (StatusCode::GONE, axum::Json(json!({ "reason": "Unregistered" }))).into_response() } else { StatusCode::OK.into_response() }
    }
    async fn fcm_token(State(rx): State<Arc<Mutex<Received>>>, body: String) -> Response {
        assert!(body.starts_with("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="));
        let mut r = rx.lock().unwrap();
        r.fcm_tokens_issued += 1;
        r.pushes.push(("/fcm-token".into(), HashMap::new(), body));
        axum::Json(json!({ "access_token": "ya29.fake", "expires_in": 3599, "token_type": "Bearer" })).into_response()
    }
    async fn fcm_send(State(rx): State<Arc<Mutex<Received>>>, Path(rest): Path<String>, h: HeaderMap, body: String) -> Response {
        rx.lock().unwrap().pushes.push((format!("/v1/projects/{rest}"), headers_map(&h), body));
        axum::Json(json!({ "name": "projects/p/messages/1" })).into_response()
    }
    serve(
        Router::new()
            .route("/up/{topic}", post(up))
            .route("/3/device/{token}", post(apns))
            .route("/fcm-token", post(fcm_token))
            .route("/v1/projects/{*rest}", post(fcm_send))
            .with_state(rx),
    )
    .await
}

/// A JMAP server with just a session and an EventSource whose state events the test sends.
struct Jmap {
    tx: tokio::sync::broadcast::Sender<String>,
    connections: Mutex<u32>,
}

async fn jmap_server(j: Arc<Jmap>) -> String {
    async fn session(State(j): State<Arc<Jmap>>, h: HeaderMap) -> Response {
        let _ = j;
        let want = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("ana@example.com:app-password"));
        if h.get("authorization").and_then(|v| v.to_str().ok()) != Some(&want) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        axum::Json(json!({
            "apiUrl": "/api", "downloadUrl": "/d/{accountId}/{blobId}/{name}", "uploadUrl": "/u/{accountId}",
            "eventSourceUrl": "/es?types={types}&closeafter={closeafter}&ping={ping}",
            "primaryAccounts": { "urn:ietf:params:jmap:mail": "u1" }, "capabilities": {}, "accounts": {}
        }))
        .into_response()
    }
    async fn es(State(j): State<Arc<Jmap>>) -> Response {
        *j.connections.lock().unwrap() += 1;
        let rx = j.tx.subscribe();
        let stream = futures::stream::unfold(rx, |mut rx| async move {
            let state = rx.recv().await.ok()?;
            let ev = format!("event: state\ndata: {{\"@type\":\"StateChange\",\"changed\":{{\"u1\":{{\"Email\":\"{state}\"}}}}}}\n\n");
            Some((Ok::<_, std::convert::Infallible>(ev), rx))
        });
        Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(stream)).unwrap()
    }
    serve(Router::new().route("/session", get(session)).route("/es", get(es)).with_state(j)).await
}

fn jmap_config(base: &str) -> AccountConfig {
    let none = ServerConfig { host: String::new(), port: 0, security: Security::Tls };
    AccountConfig {
        display_name: "Ana".into(),
        address: "ana@example.com".into(),
        username: "ana@example.com".into(),
        provider: Provider::Jmap,
        imap: none.clone(),
        smtp: none,
        jmap: Some(JmapConfig { session_url: format!("{base}/session"), bearer: false }),
        dav: None,
        oauth: None,
    }
}

async fn until<F: Fn() -> bool>(what: &str, f: F) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

fn pushes_to(rx: &Arc<Mutex<Received>>, prefix: &str) -> Vec<(String, HashMap<String, String>, String)> {
    rx.lock().unwrap().pushes.iter().filter(|(p, _, _)| p.starts_with(prefix)).cloned().collect()
}

/// An RSA key as Google's service-account JSON carries it, from the openssl CLI.
fn rsa_key() -> Option<(String, Vec<u8>)> {
    let dir = std::env::temp_dir().join(format!("relay-rsa-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).ok()?;
    let key = dir.join("k.pem");
    let ok = std::process::Command::new("openssl").args(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out"]).arg(&key).status().ok()?.success();
    if !ok {
        return None;
    }
    let pub_der = std::process::Command::new("openssl").args(["rsa", "-in"]).arg(&key).args(["-RSAPublicKey_out", "-outform", "DER"]).output().ok()?.stdout;
    let pem = std::fs::read_to_string(&key).ok()?;
    let _ = std::fs::remove_dir_all(dir);
    Some((pem, pub_der))
}

#[tokio::test]
async fn relay_end_to_end() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let rx = Arc::new(Mutex::new(Received::default()));
    let services = push_services(rx.clone()).await;

    // An APNs key like Apple's .p8, and an FCM service account.
    let rng = ring::rand::SystemRandom::new();
    let p8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let apns_public = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, p8.as_ref(), &rng).unwrap().public_key().as_ref().to_vec();
    let apns = notify::Apns { key_pkcs8: p8.as_ref().to_vec(), key_id: "KEY123".into(), team_id: "TEAM456".into(), topic: "design.snds.mailbird".into(), url: services.clone(), sandbox_url: services.clone() };
    let rsa = rsa_key();
    let fcm = rsa.as_ref().map(|(pem, _)| notify::Fcm {
        project_id: "mailbird-test".into(),
        client_email: "relay@mailbird-test.iam.gserviceaccount.com".into(),
        key_pkcs8: crypto::pem_der(pem).unwrap(),
        token_uri: format!("{services}/fcm-token"),
        url: services.clone(),
    });

    // A 3-second push window (15 in production): long enough that a burst
    // reliably lands inside it, on the relay's whole-second clock.
    let relay = watch::Relay::with_debounce(store::Store::in_memory(), notify::Notifier::new(Some(apns), fcm), crypto::Sealer::new(&crypto::new_key()).unwrap(), 3);
    let base = serve(api::router(Arc::new(api::Api { relay: relay.clone(), token: TOKEN.into(), public_url: Some("https://relay.example.com/".into()) }))).await;
    let http = reqwest::Client::new();
    let call = |m: reqwest::Method, path: &str| http.request(m, format!("{base}{path}")).bearer_auth(TOKEN);

    // The token guards everything but health and Graph.
    assert_eq!(http.get(format!("{base}/healthz")).send().await.unwrap().text().await.unwrap(), "ok");
    assert_eq!(http.get(format!("{base}/v1/info")).send().await.unwrap().status(), 401);
    assert_eq!(http.get(format!("{base}/v1/info")).bearer_auth("wrong-token-wrong-token").send().await.unwrap().status(), 401);
    let info: Value = call(reqwest::Method::GET, "/v1/info").send().await.unwrap().json().await.unwrap();
    assert_eq!(info["targets"], json!({ "apns": true, "fcm": rsa.is_some(), "unifiedpush": true }));
    assert_eq!(info["outlook"], true);

    // A phone with a UnifiedPush endpoint (ntfy, for example).
    let phone = "phone-0001";
    let bad = call(reqwest::Method::PUT, &format!("/v1/devices/{phone}")).json(&json!({ "platform": "unifiedpush", "endpoint": "http://example.com/topic" })).send().await.unwrap();
    assert_eq!(bad.status(), 400, "plain http only to this machine");
    assert_eq!(call(reqwest::Method::PUT, "/v1/devices/x").json(&json!({ "platform": "unifiedpush", "endpoint": format!("{services}/up/a") })).send().await.unwrap().status(), 400, "ids are 8+ characters");
    let ok = call(reqwest::Method::PUT, &format!("/v1/devices/{phone}")).json(&json!({ "platform": "unifiedpush", "endpoint": format!("{services}/up/phone") })).send().await.unwrap();
    assert_eq!(ok.status(), 204);

    // Watching a JMAP mailbox: the first state is only recorded; the next one pushes.
    let j = Arc::new(Jmap { tx: tokio::sync::broadcast::channel(16).0, connections: Mutex::new(0) });
    let jmap = jmap_server(j.clone()).await;
    let watch = call(reqwest::Method::PUT, &format!("/v1/devices/{phone}/watches/acct-jmap-1")).json(&json!({ "kind": "jmap", "config": jmap_config(&jmap), "secret": "app-password" })).send().await.unwrap();
    assert_eq!(watch.status(), 200);
    assert_eq!(relay.watching(), 1);
    until("the relay to connect", || *j.connections.lock().unwrap() == 1).await;
    j.tx.send("s1".into()).unwrap();
    until("a reconnect after the first state", || *j.connections.lock().unwrap() == 2).await;
    assert!(pushes_to(&rx, "/up/phone").is_empty(), "the first state isn't a change");
    j.tx.send("s2".into()).unwrap();
    until("a push", || pushes_to(&rx, "/up/phone").len() == 1).await;
    let (_, h, body) = &pushes_to(&rx, "/up/phone")[0];
    assert_eq!(serde_json::from_str::<Value>(body).unwrap(), json!({ "account": "acct-jmap-1", "kind": "mail" }), "content-free: no address, no subject");
    assert_eq!(h.get("content-type").map(String::as_str), Some("application/json"));

    // Stored sealed, and never echoed back.
    let sealed = relay.store.read(|d| match &d[phone].watches["acct-jmap-1"].kind {
        store::WatchKind::Jmap { secret, .. } => secret.clone(),
        _ => unreachable!(),
    });
    assert!(sealed != "app-password" && relay.sealer.open(&sealed).unwrap() == "app-password");
    let dev: Value = call(reqwest::Method::GET, &format!("/v1/devices/{phone}")).send().await.unwrap().json().await.unwrap();
    assert!(!dev.to_string().contains("app-password") && !dev.to_string().contains("ana@example.com"), "{dev}");
    assert_eq!(dev["watches"]["acct-jmap-1"]["kind"], "jmap");
    assert!(dev["watches"]["acct-jmap-1"]["status"]["lastPush"].is_number());

    // A burst within the window becomes one trailing push.
    until("a reconnect", || *j.connections.lock().unwrap() == 3).await;
    j.tx.send("s3".into()).unwrap();
    until("a reconnect", || *j.connections.lock().unwrap() == 4).await;
    j.tx.send("s4".into()).unwrap();
    until("the trailing push", || pushes_to(&rx, "/up/phone").len() == 2).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(pushes_to(&rx, "/up/phone").len(), 2, "one push for the burst");

    // Wrong password: the watch reports it instead of pushing.
    let wrong = call(reqwest::Method::PUT, &format!("/v1/devices/{phone}/watches/acct-jmap-2")).json(&json!({ "kind": "jmap", "config": jmap_config(&jmap), "secret": "nope" })).send().await.unwrap();
    assert_eq!(wrong.status(), 200);
    until("the sign-in error", || relay.store.device(phone).unwrap().watches["acct-jmap-2"].status.error.as_deref().is_some_and(|e| e.contains("update the account"))).await;

    // Outlook: Graph validates the hook, then only notifications with our client state push.
    let g: Value = call(reqwest::Method::PUT, &format!("/v1/devices/{phone}/watches/acct-graph-1")).json(&json!({ "kind": "graph" })).send().await.unwrap().json().await.unwrap();
    let url = g["notificationUrl"].as_str().unwrap();
    assert!(url.starts_with("https://relay.example.com/graph/"), "{url}");
    let hook_path = url.trim_start_matches("https://relay.example.com");
    let again: Value = call(reqwest::Method::PUT, &format!("/v1/devices/{phone}/watches/acct-graph-1")).json(&json!({ "kind": "graph" })).send().await.unwrap().json().await.unwrap();
    assert_eq!(again, g, "re-registering keeps the hook, so the subscription stays valid");
    let v = http.post(format!("{base}{hook_path}?validationToken=Validation%3A+abc")).send().await.unwrap();
    assert_eq!((v.status().as_u16(), v.headers()["content-type"].to_str().unwrap().to_owned()), (200, "text/plain".to_string()));
    assert_eq!(v.text().await.unwrap(), "Validation: abc");
    let note = |state: &str| json!({ "value": [{ "subscriptionId": "s", "clientState": state, "changeType": "created", "resource": "Users/x/Messages/y" }] });
    assert_eq!(http.post(format!("{base}{hook_path}")).json(&note("forged")).send().await.unwrap().status(), 202);
    assert_eq!(http.post(format!("{base}/graph/not-a-hook")).json(&note("x")).send().await.unwrap().status(), 404);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!pushes_to(&rx, "/up/phone").iter().any(|(_, _, b)| b.contains("acct-graph-1")), "a forged notification pushes nothing");
    assert_eq!(http.post(format!("{base}{hook_path}")).json(&note(g["clientState"].as_str().unwrap())).send().await.unwrap().status(), 202);
    until("the Outlook push", || pushes_to(&rx, "/up/phone").iter().any(|(_, _, b)| b.contains("acct-graph-1"))).await;

    // An iPhone: a background push with a signed provider token.
    let iphone = "iphone-0001";
    assert_eq!(call(reqwest::Method::PUT, &format!("/v1/devices/{iphone}")).json(&json!({ "platform": "apns", "token": "abc123", "sandbox": true })).send().await.unwrap().status(), 204);
    assert_eq!(call(reqwest::Method::POST, &format!("/v1/devices/{iphone}/test")).send().await.unwrap().status(), 204);
    let (path, h, body) = pushes_to(&rx, "/3/device/").pop().unwrap();
    assert_eq!(path, "/3/device/abc123");
    assert_eq!((h["apns-topic"].as_str(), h["apns-push-type"].as_str(), h["apns-priority"].as_str()), ("design.snds.mailbird", "background", "5"));
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["aps"], json!({ "content-available": 1 }), "wakes the app; shows nothing by itself");
    let jwt = h["authorization"].strip_prefix("bearer ").unwrap();
    let (input, sig) = jwt.rsplit_once('.').unwrap();
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, &apns_public).verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(sig).unwrap()).expect("a valid ES256 signature");
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(input.split('.').next().unwrap()).unwrap()).unwrap();
    assert_eq!(header, json!({ "alg": "ES256", "kid": "KEY123" }));

    // A token APNs says is gone: the relay forgets the device.
    rx.lock().unwrap().dead.push("abc123".into());
    assert_eq!(call(reqwest::Method::POST, &format!("/v1/devices/{iphone}/test")).send().await.unwrap().status(), 502);
    assert!(relay.store.device(iphone).is_none());

    // An Android phone with FCM: a service-account token (RS256, cached), then a data message.
    if let Some((_, rsa_public)) = &rsa {
        let android = "android-0001";
        assert_eq!(call(reqwest::Method::PUT, &format!("/v1/devices/{android}")).json(&json!({ "platform": "fcm", "token": "fcm-reg-1" })).send().await.unwrap().status(), 204);
        for _ in 0..2 {
            assert_eq!(call(reqwest::Method::POST, &format!("/v1/devices/{android}/test")).send().await.unwrap().status(), 204);
        }
        assert_eq!(rx.lock().unwrap().fcm_tokens_issued, 1, "the access token is reused");
        let (_, _, form) = pushes_to(&rx, "/fcm-token").pop().unwrap();
        let assertion = form.rsplit_once("assertion=").unwrap().1;
        let (input, sig) = assertion.rsplit_once('.').unwrap();
        ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, rsa_public).verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(sig).unwrap()).expect("a valid RS256 signature");
        let (path, h, body) = pushes_to(&rx, "/v1/projects/").pop().unwrap();
        assert_eq!(path, "/v1/projects/mailbird-test/messages:send");
        assert_eq!(h["authorization"], "Bearer ya29.fake");
        let msg: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(msg["message"]["token"], "fcm-reg-1");
        assert_eq!(msg["message"]["data"], json!({ "account": "test", "kind": "test" }));
        assert!(msg["message"].get("notification").is_none(), "a data message: nothing shows by itself");
    }

    // Removing a watch stops its task; removing the device stops the rest.
    assert_eq!(call(reqwest::Method::DELETE, &format!("/v1/devices/{phone}/watches/acct-jmap-2")).send().await.unwrap().status(), 204);
    until("the task to stop", || relay.watching() == 1).await;
    assert_eq!(call(reqwest::Method::DELETE, &format!("/v1/devices/{phone}")).send().await.unwrap().status(), 204);
    until("every task to stop", || relay.watching() == 0).await;
    assert_eq!(call(reqwest::Method::GET, &format!("/v1/devices/{phone}")).send().await.unwrap().status(), 404);
}
