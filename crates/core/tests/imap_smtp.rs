//! End-to-end test against real servers: IMAP sync, pushing local changes,
//! archive, and SMTP send with a Sent copy.
//!
//! Ignored by default because it needs servers. `tools/test-mail-servers/start.sh`
//! starts what it expects (Dovecot on 127.0.0.1:1143, an SMTP sink on :2525,
//! user `tester` / `secret`); then run
//! `cargo test -p pim-core --test imap_smtp -- --ignored`.

#![cfg(feature = "net")]

use futures::TryStreamExt;
use base64::Engine;
use pim_core::{
    AccountConfig, Address, Draft, Error, Lane, MessageQuery, OutgoingAttachment, Provider, Security, ServerConfig,
    Store, mime, net,
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
        jmap: None,
        dav: None,
        oauth: None,
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

/// Sync INBOX, Archive, and Sent like the shell does. Returns new INBOX mail.
async fn sync(store: &Store, account: &str) -> usize {
    let plans = [pim_core::store::INBOX, pim_core::store::ARCHIVE, pim_core::store::SENT]
        .into_iter()
        .map(|m| net::MailboxPlan {
            store: m,
            cursor: store.sync_cursor(account, m).unwrap(),
            ops: store.pending_ops(account, m).unwrap(),
        })
        .collect();
    let mut new_in_inbox = 0;
    for batch in net::sync_account(&config(), PASS, plans).await.unwrap() {
        let n = store.apply_sync(account, &batch).unwrap();
        if batch.mailbox == pim_core::store::INBOX {
            new_in_inbox += n;
        }
    }
    new_in_inbox
}

fn lane(store: &Store, lane: Lane) -> Vec<pim_core::MessageSummary> {
    store.messages(&MessageQuery { lane, account_id: None, search: None, limit: None, offset: None }).unwrap()
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
    let archive_lane = lane(&store, Lane::Archive);
    assert_eq!(archive_lane.len(), 1, "it comes back through the Archive mailbox sync");
    assert_eq!(archive_lane[0].mailbox, pim_core::store::ARCHIVE);

    // Unarchive moves it back to INBOX on the server, with no duplicate locally.
    store.set_thread_archived(&archive_lane[0].thread_id, false).unwrap();
    sync(&store, &account).await;
    assert!(server_flags(&mut admin, "INBOX").await.iter().any(|(s, _)| s == "Third note"), "back in the server INBOX");
    assert!(server_flags(&mut admin, "Archive").await.is_empty());
    assert_eq!(lane(&store, Lane::Inbox).iter().filter(|m| m.subject == "Third note").count(), 1);
    let t = lane(&store, Lane::Inbox).into_iter().find(|m| m.subject == "Third note").unwrap().thread_id;
    store.set_thread_archived(&t, true).unwrap();
    sync(&store, &account).await;

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
        .messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: Some("fourth".into()), limit: None, offset: None })
        .unwrap();
    assert_eq!(found.len(), 1);

    // Send, and a copy lands in Sent.
    let draft = Draft {
        account_id: account.clone(),
        to: vec![Address { name: Some("Ana".into()), email: "ana@example.com".into() }],
        cc: vec![],
        subject: "Re: First note".into(),
        body: "Thanks!".into(),
        body_html: None,
        in_reply_to: Some("First-note@example.com".into()),
        references: vec![],
        attachments: vec![],
        calendar: None,
        follow_up_after: None,
    };
    let raw = net::send(&config(), PASS, &draft).await.unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("In-Reply-To: <First-note@example.com>"));
    let sent = server_flags(&mut admin, "Sent").await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "Re: First note");
    // The shell keeps a local copy; the synced server copy replaces it and threads.
    store.insert_local(&account, pim_core::store::SENT, &raw, true).unwrap();
    sync(&store, &account).await;
    let first = lane(&store, Lane::Inbox).into_iter().find(|m| m.subject == "First note").unwrap();
    let in_thread: Vec<_> = store.thread(&first.thread_id).unwrap().into_iter().filter(|m| m.summary.mailbox == pim_core::store::SENT).collect();
    assert_eq!(in_thread.len(), 1, "one Sent copy in the conversation");
    assert!(store.sync_cursor(&account, pim_core::store::SENT).unwrap().oldest_uid.is_some(), "and it's the server's");
    if let Ok(dir) = std::env::var("MAILBIRD_IT_SMTP_OUT") {
        let rcpts = std::fs::read_to_string(format!("{dir}/rcpts.txt")).unwrap();
        assert!(rcpts.lines().any(|l| l == "ana@example.com"), "SMTP sink received it");
    }

    // An invitation reply goes out as iMIP: text/calendar with METHOD:REPLY.
    let reply = Draft {
        subject: "Accepted: Design crit".into(),
        body: "Test User accepted.".into(),
        in_reply_to: None,
        calendar: Some(pim_core::CalendarPart { method: "REPLY".into(), ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:inv-1\r\nDTSTAMP:20261010T100000Z\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:tester@localhost\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n".into() }),
        ..draft.clone()
    };
    net::send(&config(), PASS, &reply).await.unwrap();
    if let Ok(dir) = std::env::var("MAILBIRD_IT_SMTP_OUT") {
        let newest = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "eml")).max_by_key(|e| e.metadata().unwrap().modified().unwrap()).unwrap();
        let sent = std::fs::read(newest.path()).unwrap();
        assert!(String::from_utf8_lossy(&sent).contains("text/calendar; method=REPLY"), "the sink got the calendar part");
        assert!(mime::calendar_part(&sent).is_some_and(|c| c.contains("PARTSTAT=ACCEPTED")));
    }

    // IDLE: a change on the server wakes the waiting connection.
    let waiter = tokio::spawn(async { net::wait_for_change(&config(), PASS, std::time::Duration::from_secs(20)).await });
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    append(&mut admin, "Fifth note", None).await;
    let change = tokio::time::timeout(std::time::Duration::from_secs(10), waiter).await.expect("IDLE woke up").unwrap().unwrap();
    assert_eq!(change, net::Change::Changed);
    assert_eq!(sync(&store, &account).await, 1, "and the sync it triggers fetches the new mail");

    // Attachments go out as multipart and survive the trip.
    let with_file = Draft {
        attachments: vec![OutgoingAttachment {
            filename: "itinerary.pdf".into(),
            mime_type: "application/pdf".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7 ferry"),
        }],
        subject: "Itinerary".into(),
        body_html: Some("<p>Your <strong>itinerary</strong></p>".into()),
        ..draft
    };
    net::send(&config(), PASS, &with_file).await.unwrap();
    admin.select("Sent").await.unwrap();
    let sent: Vec<_> = admin.fetch("*", "BODY.PEEK[]").await.unwrap().try_collect().await.unwrap();
    let raw = sent[0].body().unwrap();
    let parsed = mime::parse(raw).unwrap();
    assert_eq!(parsed.attachments[0].filename, "itinerary.pdf");
    assert_eq!(mime::attachment_bytes(raw, 0).unwrap(), b"%PDF-1.7 ferry");
    assert!(parsed.body_html.unwrap().contains("<strong>itinerary</strong>"), "the rich body travels with the file");

    // Backfill: a big mailbox arrives newest-first, then older chunks.
    clear(&mut admin, "INBOX").await;
    let total = net::INITIAL_SYNC_LIMIT + 60;
    for i in 0..total {
        append(&mut admin, &format!("Bulk {i:04}"), Some("(\\Seen)")).await;
    }
    let fresh = Store::open_in_memory().unwrap();
    let acct2 = fresh.add_account(&config()).unwrap().id;
    let pass = |store: &Store, account: &str| {
        let cursor = store.sync_cursor(account, net::INBOX).unwrap();
        async move { net::sync_inbox(&config(), PASS, cursor, &[]).await.unwrap() }
    };
    let first = pass(&fresh, &acct2).await;
    assert_eq!(first.new_messages.len(), net::INITIAL_SYNC_LIMIT);
    assert!(first.more_older);
    fresh.apply_sync(&acct2, &first).unwrap();
    let all = |s: &Store| s.messages(&MessageQuery { lane: Lane::Inbox, account_id: None, search: None, limit: Some(1000), offset: None }).unwrap();
    assert!(all(&fresh).iter().any(|m| m.subject == format!("Bulk {:04}", total - 1)), "newest first");
    let second = pass(&fresh, &acct2).await;
    assert_eq!(second.new_messages.len(), 60);
    assert!(!second.more_older);
    fresh.apply_sync(&acct2, &second).unwrap();
    assert_eq!(all(&fresh).len(), total);
    assert!(pass(&fresh, &acct2).await.new_messages.is_empty(), "nothing left to fetch");

    let _ = admin.logout().await;
}
