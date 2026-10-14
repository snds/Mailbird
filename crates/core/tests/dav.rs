//! End-to-end CalDAV/CardDAV test against a real server (Stalwart): discovery,
//! creating, editing, and deleting events and contacts, changes made
//! elsewhere, and conflicts.
//!
//! Ignored by default. `tools/test-mail-servers/start-jmap.sh` starts what it
//! expects (Stalwart on 127.0.0.1:8080, user `tester@localhost.test` /
//! `tester-secret-1`); then run `cargo test -p pim-core --test dav -- --ignored`.

#![cfg(feature = "net")]

use pim_core::net::dav::{self, Dav, DavPlan};
use pim_core::{
    AccountConfig, CollectionKind, ContactField, ContactInput, DavChange, DavOutcome, EventInput, Provider, Repeat,
    Security, ServerConfig, Store, ical,
};

const BASE: &str = "http://127.0.0.1:8080/";
const USER: &str = "tester@localhost.test";
const PASS: &str = "tester-secret-1";

fn config() -> AccountConfig {
    let unused = ServerConfig { host: String::new(), port: 0, security: Security::Tls };
    AccountConfig {
        display_name: "Test User".into(),
        address: USER.into(),
        username: USER.into(),
        provider: Provider::Generic,
        imap: unused.clone(),
        smtp: unused,
        jmap: None,
        dav: None,
    }
}

fn client() -> Dav {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Dav::new(BASE, USER, PASS).unwrap()
}

async fn sync(store: &Store, dav: &Dav, account: &str) {
    for kind in [CollectionKind::Calendar, CollectionKind::Contacts] {
        let remote = dav.discover(kind).await.unwrap();
        store.sync_collections(account, kind, &remote).unwrap();
    }
    let plans = store
        .dav_cursors(account)
        .unwrap()
        .into_iter()
        .map(|(c, cursor)| DavPlan { changes: store.pending_dav(&c.id).unwrap(), collection_id: c.id, kind: c.kind, cursor })
        .collect();
    for r in dav::sync(dav, plans).await.unwrap() {
        for (item, outcome) in &r.outcomes {
            store.dav_result(&r.collection_id, item, outcome).unwrap();
        }
        store.apply_dav(&r.collection_id, &r.batch).unwrap();
    }
}

fn first_writable(store: &Store, kind: CollectionKind) -> String {
    store.collections(kind).unwrap().into_iter().find(|c| c.account_id.is_some() && c.writable).expect("a server collection").id
}

fn event(calendar: &str, title: &str) -> EventInput {
    EventInput {
        calendar_id: calendar.into(),
        title: title.into(),
        location: Some("Pier 3".into()),
        notes: None,
        start: "2026-10-24T08:15".into(),
        end: "2026-10-24T09:00".into(),
        all_day: false,
        time_zone: "Europe/Lisbon".into(),
        repeat: Repeat::None,
    }
}

const SAT: (i64, i64) = (1_792_800_000, 1_792_886_400); // 2026-10-24 UTC

#[tokio::test]
#[ignore = "needs tools/test-mail-servers/start-jmap.sh running"]
async fn dav_round_trip() {
    let dav = client();
    assert!(matches!(Dav::new(BASE, USER, "wrong").unwrap().discover(CollectionKind::Calendar).await, Err(pim_core::Error::Auth(_))));

    // Two devices on one account: `a` and `b`.
    let a = Store::open_in_memory().unwrap();
    let b = Store::open_in_memory().unwrap();
    let acct_a = a.add_account(&config()).unwrap().id;
    let acct_b = b.add_account(&config()).unwrap().id;
    sync(&a, &dav, &acct_a).await;
    sync(&b, &dav, &acct_b).await;
    let cal_a = first_writable(&a, CollectionKind::Calendar);
    let cal_b = first_writable(&b, CollectionKind::Calendar);
    assert!(!a.collections(CollectionKind::Contacts).unwrap().is_empty(), "address book discovered");

    // Start clean: delete anything a previous run left behind.
    for o in a.occurrences(0, i64::MAX / 2).unwrap() {
        a.delete_event(&o.event_id, None).unwrap();
    }
    for c in a.contacts(None).unwrap() {
        a.delete_contact(&c.id).unwrap();
    }
    sync(&a, &dav, &acct_a).await;
    sync(&b, &dav, &acct_b).await;
    assert!(b.occurrences(0, i64::MAX / 2).unwrap().is_empty());

    // Create on a, see it on b.
    let created = a.create_event(&event(&cal_a, "Ferry")).unwrap();
    sync(&a, &dav, &acct_a).await;
    assert!(a.pending_dav(&cal_a).unwrap().is_empty(), "pushed");
    sync(&b, &dav, &acct_b).await;
    let on_b = b.occurrences(SAT.0, SAT.1).unwrap();
    assert_eq!(on_b.len(), 1);
    assert_eq!(on_b[0].title, "Ferry");
    assert_eq!(on_b[0].start, 1_792_826_100, "08:15 in Lisbon (WEST) is 07:15Z");

    // Edit on b, see it on a; a's untouched copy refreshes.
    b.update_event(&on_b[0].event_id, &EventInput { title: "Ferry (later)".into(), start: "2026-10-24T10:00".into(), end: "2026-10-24T10:45".into(), ..event(&cal_b, "") }).unwrap();
    sync(&b, &dav, &acct_b).await;
    sync(&a, &dav, &acct_a).await;
    let on_a = a.occurrences(SAT.0, SAT.1).unwrap();
    assert_eq!((on_a.len(), on_a[0].title.as_str()), (1, "Ferry (later)"));
    assert_eq!(on_a[0].event_id, created.occurrence.event_id, "same row, updated in place");

    // Conflict: both edit; b pushes first, so a's push is refused and the server's copy wins.
    a.update_event(&on_a[0].event_id, &EventInput { title: "From a".into(), ..event(&cal_a, "") }).unwrap();
    let on_b = b.occurrences(SAT.0, SAT.1).unwrap();
    b.update_event(&on_b[0].event_id, &EventInput { title: "From b".into(), ..event(&cal_b, "") }).unwrap();
    sync(&b, &dav, &acct_b).await;
    sync(&a, &dav, &acct_a).await;
    assert_eq!(a.occurrences(SAT.0, SAT.1).unwrap()[0].title, "From b", "server wins");

    // A stale write straight to the server is refused, never applied.
    let cursor = a.dav_cursors(&acct_a).unwrap().into_iter().find(|(c, _)| c.id == cal_a).unwrap().1;
    let href = cursor.etags.keys().next().unwrap().clone();
    let body = Some(ical::new_event("x", &event(&cal_a, "Stale")).unwrap());
    let outcome = dav.push(CollectionKind::Calendar, &DavChange { item_id: "x".into(), href, etag: Some("\"stale\"".into()), body }).await.unwrap();
    assert_eq!(outcome, DavOutcome::Conflict);

    // Recurring event with a skipped date round-trips with its VTIMEZONE.
    let mut weekly = event(&cal_a, "Climbing");
    weekly.repeat = Repeat::Weekly;
    let w = a.create_event(&weekly).unwrap();
    let four_weeks = (SAT.0, SAT.0 + 28 * 86_400);
    let second = a.occurrences(four_weeks.0, four_weeks.1).unwrap().into_iter().filter(|o| o.title == "Climbing").nth(1).unwrap().start;
    a.delete_event(&w.occurrence.event_id, Some(second)).unwrap();
    sync(&a, &dav, &acct_a).await;
    sync(&b, &dav, &acct_b).await;
    let climbs = b.occurrences(four_weeks.0, four_weeks.1).unwrap().into_iter().filter(|o| o.title == "Climbing").count();
    assert_eq!(climbs, 3, "4 weeks minus the skipped one");

    // Delete on b, gone on a.
    for o in b.occurrences(0, i64::MAX / 2).unwrap() {
        b.delete_event(&o.event_id, None).unwrap();
    }
    sync(&b, &dav, &acct_b).await;
    sync(&a, &dav, &acct_a).await;
    assert!(a.occurrences(0, i64::MAX / 2).unwrap().is_empty());

    // Contacts: create, edit, merge, delete.
    let book_a = first_writable(&a, CollectionKind::Contacts);
    let person = |name: &str, email: &str| ContactInput {
        book_id: book_a.clone(),
        full_name: name.into(),
        emails: vec![ContactField { label: Some("work".into()), value: email.into() }],
        phones: vec![],
        org: None,
        title: None,
        note: None,
        birthday: None,
    };
    let ana = a.create_contact(&person("Ana Duarte", "ana@studio.example")).unwrap();
    let dup = a.create_contact(&person("Ana D.", "ANA@studio.example")).unwrap();
    sync(&a, &dav, &acct_a).await;
    sync(&b, &dav, &acct_b).await;
    assert_eq!(b.contacts(None).unwrap().len(), 2);
    a.merge_contacts(&ana.summary.id, std::slice::from_ref(&dup.summary.id)).unwrap();
    sync(&a, &dav, &acct_a).await;
    sync(&b, &dav, &acct_b).await;
    let left = b.contacts(None).unwrap();
    assert_eq!(left.len(), 1, "the merged duplicate is gone everywhere");
    assert_eq!(left[0].full_name, "Ana Duarte");
    b.delete_contact(&left[0].id).unwrap();
    sync(&b, &dav, &acct_b).await;
    sync(&a, &dav, &acct_a).await;
    assert!(a.contacts(None).unwrap().is_empty());
}
