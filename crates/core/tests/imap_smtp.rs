//! End-to-end test against real servers: IMAP sync, pushing local changes,
//! archive, and SMTP send with a Sent copy.
//!
//! Ignored by default because it needs servers. `tools/test-mail-servers/start.sh`
//! starts what it expects (Dovecot on 127.0.0.1:1143, an SMTP sink on :2525,
//! user `tester` / `secret`); then run
//! `cargo test -p pim-core --test imap_smtp -- --ignored`.

#![cfg(feature = "net")]

use futures::TryStreamExt;
use pim_core::{
    AccountConfig, Address, Draft, Error, Lane, MessageQuery, Provider, Security, ServerConfig, Store, net,
};
use tokio::net::TcpStream;

const USER: &str = "tester";
const PASS: &str = "secret";

fn config() -> AccountConfig {
    AccountConfig {
        display_name: "Test User".into(),
        address: "tester@localhost.test".into(),
        username: USER.into(),
        provider: Provider::Generic,
        imap: ServerConfig { host: "127.0.0.1".into(), port: 1143, security: Security::Plain },
        smtp: ServerConfig { host: "127.0.0.1".into(), port: 2525, security: Security::Plain },
    }
}

/// A raw session for arranging server state and checking results.
async fn raw_session() -> async_imap::Session<TcpStream> {
    let tcp = TcpStream::connect(("127.0.0.1", 1143)).await.unwrap();
    let mut client = async_imap::Client::new(tcp);
    client.read_response().await.unwrap();
    client.login(USER, PASS).await.map_err(|(e, _)| e).unwrap()
}

async fn clear(s: &mut async_imap::Session<TcpStream>, mailbox: &str) {
    s.select(mailbox).await.unwrap();
    let _: Vec<_> = s.store("1:*", "+FLAGS.SILENT (\\Deleted)").await.unwrap().try_collect().await.unwrap_or_default();
    let _: Vec<_> = s.expunge().await.unwrap().try_collect().await.unwrap();
}

async fn append(s: &mut async_imap::Session<TcpStream>, subject: &str, flags: Option<&str>) {
    let raw = format!(
        "From: Ana Duarte <ana@example.com>\r\nTo: tester@localhost.test\r\nSubject: {subject}\r\n\
         Message-ID: <{}@example.com>\r\nDate: Tue, 13 Oct 2026 09:00:00 +0000\r\n\r\nBody of {subject}\r\n",
        subject.replace(' ', "-")
    );
    s.append("INBOX", flags, None, raw.as_bytes()).await.unwrap();
}

async fn server_flags(s: &mut async_imap::Session<TcpStream>, mailbox: &str) -> Vec<(String, String)> {
    s.select(mailbox).await.unwrap();
    let fetches: Vec<_> = s.fetch("1:*", "(FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)])").await.unwrap().try_collect().await.unwrap();
    fetches
        .iter()
        .map(|f| {
            let subject = String::from_utf8_lossy(f.header().unwrap_or_default()).trim().trim_start_matches("Subject: ").to_owned();
            (subject, format!("{:?}", f.flags().collect::<Vec<_>>()))
        })
        .collect()
}

async fn sync(store: &Store, account: &str) -> usize {
    let cursor = store.sync_cursor(account, net::INBOX).unwrap();
    let ops = store.pending_ops(account, net::INBOX).unwrap();
    let batch = net::sync_inbox(&config(), PASS, cursor, &ops).await.unwrap();
    store.apply_sync(account, &batch).unwrap()
}

fn lane(store: &Store, lane: Lane) -> Vec<pim_core::MessageSummary> {
    store.messages(&MessageQuery { lane, account_id: None, search: None, limit: None }).unwrap()
}

#[tokio::test]
#[ignore = "needs tools/test-mail-servers running"]
async fn full_round_trip() {
    let mut admin = raw_session().await;
    for m in ["INBOX", "Archive", "Sent"] {
        clear(&mut admin, m).await;
    }
    append(&mut admin, "First note", None).await;
    append(&mut admin, "Second note", Some("(\\Seen)")).await;
    append(&mut admin, "Third note", None).await;

    // Credentials: good ones verify, bad ones are reported as a sign-in problem.
    net::verify(&config(), PASS).await.unwrap();
    assert!(matches!(net::verify(&config(), "wrong").await, Err(Error::Auth(_))));

    // Initial sync.
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap().id;
    assert_eq!(sync(&store, &account).await, 3);
    let inbox = lane(&store, Lane::Inbox);
    let by_subject = |s: &str| inbox.iter().find(|m| m.subject == s).unwrap().clone();
    assert!(by_subject("Second note").seen, "server \\Seen comes down");
    assert!(!by_subject("First note").seen);

    // Local changes go up on the next sync.
    store.set_seen(&by_subject("First note").id, true).unwrap();
    store.set_flagged(&by_subject("Second note").id, true).unwrap();
    store.set_archived(&by_subject("Third note").id, true).unwrap();
    assert_eq!(sync(&store, &account).await, 0);
    assert!(store.pending_ops(&account, net::INBOX).unwrap().is_empty(), "ops confirmed");

    let flags = server_flags(&mut admin, "INBOX").await;
    let find = |s: &str| flags.iter().find(|(subj, _)| subj == s).map(|(_, f)| f.clone());
    assert!(find("First note").unwrap().contains("Seen"));
    assert!(find("Second note").unwrap().contains("Flagged"));
    assert!(find("Third note").is_none(), "archived mail left INBOX");
    let archived = server_flags(&mut admin, "Archive").await;
    assert_eq!(archived.len(), 1, "and landed in the \\Archive mailbox");
    assert_eq!(lane(&store, Lane::Archive).len(), 1, "local copy stays in Archive");

    // Changes made elsewhere come down: new mail, a flag set by another client.
    append(&mut admin, "Fourth note", None).await;
    admin.select("INBOX").await.unwrap();
    let _: Vec<_> = admin.uid_store("1:*", "+FLAGS.SILENT (\\Seen)").await.unwrap().try_collect().await.unwrap();
    assert_eq!(sync(&store, &account).await, 1);
    let inbox = lane(&store, Lane::Inbox);
    assert_eq!(inbox.len(), 3);
    assert!(inbox.iter().all(|m| m.seen), "flags set elsewhere are picked up");

    // Search over synced mail.
    let found = store
        .messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: Some("fourth".into()), limit: None })
        .unwrap();
    assert_eq!(found.len(), 1);

    // Send, and a copy lands in Sent.
    let draft = Draft {
        account_id: account.clone(),
        to: vec![Address { name: Some("Ana".into()), email: "ana@example.com".into() }],
        cc: vec![],
        subject: "Re: First note".into(),
        body: "Thanks!".into(),
        in_reply_to: Some("First-note@example.com".into()),
    };
    let raw = net::send(&config(), PASS, &draft).await.unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("In-Reply-To: <First-note@example.com>"));
    let sent = server_flags(&mut admin, "Sent").await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "Re: First note");
    if let Ok(dir) = std::env::var("MAILBIRD_IT_SMTP_OUT") {
        let rcpts = std::fs::read_to_string(format!("{dir}/rcpts.txt")).unwrap();
        assert!(rcpts.lines().any(|l| l == "ana@example.com"), "SMTP sink received it");
    }

    let _ = admin.logout().await;
}
