//! A shared inbox on the gateway (ADR-0063): the owner invites someone, they
//! choose a password and sign in, reach mail and nothing else, and act as
//! themselves on assignments and notes, whatever their page claims.

use std::time::Duration;

use futures::StreamExt;
use mailbird_gateway::{Config, Gateway, Members, SealedFile, router};
use serde_json::{Value, json};

const PASSWORD: &str = "gateway-password-for-tests";

#[tokio::test]
async fn a_team_shares_the_inbox() {
    use base64::Engine;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = std::env::temp_dir().join(format!("gateway-team-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let web = dir.join("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><html><head></head></html>").unwrap();
    pim_app::secrets::install(Box::new(SealedFile::open(dir.join("secrets.json"), &base64::engine::general_purpose::STANDARD.encode([7u8; 32])).unwrap()));
    let state = pim_app::AppState::open(&dir.join("data")).unwrap();
    // One conversation in the shared mailbox.
    let thread_id = {
        use pim_core::*;
        let s = state.store.lock().unwrap();
        let server = ServerConfig { host: "localhost".into(), port: 143, security: Security::Plain };
        let a = s.add_account(&AccountConfig { display_name: "Support".into(), address: "help@example.com".into(), username: "help".into(), provider: Provider::Generic, imap: server.clone(), smtp: ServerConfig { port: 25, ..server }, jmap: None, dav: None, oauth: None }).unwrap();
        let raw = b"From: Kim <kim@example.org>\r\nTo: help@example.com\r\nSubject: Refund for order 42\r\nMessage-ID: <r1@x>\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nIt arrived broken.\r\n".to_vec();
        s.apply_sync(&a.id, &SyncBatch { mailbox: "INBOX".into(), uid_validity: 1, new_messages: vec![FetchedMessage { uid: 1, seen: false, flagged: false, raw }], server_uids: vec![1], ..Default::default() }).unwrap();
        s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false, assigned_to: None }).unwrap()[0].thread_id.clone()
    };
    let gw = Gateway::new(state, Config { password: PASSWORD.into(), members: Members::open(dir.join("members.json")).unwrap(), web_dir: web, secure_cookies: false, public_url: None });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, router(gw)).await.unwrap() });

    let client = || reqwest::Client::builder().cookie_store(true).build().unwrap();
    let (owner, ana, stranger) = (client(), client(), client());
    let post = |c: &reqwest::Client, path: &str, body: Value| c.post(format!("{base}{path}")).header("X-Mailbird", "1").json(&body).send();
    let core = |c: &reqwest::Client, name: &str, args: Value| c.post(format!("{base}/api/core/{name}")).header("X-Mailbird", "1").json(&args).send();

    assert_eq!(post(&owner, "/api/session", json!({ "password": PASSWORD })).await.unwrap().status(), 204);
    let me: Value = owner.get(format!("{base}/api/session")).send().await.unwrap().json().await.unwrap();
    assert_eq!(me["me"], json!({ "id": "owner", "name": "Support", "role": "owner" }), "the owner is named as their first account");

    // The owner invites Ana; a member can't invite anyone.
    let added: Value = post(&owner, "/api/members", json!({ "name": "Ana", "email": "ana@example.com" })).await.unwrap().json().await.unwrap();
    let (ana_id, code) = (added["member"]["id"].as_str().unwrap().to_owned(), added["code"].as_str().unwrap().to_owned());
    assert_eq!(added["member"]["pending"], true);
    assert_eq!(post(&stranger, "/api/join", json!({ "code": "not-the-code", "password": "a long enough password" })).await.unwrap().status(), 400);
    assert_eq!(post(&ana, "/api/join", json!({ "code": code, "password": "a long enough password" })).await.unwrap().status(), 204, "the invitation signs her in");
    let me: Value = ana.get(format!("{base}/api/session")).send().await.unwrap().json().await.unwrap();
    assert_eq!(me["me"], json!({ "id": ana_id, "name": "Ana", "role": "member" }));
    assert_eq!(post(&stranger, "/api/join", json!({ "code": code, "password": "a long enough password" })).await.unwrap().status(), 400, "an invitation works once");
    assert_eq!(post(&ana, "/api/members", json!({ "name": "Eve", "email": "eve@example.com" })).await.unwrap().status(), 403);
    // Signing in again: email and her password; the wrong one is refused.
    let ana2 = client();
    assert_eq!(post(&ana2, "/api/session", json!({ "email": "ana@example.com", "password": "nope nope nope" })).await.unwrap().status(), 401);
    assert_eq!(post(&ana2, "/api/session", json!({ "email": " Ana@Example.com ", "password": "a long enough password" })).await.unwrap().status(), 204);

    // Mail, yes; the owner's accounts, notes, and settings, no.
    assert_eq!(core(&ana, "list_messages", json!({ "query": { "lane": "inbox" } })).await.unwrap().status(), 200);
    for name in ["add_account", "remove_account", "get_notes_relay", "list_notes", "set_ai_key", "list_occurrences"] {
        assert_eq!(core(&ana, name, json!({})).await.unwrap().status(), 403, "{name}");
    }

    // She sees the team (names only) and assigns herself; the page can't say it was someone else.
    let team: Value = ana.get(format!("{base}/api/members")).send().await.unwrap().json().await.unwrap();
    assert_eq!(team, json!([{ "id": "owner", "name": "Support", "role": "owner" }, { "id": ana_id, "name": "Ana", "role": "member" }]));
    let mut events = owner.get(format!("{base}/api/events")).send().await.unwrap().bytes_stream();
    let t: Value = core(&ana, "assign_thread", json!({ "threadId": thread_id, "to": { "id": ana_id, "name": "Boss" }, "by": { "id": "owner", "name": "Support" } })).await.unwrap().json().await.unwrap();
    assert_eq!((t["assignee"]["name"].as_str(), t["assignee"]["by"].as_str()), (Some("Ana"), Some("Ana")), "names come from the team, not the page");
    assert_eq!(core(&ana, "assign_thread", json!({ "threadId": thread_id, "to": { "id": "nobody" } })).await.unwrap().status(), 400);
    let mine: Value = core(&ana, "list_messages", json!({ "query": { "lane": "inbox", "assignedTo": ana_id } })).await.unwrap().json().await.unwrap();
    assert_eq!(mine.as_array().unwrap().len(), 1, "Assigned to me");
    let note: Value = core(&ana, "add_thread_comment", json!({ "threadId": thread_id, "text": "Refund approved?", "by": { "id": "owner", "name": "Support" } })).await.unwrap().json().await.unwrap();
    assert_eq!(note["comments"][0]["author"], "Ana");
    let mut seen = String::new();
    while !seen.contains("inbox-team:changed") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), events.next()).await.expect("an event").unwrap().unwrap();
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }
    // The owner's note is theirs: she can't delete it, they can delete hers.
    let theirs: Value = core(&owner, "add_thread_comment", json!({ "threadId": thread_id, "text": "Yes" })).await.unwrap().json().await.unwrap();
    let their_id = theirs["comments"][1]["id"].as_str().unwrap();
    assert_eq!(core(&ana, "remove_thread_comment", json!({ "id": their_id, "owner": true })).await.unwrap().status(), 400);
    assert_eq!(core(&owner, "remove_thread_comment", json!({ "id": theirs["comments"][0]["id"] })).await.unwrap().status(), 200);

    // Who's here: she opens the conversation and everyone hears it.
    assert_eq!(post(&ana, "/api/here", json!({ "threadId": thread_id })).await.unwrap().status(), 204);
    let mut seen = String::new();
    while !(seen.contains("inbox:here") && seen.contains("\"Ana\"")) {
        let chunk = tokio::time::timeout(Duration::from_secs(5), events.next()).await.expect("who's here").unwrap().unwrap();
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }

    // Removed: signed out everywhere, and her conversation goes back to nobody.
    assert_eq!(owner.delete(format!("{base}/api/members/{ana_id}")).header("X-Mailbird", "1").send().await.unwrap().status(), 204);
    assert_eq!(core(&ana, "list_messages", json!({ "query": { "lane": "inbox" } })).await.unwrap().status(), 401);
    assert_eq!(core(&ana2, "list_messages", json!({ "query": { "lane": "inbox" } })).await.unwrap().status(), 401);
    let t: Value = core(&owner, "thread_team", json!({ "threadId": thread_id })).await.unwrap().json().await.unwrap();
    assert_eq!(t["assignee"], Value::Null);
    let text = std::fs::read_to_string(dir.join("members.json")).unwrap();
    assert!(!text.contains("a long enough password"));
}
