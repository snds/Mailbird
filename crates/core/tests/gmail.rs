//! Gmail adapter and OAuth token handling against a fake Gmail API and token
//! endpoint on 127.0.0.1. Runs offline, in the normal test suite.
//!
//! The fake keeps messages with labels and a history log, enforces bearer
//! tokens, and expires old history ids, so the test covers first sync,
//! history diffs (new, archived, read, starred, deleted, trashed), pushing
//! local changes, backfill paging, a history reset, send, and token refresh.

#![cfg(feature = "net")]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use pim_core::{
    AccountConfig, Draft, Error, Lane, MessageQuery, OAuthAccount, OAuthIssuer, Provider, Security, ServerConfig, Store,
    net::{gmail, oauth},
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct Fake {
    /// id → (raw, labels)
    messages: BTreeMap<String, (Vec<u8>, Vec<String>)>,
    history: Vec<(u64, Value)>,
    next_history: u64,
    /// History ids below this answer 404, as Gmail does after about a week.
    oldest_history: u64,
    access: String,
    refreshes: u32,
    sent: Vec<Vec<u8>>,
    next_id: u32,
}

impl Fake {
    fn record(&mut self, kind: &str, id: &str) {
        self.next_history += 1;
        let h = self.next_history;
        let labels = self.messages.get(id).map(|m| m.1.clone()).unwrap_or_default();
        self.history.push((h, json!({ "id": h.to_string(), kind: [{ "message": { "id": id, "labelIds": labels } }] })));
    }

    fn add(&mut self, subject: &str, labels: &[&str]) -> String {
        self.next_id += 1;
        let id = format!("m{:03}", self.next_id);
        let raw = format!("From: Ada <ada@example.com>\r\nTo: me@gmail.com\r\nSubject: {subject}\r\nMessage-ID: <{id}@example.com>\r\nDate: Tue, 13 Oct 2026 10:{:02}:00 +0000\r\n\r\nBody of {subject}\r\n", self.next_id % 60);
        self.messages.insert(id.clone(), (raw.into_bytes(), labels.iter().map(|s| s.to_string()).collect()));
        self.record("messagesAdded", &id);
        id
    }

    fn relabel(&mut self, id: &str, add: &[&str], remove: &[&str]) {
        let m = self.messages.get_mut(id).unwrap();
        m.1.retain(|l| !remove.contains(&l.as_str()));
        for a in add {
            if !m.1.iter().any(|l| l == a) {
                m.1.push(a.to_string());
            }
        }
        self.record(if add.is_empty() { "labelsRemoved" } else { "labelsAdded" }, id);
    }

    fn delete(&mut self, id: &str) {
        self.messages.remove(id);
        self.record("messagesDeleted", id);
    }

    /// Newest first, like Gmail.
    fn list(&self, label: Option<&str>, q: Option<&str>) -> Vec<String> {
        let mut ids: Vec<&String> = self
            .messages
            .iter()
            .filter(|(_, (_, l))| !l.iter().any(|x| x == "TRASH" || x == "SPAM"))
            .filter(|(_, (_, l))| label.is_none_or(|lb| l.iter().any(|x| x == lb)))
            .filter(|(_, (_, l))| q.is_none() || !l.iter().any(|x| x == "INBOX" || x == "SENT" || x == "DRAFT"))
            .map(|(id, _)| id)
            .collect();
        ids.reverse();
        ids.into_iter().cloned().collect()
    }
}

fn query(target: &str) -> (String, Vec<(String, String)>) {
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let decode = |s: &str| {
        let s = s.replace('+', " ");
        let mut out = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() + 1 {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    };
    let pairs = q.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).map(|(k, v)| (decode(k), decode(v))).collect();
    (path.to_owned(), pairs)
}

fn handle(fake: &mut Fake, method: &str, target: &str, auth: Option<&str>, body: &[u8]) -> (u16, Value) {
    let (path, q) = query(target);
    let param = |k: &str| q.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
    if path == "/token" {
        let form = String::from_utf8_lossy(body).to_string();
        let (_, f) = query(&format!("/?{form}"));
        let get = |k: &str| f.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone()).unwrap_or_default();
        return match get("grant_type").as_str() {
            "authorization_code" if get("code") == "good-code" && get("code_verifier").len() == 43 => {
                fake.access = "access-1".into();
                let id = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"email":"me@gmail.com","name":"Me Myself"}"#));
                (200, json!({ "access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3599, "id_token": id, "token_type": "Bearer" }))
            }
            "refresh_token" if get("refresh_token") == "refresh-1" => {
                fake.refreshes += 1;
                fake.access = format!("access-{}", fake.refreshes + 1);
                (200, json!({ "access_token": fake.access, "expires_in": 3599, "token_type": "Bearer" }))
            }
            _ => (400, json!({ "error": "invalid_grant" })),
        };
    }
    if auth != Some(&format!("Bearer {}", fake.access)) {
        return (401, json!({ "error": { "message": "Invalid Credentials" } }));
    }
    let path = path.strip_prefix("/gmail").unwrap_or(&path).to_owned();
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let body: Value = serde_json::from_slice(body).unwrap_or_default();
    match (method, segs.as_slice()) {
        ("GET", ["profile"]) => (200, json!({ "emailAddress": "me@gmail.com", "historyId": fake.next_history.to_string() })),
        ("GET", ["messages"]) => {
            let ids = fake.list(param("labelIds"), param("q"));
            let start: usize = param("pageToken").map(|p| p.parse().unwrap()).unwrap_or(0);
            let n: usize = param("maxResults").unwrap().parse().unwrap();
            let page: Vec<Value> = ids.iter().skip(start).take(n).map(|id| json!({ "id": id, "threadId": id })).collect();
            let mut v = json!({ "messages": page, "resultSizeEstimate": ids.len() });
            if start + n < ids.len() {
                v["nextPageToken"] = json!((start + n).to_string());
            }
            (200, v)
        }
        ("GET", ["messages", id]) => match fake.messages.get(*id) {
            None => (404, json!({ "error": { "message": "Not Found" } })),
            Some((raw, labels)) => {
                let mut v = json!({ "id": id, "threadId": id, "labelIds": labels });
                if param("format") == Some("raw") {
                    v["raw"] = json!(base64::engine::general_purpose::URL_SAFE.encode(raw));
                }
                (200, v)
            }
        },
        ("GET", ["history"]) => {
            let start: u64 = param("startHistoryId").unwrap().parse().unwrap();
            if start < fake.oldest_history {
                return (404, json!({ "error": { "message": "Requested entity was not found." } }));
            }
            let all: Vec<Value> = fake.history.iter().filter(|(h, _)| *h > start).map(|(_, v)| v.clone()).collect();
            // Two records per page, to exercise paging.
            let from: usize = param("pageToken").map(|p| p.parse().unwrap()).unwrap_or(0);
            let mut v = json!({ "history": all.iter().skip(from).take(2).collect::<Vec<_>>(), "historyId": fake.next_history.to_string() });
            if from + 2 < all.len() {
                v["nextPageToken"] = json!((from + 2).to_string());
            }
            (200, v)
        }
        ("POST", ["messages", "batchModify"]) => {
            let ids: Vec<String> = body["ids"].as_array().unwrap().iter().map(|i| i.as_str().unwrap().to_owned()).collect();
            if ids.iter().any(|i| !fake.messages.contains_key(i)) {
                return (400, json!({ "error": { "message": "Invalid id" } }));
            }
            let labels = |k: &str| body[k].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_owned()).collect::<Vec<_>>()).unwrap_or_default();
            let (add, remove) = (labels("addLabelIds"), labels("removeLabelIds"));
            for id in ids {
                fake.relabel(&id, &add.iter().map(String::as_str).collect::<Vec<_>>(), &remove.iter().map(String::as_str).collect::<Vec<_>>());
            }
            (204, Value::Null)
        }
        ("POST", ["messages", id, "modify"]) => {
            if !fake.messages.contains_key(*id) {
                return (404, json!({ "error": { "message": "Not Found" } }));
            }
            let labels = |k: &str| body[k].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_owned()).collect::<Vec<_>>()).unwrap_or_default();
            let (add, remove) = (labels("addLabelIds"), labels("removeLabelIds"));
            let id = id.to_string();
            fake.relabel(&id, &add.iter().map(String::as_str).collect::<Vec<_>>(), &remove.iter().map(String::as_str).collect::<Vec<_>>());
            (200, json!({ "id": id }))
        }
        ("POST", ["messages", "send"]) => {
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body["raw"].as_str().unwrap()).unwrap();
            fake.sent.push(raw.clone());
            fake.next_id += 1;
            let id = format!("m{:03}", fake.next_id);
            fake.messages.insert(id.clone(), (raw, vec!["SENT".into()]));
            fake.record("messagesAdded", &id);
            (200, json!({ "id": id, "labelIds": ["SENT"] }))
        }
        _ => (404, json!({ "error": { "message": format!("no route {method} {path}") } })),
    }
}

/// Serves `fake` over HTTP/1.1 on a free port; returns its base URL.
async fn serve(fake: Arc<Mutex<Fake>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let fake = fake.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    // Read one request (headers, then Content-Length bytes); keep-alive.
                    let head_end = loop {
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i;
                        }
                        let mut chunk = [0u8; 8192];
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let (method, target) = (first.next().unwrap().to_owned(), first.next().unwrap().to_owned());
                    let mut len = 0;
                    let mut auth = None;
                    for l in lines {
                        let (k, v) = l.split_once(':').unwrap();
                        match k.to_ascii_lowercase().as_str() {
                            "content-length" => len = v.trim().parse().unwrap(),
                            "authorization" => auth = Some(v.trim().to_owned()),
                            _ => {}
                        }
                    }
                    while buf.len() < head_end + 4 + len {
                        let mut chunk = [0u8; 8192];
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let body = buf[head_end + 4..head_end + 4 + len].to_vec();
                    buf.drain(..head_end + 4 + len);
                    let (status, v) = handle(&mut fake.lock().unwrap(), &method, &target, auth.as_deref(), &body);
                    let text = if v.is_null() { String::new() } else { v.to_string() };
                    let reply = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
                    if sock.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    base
}

fn config(base: &str) -> AccountConfig {
    let gmail = ServerConfig { host: "imap.gmail.com".into(), port: 993, security: Security::Tls };
    AccountConfig {
        display_name: "Me".into(),
        address: "me@gmail.com".into(),
        username: "me@gmail.com".into(),
        provider: Provider::Google,
        imap: gmail.clone(),
        smtp: ServerConfig { host: "smtp.gmail.com".into(), port: 465, ..gmail },
        jmap: None,
        dav: None,
        oauth: Some(OAuthAccount { issuer: OAuthIssuer::Google, client_id: "test-client".into(), api_base: Some(format!("{base}/gmail")), token_url: Some(format!("{base}/token")) }),
    }
}

async fn sync(store: &Store, account: &str, cfg: &AccountConfig, token: &str) -> pim_core::RemoteBatch {
    let cursor = store.remote_cursor(account).unwrap();
    let ops = store.pending_remote_ops(account).unwrap();
    let batch = gmail::sync_account(cfg, token, cursor, &ops).await.unwrap();
    store.apply_remote(account, &batch).unwrap();
    batch
}

fn subjects(store: &Store, lane: Lane) -> Vec<String> {
    let mut s: Vec<String> = store.messages(&MessageQuery { lane, account_id: None, search: None, limit: None, offset: None, category: None }).unwrap().into_iter().map(|m| m.subject).collect();
    s.sort();
    s
}

#[tokio::test]
async fn gmail_end_to_end() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let fake = Arc::new(Mutex::new(Fake::default()));
    let base = serve(fake.clone()).await;
    let cfg = config(&base);

    // Sign-in: code → tokens + identity; then a refresh.
    let ep = oauth::Endpoints { authorize: format!("{base}/auth"), token: format!("{base}/token") };
    let client = oauth::Client { client_id: "test-client".into(), client_secret: Some("not-secret".into()) };
    let (verifier, _) = oauth::pkce();
    assert!(oauth::exchange(&ep, &client, "bad-code", &verifier, "http://127.0.0.1:1").await.is_err());
    let (tokens, who) = oauth::exchange(&ep, &client, "good-code", &verifier, "http://127.0.0.1:1").await.unwrap();
    assert_eq!((tokens.refresh_token.as_str(), who.email.as_deref(), who.name.as_deref()), ("refresh-1", Some("me@gmail.com"), Some("Me Myself")));
    assert!(tokens.fresh());
    assert_eq!(gmail::verify(&cfg, &tokens.access_token).await.unwrap(), "me@gmail.com");
    let refreshed = oauth::refresh(&ep.token, &client, &tokens).await.unwrap();
    assert_eq!((refreshed.access_token.as_str(), refreshed.refresh_token.as_str()), ("access-2", "refresh-1"), "the refresh token is kept when not rotated");
    assert!(matches!(gmail::verify(&cfg, &tokens.access_token).await, Err(Error::Auth(_))), "the old access token no longer works");
    let revoked = oauth::TokenSet { refresh_token: "revoked".into(), ..refreshed.clone() };
    assert!(matches!(oauth::refresh(&ep.token, &client, &revoked).await, Err(Error::Auth(m)) if m.contains("sign in again")));
    let token = refreshed.access_token;

    // Mail on the server before the first sync.
    let (welcome, receipt, report, _draft) = {
        let mut f = fake.lock().unwrap();
        let w = f.add("Welcome", &["INBOX", "UNREAD"]);
        let r = f.add("Receipt", &["CATEGORY_UPDATES"]);
        let p = f.add("Quarterly report", &["INBOX", "STARRED"]);
        let d = f.add("Unsent draft", &["DRAFT"]);
        f.add("Spam offer", &["SPAM"]);
        f.add("My reply", &["SENT"]);
        (w, r, p, d)
    };

    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&cfg).unwrap().id;
    let b = sync(&store, &account, &cfg, &token).await;
    assert_eq!(b.new_messages.len(), 4, "inbox, archive, and sent; drafts and spam stay out");
    assert_eq!(subjects(&store, Lane::Inbox), ["Quarterly report", "Welcome"]);
    assert_eq!(subjects(&store, Lane::Archive), ["Receipt"]);
    assert_eq!(subjects(&store, Lane::Unread), ["Welcome"]);
    assert_eq!(subjects(&store, Lane::Starred), ["Quarterly report"]);
    let resumed = gmail::State::parse(Some(&b.state)).unwrap();
    assert!(!b.more_older && resumed.pages.values().all(String::is_empty));

    // Quiet: nothing changes.
    let b = sync(&store, &account, &cfg, &token).await;
    assert!(b.new_messages.is_empty() && b.flags.is_empty() && b.moved.is_empty() && b.removed.is_empty());

    // Changes made elsewhere: new mail, archived, read, deleted, trashed.
    {
        let mut f = fake.lock().unwrap();
        f.add("Fresh news", &["INBOX", "UNREAD"]);
        f.relabel(&welcome, &[], &["UNREAD"]);
        f.relabel(&report, &[], &["INBOX"]);
        f.delete(&receipt);
        let t = f.add("Short-lived", &["INBOX"]);
        f.relabel(&t, &["TRASH"], &[]);
    }
    let b = sync(&store, &account, &cfg, &token).await;
    assert_eq!(subjects(&store, Lane::Inbox), ["Fresh news", "Welcome"]);
    assert_eq!(subjects(&store, Lane::Archive), ["Quarterly report"], "archived elsewhere; the deleted receipt is gone");
    assert_eq!(subjects(&store, Lane::Unread), ["Fresh news"]);
    assert_eq!(b.new_messages.len(), 1, "trashed mail never arrives");

    // Local changes reach Gmail as label changes.
    let row = |s: &str| store.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: None, offset: None, category: None }).unwrap().into_iter().find(|m| m.subject == s).unwrap();
    store.set_thread_seen(&row("Fresh news").thread_id, true).unwrap();
    store.set_thread_flagged(&row("Welcome").thread_id, true).unwrap();
    store.set_thread_archived(&row("Welcome").thread_id, true).unwrap();
    let b = sync(&store, &account, &cfg, &token).await;
    assert_eq!(b.applied_ops.len(), 3);
    assert!(store.pending_remote_ops(&account).unwrap().is_empty());
    {
        let f = fake.lock().unwrap();
        let labels = |s: &str| f.messages.values().find(|(r, _)| String::from_utf8_lossy(r).contains(&format!("Subject: {s}"))).unwrap().1.clone();
        assert!(!labels("Fresh news").contains(&"UNREAD".to_string()));
        assert!(labels("Welcome").contains(&"STARRED".to_string()) && !labels("Welcome").contains(&"INBOX".to_string()));
    }
    assert_eq!(subjects(&store, Lane::Inbox), ["Fresh news"]);
    assert_eq!(subjects(&store, Lane::Starred), ["Quarterly report", "Welcome"], "our own changes come back through history consistently");

    // A change to a message deleted meanwhile is dropped, not fatal.
    let gone = row("Fresh news");
    fake.lock().unwrap().delete(&store.remote_cursor(&account).unwrap().known.iter().find(|(_, m)| m.as_str() == "INBOX").unwrap().0.clone());
    store.set_thread_flagged(&gone.thread_id, true).unwrap();
    sync(&store, &account, &cfg, &token).await;
    assert!(subjects(&store, Lane::Inbox).is_empty());

    // Send a reply: Gmail files the Sent copy; it joins the thread once.
    let draft = Draft {
        account_id: account.clone(),
        to: vec![pim_core::Address { name: Some("Ada".into()), email: "ada@example.com".into() }],
        cc: vec![],
        subject: "Re: Welcome".into(),
        body: "Thanks!".into(),
        body_html: None,
        in_reply_to: Some(format!("<{welcome}@example.com>")),
        references: vec![format!("<{welcome}@example.com>")],
        attachments: vec![],
        calendar: None,
        follow_up_after: None,
    };
    let raw = gmail::send(&cfg, &token, &draft).await.unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("Subject: Re: Welcome"));
    assert_eq!(fake.lock().unwrap().sent.len(), 1);
    store.insert_local(&account, pim_core::store::SENT, &raw, true).unwrap();
    sync(&store, &account, &cfg, &token).await;
    let welcome_row = store.messages(&MessageQuery { lane: Lane::Starred, account_id: None, search: None, limit: None, offset: None, category: None }).unwrap().into_iter().find(|m| m.subject.ends_with("Welcome")).unwrap();
    let thread = store.thread(&welcome_row.thread_id).unwrap();
    let sent: Vec<_> = thread.iter().filter(|m| m.summary.mailbox == pim_core::store::SENT).collect();
    assert_eq!(sent.len(), 1, "one Sent copy in the conversation, not two");
    assert!(store.remote_cursor(&account).unwrap().known.values().any(|m| m == pim_core::store::SENT), "the server's copy");

    // Backfill: a big inbox pages in chunks.
    {
        let mut f = fake.lock().unwrap();
        for i in 0..(pim_core::net::BACKFILL_CHUNK + 20) {
            f.add(&format!("Bulk {i:03}"), &["Label_9"]);
        }
    }
    let b = sync(&store, &account, &cfg, &token).await;
    assert!(b.new_messages.len() > pim_core::net::BACKFILL_CHUNK, "history brings all of them");

    // History expires: the next pass starts over without duplicates.
    {
        let mut f = fake.lock().unwrap();
        f.oldest_history = f.next_history + 1;
        f.add("After reset", &["INBOX"]);
    }
    let before = store.remote_cursor(&account).unwrap().known.len();
    let b = sync(&store, &account, &cfg, &token).await;
    assert!(b.reset);
    let mut passes = 0;
    while store.remote_cursor(&account).unwrap().known.len() < before && passes < 5 {
        sync(&store, &account, &cfg, &token).await;
        passes += 1;
    }
    assert_eq!(store.remote_cursor(&account).unwrap().known.len(), before + 1, "after a reset and backfill, everything is back exactly once");
    assert!(subjects(&store, Lane::Inbox).contains(&"After reset".to_string()));

    // Polling notices a change.
    let state = store.remote_cursor(&account).unwrap().state;
    let quiet = gmail::wait_for_change(&cfg, &token, state.as_deref(), std::time::Duration::from_millis(10)).await.unwrap();
    assert!(matches!(quiet, pim_core::net::Change::Quiet));
    fake.lock().unwrap().add("Ping", &["INBOX"]);
    let changed = gmail::wait_for_change(&cfg, &token, state.as_deref(), std::time::Duration::from_millis(10)).await.unwrap();
    assert!(matches!(changed, pim_core::net::Change::Changed));
}
