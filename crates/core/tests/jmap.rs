//! End-to-end JMAP test against a real server (Stalwart): sync, pushing
//! local changes, archive, changes made elsewhere, and send.
//!
//! Ignored by default. `tools/test-mail-servers/start-jmap.sh` starts what it
//! expects (Stalwart on 127.0.0.1:8080, user `tester@localhost.test` /
//! `tester-secret-1`); then run
//! `cargo test -p pim-core --test jmap -- --ignored`.

#![cfg(feature = "net")]

use base64::Engine;
use pim_core::{
    AccountConfig, Address, Draft, Error, JmapConfig, Lane, MessageQuery, Provider, Security, ServerConfig, Store,
    net::{self, jmap},
};
use serde_json::{Value, json};

const URL: &str = "http://127.0.0.1:8080/jmap/session";
const USER: &str = "tester@localhost.test";
const PASS: &str = "tester-secret-1";

fn config() -> AccountConfig {
    let unused = ServerConfig { host: String::new(), port: 0, security: Security::Tls };
    AccountConfig {
        display_name: "Test User".into(),
        address: "tester@localhost.test".into(),
        username: USER.into(),
        provider: Provider::Jmap,
        imap: unused.clone(),
        smtp: unused,
        jmap: Some(JmapConfig { session_url: URL.into(), bearer: false }),
        dav: None,
        oauth: None,
    }
}

/// A raw JMAP client for arranging server state and checking results.
struct Admin {
    http: reqwest::Client,
    auth: String,
    account: String,
}

impl Admin {
    async fn new() -> Self {
        // The app hands reqwest its own TLS config; this test client needs a provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::new();
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{PASS}")));
        let s: Value = http.get(URL).header("Authorization", &auth).send().await.unwrap().json().await.unwrap();
        let account = s["primaryAccounts"]["urn:ietf:params:jmap:mail"].as_str().unwrap().to_owned();
        Self { http, auth, account }
    }

    async fn call(&self, method: &str, mut args: Value) -> Value {
        args["accountId"] = json!(self.account);
        let body = json!({
            "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
            "methodCalls": [[method, args, "0"]],
        });
        let r: Value = self
            .http
            .post("http://127.0.0.1:8080/jmap/")
            .header("Authorization", &self.auth)
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        r["methodResponses"][0][1].clone()
    }

    async fn mailbox(&self, role: &str) -> Option<String> {
        let v = self.call("Mailbox/get", json!({ "properties": ["id", "role"] })).await;
        v["list"].as_array()?.iter().find(|m| m["role"] == role).map(|m| m["id"].as_str().unwrap().to_owned())
    }

    async fn ensure_archive(&self) -> String {
        if let Some(id) = self.mailbox("archive").await {
            return id;
        }
        let v = self.call("Mailbox/set", json!({ "create": { "a": { "name": "Archive", "role": "archive" } } })).await;
        v["created"]["a"]["id"].as_str().expect("created Archive").to_owned()
    }

    async fn clear(&self) {
        let ids = self.call("Email/query", json!({ "limit": 1000 })).await["ids"].clone();
        if ids.as_array().is_some_and(|a| !a.is_empty()) {
            self.call("Email/set", json!({ "destroy": ids })).await;
        }
    }

    async fn import(&self, subject: &str, keywords: Value) -> String {
        let raw = format!(
            "From: Ana Duarte <ana@example.com>\r\nTo: tester@localhost.test\r\nSubject: {subject}\r\n\
             Message-ID: <{}@example.com>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nBody of {subject}\r\n",
            subject.replace(' ', "-")
        );
        let up: Value = self
            .http
            .post(format!("http://127.0.0.1:8080/jmap/upload/{}/", self.account))
            .header("Authorization", &self.auth)
            .body(raw)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let inbox = self.mailbox("inbox").await.unwrap();
        let v = self
            .call("Email/import", json!({ "emails": { "e": { "blobId": up["blobId"], "mailboxIds": { inbox: true }, "keywords": keywords } } }))
            .await;
        v["created"]["e"]["id"].as_str().unwrap_or_else(|| panic!("import failed: {v}")).to_owned()
    }

    /// (subject, keywords, mailbox ids) for every email.
    async fn emails(&self) -> Vec<(String, Value, Value)> {
        let ids = self.call("Email/query", json!({ "limit": 1000 })).await["ids"].clone();
        let v = self.call("Email/get", json!({ "ids": ids, "properties": ["subject", "keywords", "mailboxIds"] })).await;
        v["list"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["subject"].as_str().unwrap_or("").to_owned(), e["keywords"].clone(), e["mailboxIds"].clone()))
            .collect()
    }
}

async fn sync(store: &Store, account: &str) -> pim_core::RemoteBatch {
    let cursor = store.remote_cursor(account).unwrap();
    let ops = store.pending_remote_ops(account).unwrap();
    let batch = jmap::sync_account(&config(), PASS, cursor, &ops).await.unwrap();
    store.apply_remote(account, &batch).unwrap();
    batch
}

fn inbox(store: &Store) -> Vec<pim_core::MessageSummary> {
    store.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap()
}

#[tokio::test]
#[ignore = "needs tools/test-mail-servers/start-jmap.sh running"]
async fn jmap_round_trip() {
    let admin = Admin::new().await;
    admin.clear().await;
    let archive = admin.ensure_archive().await;
    let inbox_id = admin.mailbox("inbox").await.unwrap();
    admin.import("First note", json!({})).await;
    admin.import("Second note", json!({ "$seen": true })).await;
    let third = admin.import("Third note", json!({})).await;

    jmap::verify(&config(), PASS).await.unwrap();
    assert!(matches!(jmap::verify(&config(), "wrong").await, Err(Error::Auth(_))));

    // Initial sync
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap().id;
    let first = sync(&store, &account).await;
    assert_eq!(first.new_messages.len(), 3);
    assert!(!first.state.is_empty(), "resume state recorded");
    let rows = inbox(&store);
    let by = |s: &str| rows.iter().find(|m| m.subject == s).unwrap().clone();
    assert!(by("Second note").seen, "$seen comes down");

    // Local changes go up
    store.set_thread_seen(&by("First note").thread_id, true).unwrap();
    store.set_thread_flagged(&by("Second note").thread_id, true).unwrap();
    store.set_thread_archived(&by("Third note").thread_id, true).unwrap();
    let pushed = sync(&store, &account).await;
    assert_eq!(pushed.applied_ops.len(), 3);
    assert!(store.pending_remote_ops(&account).unwrap().is_empty());
    let server = admin.emails().await;
    let find = |s: &str| server.iter().find(|(subj, _, _)| subj == s).unwrap().clone();
    assert_eq!(find("First note").1["$seen"], true);
    assert_eq!(find("Second note").1["$flagged"], true);
    let third_boxes = find("Third note").2;
    assert_eq!(third_boxes[&archive], true, "archive moves it to the Archive mailbox");
    assert!(third_boxes.get(&inbox_id).is_none());
    assert!(pushed.moved.contains(&(third.clone(), pim_core::store::ARCHIVE.to_owned())), "the move comes back as a move, not a re-download");
    let archived = store.messages(&MessageQuery { lane: Lane::Archive, account_id: None, search: None, limit: None, offset: None, category: None, split: None, bundle: false }).unwrap();
    assert_eq!((archived.len(), archived[0].mailbox.as_str()), (1, pim_core::store::ARCHIVE));

    // Unarchive moves it back on the server.
    store.set_thread_archived(&archived[0].thread_id, false).unwrap();
    sync(&store, &account).await;
    let back = admin.emails().await;
    assert_eq!(back.iter().find(|(s, _, _)| s == "Third note").unwrap().2[&inbox_id], true, "unarchive moved it back to the Inbox");
    assert_eq!(inbox(&store).len(), 3);
    // …and archive it again so the counts below match.
    let t = inbox(&store).into_iter().find(|m| m.subject == "Third note").unwrap().thread_id;
    store.set_thread_archived(&t, true).unwrap();
    sync(&store, &account).await;

    // Push: EventSource wakes on a change, not on the state we already have.
    let state = store.remote_cursor(&account).unwrap().state;
    let waiter = tokio::spawn({
        let state = state.clone();
        async move { jmap::wait_for_change(&config(), PASS, state.as_deref(), std::time::Duration::from_secs(20)).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let pushed_mail = admin.import("Pushed note", json!({})).await;
    let change = tokio::time::timeout(std::time::Duration::from_secs(15), waiter).await.expect("push arrived").unwrap().unwrap();
    assert_eq!(change, net::Change::Changed);
    assert_eq!(sync(&store, &account).await.new_messages.len(), 1);
    admin.call("Email/set", json!({ "destroy": [pushed_mail] })).await;
    sync(&store, &account).await;

    // Changes made elsewhere arrive through Email/changes
    let fourth = admin.import("Fourth note", json!({})).await;
    let ids = admin.call("Email/query", json!({ "filter": { "inMailbox": inbox_id } })).await["ids"].clone();
    let mut patch = serde_json::Map::new();
    for id in ids.as_array().unwrap() {
        patch.insert(id.as_str().unwrap().to_owned(), json!({ "keywords/$seen": true }));
    }
    admin.call("Email/set", json!({ "update": patch })).await;
    let changed = sync(&store, &account).await;
    assert_eq!(changed.new_messages.len(), 1, "only the new mail is downloaded");
    assert!(inbox(&store).iter().all(|m| m.seen), "flags set elsewhere are picked up");

    admin.call("Email/set", json!({ "destroy": [fourth] })).await;
    let destroyed = sync(&store, &account).await;
    assert_eq!(destroyed.removed, vec![fourth.clone()]);
    assert_eq!(inbox(&store).len(), 2);

    // Send: stored in Sent and submitted
    let draft = Draft {
        account_id: account.clone(),
        to: vec![Address { name: Some("Ana".into()), email: "ana@example.com".into() }],
        cc: vec![],
        subject: "Re: First note".into(),
        body: "Thanks!".into(),
        body_html: Some("<p><em>Thanks!</em></p>".into()),
        in_reply_to: Some("First-note@example.com".into()),
        references: vec![],
        attachments: vec![],
        calendar: None,
        follow_up_after: None,
        request_receipt: false,
    };
    match jmap::send(&config(), PASS, &draft).await {
        Ok(raw) => {
            assert!(String::from_utf8_lossy(&raw).contains("In-Reply-To: <First-note@example.com>"));
            let sent = admin.mailbox("sent").await.unwrap();
            assert!(admin.emails().await.iter().any(|(s, _, boxes)| s == "Re: First note" && boxes[&sent] == true), "filed in Sent");
            let subs = admin.call("EmailSubmission/query", json!({})).await;
            assert!(subs["ids"].as_array().is_some_and(|a| !a.is_empty()), "an EmailSubmission was created");

            // The shell keeps a local Sent copy; the synced server copy replaces it and joins the thread.
            store.insert_local(&account, pim_core::store::SENT, &raw, true).unwrap();
            sync(&store, &account).await;
            let first = inbox(&store).into_iter().find(|m| m.subject == "First note").unwrap();
            let thread = store.thread(&first.thread_id).unwrap();
            let sent_copies: Vec<_> = thread.iter().filter(|m| m.summary.mailbox == pim_core::store::SENT).collect();
            assert_eq!(sent_copies.len(), 1, "one Sent copy in the conversation, not two");
            assert!(sent_copies[0].body_html.as_deref().is_some_and(|h| h.contains("<em>Thanks!</em>")), "the server copy keeps the rich body");
            assert!(store.remote_cursor(&account).unwrap().known.values().any(|m| m == pim_core::store::SENT), "it's the server's copy");
        }
        // A server whose test account has no identity must say so plainly.
        Err(Error::Invalid(m)) if m.contains("sending identity") => eprintln!("send skipped: {m}"),
        Err(e) => panic!("send failed: {e}"),
    }
}
