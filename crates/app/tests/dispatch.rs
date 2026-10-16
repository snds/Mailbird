//! The dispatcher both hosts call: every command routes, arguments arrive
//! by their UI names, and results and events come back.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pim_app::secrets::SecretStore;
use pim_app::{AppHandle, AppState, Host, Output, dispatch, dispatch::COMMANDS};
use serde_json::{Value, json};

#[derive(Default, Clone)]
struct TestHost {
    events: Arc<Mutex<Vec<String>>>,
    opened: Arc<Mutex<Vec<String>>>,
}

impl Host for TestHost {
    fn emit(&self, event: &str, _payload: Value) {
        self.events.lock().unwrap().push(event.to_owned());
    }
    fn notify(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }
    fn download_dir(&self) -> Result<PathBuf, String> {
        Ok(std::env::temp_dir())
    }
    fn open_path(&self, _: &Path) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct Memory(Mutex<HashMap<String, String>>);

impl SecretStore for Memory {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) {
        self.0.lock().unwrap().remove(key);
    }
}

fn json_of(o: Output) -> Value {
    match o {
        Output::Json(v) => v,
        Output::Bytes(_) => panic!("expected JSON"),
    }
}

#[tokio::test]
async fn every_command_routes_and_works() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let host = TestHost::default();
    let app = AppHandle::new(host.clone());

    // Every listed command is routed: with no arguments it runs, or asks for them.
    for name in COMMANDS {
        if let Err(e) = dispatch(&app, &state, name, Value::Null).await {
            assert!(!e.starts_with("unknown command"), "{name} isn't routed");
        }
    }
    assert!(dispatch(&app, &state, "drop_tables", Value::Null).await.err().unwrap().starts_with("unknown command"));
    assert!(dispatch(&app, &state, "get_thread", json!({ "thread_id": "x" })).await.err().unwrap().contains("bad arguments"), "arguments go by their camelCase names");

    // Real work through the dispatcher.
    assert_eq!(json_of(dispatch(&app, &state, "list_accounts", Value::Null).await.unwrap()), json!([]));
    dispatch(&app, &state, "set_time_zone", json!({ "tz": "Europe/Lisbon" })).await.unwrap();
    let cals = json_of(dispatch(&app, &state, "list_collections", json!({ "kind": "calendar" })).await.unwrap());
    let cal = cals[0]["id"].as_str().unwrap().to_owned();
    let input = json!({ "calendarId": cal, "title": "Gateway check", "start": "2026-10-20T10:00", "end": "2026-10-20T11:00", "timeZone": "Europe/Lisbon" });
    dispatch(&app, &state, "create_event", json!({ "input": input })).await.unwrap();
    let occ = json_of(dispatch(&app, &state, "list_occurrences", json!({ "from": 1_792_000_000i64, "to": 1_793_000_000i64 })).await.unwrap());
    assert_eq!(occ[0]["title"], "Gateway check");
    let note = json_of(dispatch(&app, &state, "create_note", json!({ "input": { "markdown": "# Hello\nfrom the dispatcher" } })).await.unwrap());
    assert_eq!(note["title"], "Hello");

    // Connected notes (ADR-0034): a [[link]], its backlink, finding by title, export.
    let other = json_of(dispatch(&app, &state, "create_note", json!({ "input": { "markdown": "# Reply\nsee [[hello]]" } })).await.unwrap());
    let back = json_of(dispatch(&app, &state, "note_backlinks", json!({ "id": note["id"] })).await.unwrap());
    assert_eq!(back[0]["id"], other["id"]);
    assert_eq!(json_of(dispatch(&app, &state, "find_note", json!({ "title": "HELLO" })).await.unwrap()), note["id"]);
    let profile = json_of(dispatch(&app, &state, "sender_profile", json!({ "email": "Nobody@Example.com" })).await.unwrap());
    assert_eq!((&profile["email"], &profile["received"], &profile["contact"]), (&json!("nobody@example.com"), &json!(0), &Value::Null));
    assert!(dispatch(&app, &state, "sender_profile", json!({ "email": "nope" })).await.is_err());
    let linking = json_of(dispatch(&app, &state, "notes_linking_to", json!({ "title": "Hello", "except": note["id"] })).await.unwrap());
    assert_eq!(linking[0]["id"], other["id"]);
    // Recipients' clocks (ADR-0041): nobody here has written yet.
    assert_eq!(json_of(dispatch(&app, &state, "local_times", json!({ "emails": ["a@x.test"] })).await.unwrap()), json!([]));
    // Card colors and the grid (ADR-0038).
    let colored = json_of(dispatch(&app, &state, "set_note_meta", json!({ "id": note["id"], "meta": { "color": "teal" } })).await.unwrap());
    assert_eq!(colored["color"], "teal");
    let cleared = json_of(dispatch(&app, &state, "set_note_meta", json!({ "id": note["id"], "meta": { "color": "" } })).await.unwrap());
    assert_eq!(cleared["color"], Value::Null);
    let prefs = json_of(dispatch(&app, &state, "set_notes_prefs", json!({ "prefs": { "sortChecked": true, "grid": true } })).await.unwrap());
    assert_eq!(prefs["grid"], true);
    // Locked notes (ADR-0043): set a passphrase, lock, lock now, unlock, open.
    let secret = json_of(dispatch(&app, &state, "create_note", json!({ "input": { "markdown": "Codes\nalarm 4242" } })).await.unwrap());
    dispatch(&app, &state, "set_notes_passphrase", json!({ "passphrase": "lighthouse", "hint": null })).await.unwrap();
    dispatch(&app, &state, "lock_note", json!({ "id": secret["id"] })).await.unwrap();
    assert_eq!(json_of(dispatch(&app, &state, "get_note", json!({ "id": secret["id"] })).await.unwrap())["markdown"], "");
    dispatch(&app, &state, "lock_notes_now", Value::Null).await.unwrap();
    assert!(dispatch(&app, &state, "open_locked_note", json!({ "id": secret["id"] })).await.err().unwrap().contains("Enter your passphrase"));
    assert!(dispatch(&app, &state, "unlock_notes", json!({ "passphrase": "nope-nope" })).await.is_err());
    let info = json_of(dispatch(&app, &state, "unlock_notes", json!({ "passphrase": "lighthouse" })).await.unwrap());
    assert_eq!(info["unlocked"], true);
    assert_eq!(info["identity"], false, "with no identity turned on, the passphrase is the only way in, as before");
    assert!(dispatch(&app, &state, "unlock_notes_with_identity", Value::Null).await.err().unwrap().contains("doesn't use a shared identity"));
    assert_eq!(json_of(dispatch(&app, &state, "open_locked_note", json!({ "id": secret["id"] })).await.unwrap())["markdown"], "Codes\nalarm 4242");
    assert!(json_of(dispatch(&app, &state, "notes_lock_setting", Value::Null).await.unwrap())["check"].is_string());
    // Images in notes (ADR-0044): a locked note's image is sealed, and opens while unlocked.
    let img = json_of(dispatch(&app, &state, "add_note_file", json!({ "noteId": secret["id"], "mime": "image/png", "dataBase64": "aW1n", "width": 2, "height": 1 })).await.unwrap());
    assert_eq!(img["sealed"], true);
    assert_eq!(json_of(dispatch(&app, &state, "note_file", json!({ "id": img["id"] })).await.unwrap())["dataBase64"], "aW1n");
    assert_ne!(json_of(dispatch(&app, &state, "note_file_raw", json!({ "id": img["id"] })).await.unwrap()), "aW1n");
    assert_eq!(json_of(dispatch(&app, &state, "note_files", json!({ "noteId": secret["id"] })).await.unwrap()).as_array().unwrap().len(), 1);
    let records = json_of(dispatch(&app, &state, "note_file_records", Value::Null).await.unwrap());
    assert_eq!(json_of(dispatch(&app, &state, "put_note_file", json!({ "file": records[0], "rawBase64": "aW1n" })).await.unwrap()), false, "not newer");
    // Text in images (ADR-0045): sealed like the image, readable while unlocked.
    assert!(json_of(dispatch(&app, &state, "note_files_without_text", json!({ "limit": 10 })).await.unwrap()).as_array().unwrap().is_empty(), "sealed ones wait");
    dispatch(&app, &state, "set_note_file_text", json!({ "id": img["id"], "text": "Gate code 4242" })).await.unwrap();
    assert_eq!(json_of(dispatch(&app, &state, "note_file", json!({ "id": img["id"] })).await.unwrap())["text"], "Gate code 4242");
    // Smart folders (ADR-0042): one that matches, then gone.
    let folder = json_of(dispatch(&app, &state, "save_note_folder", json!({ "id": null, "input": { "name": "Greetings", "words": "hello" } })).await.unwrap());
    assert_eq!(folder["count"], 2, "the note and the one linking to it");
    let inside = json_of(dispatch(&app, &state, "list_notes", json!({ "query": { "folder": folder["id"] } })).await.unwrap());
    assert!(inside.as_array().unwrap().iter().any(|n| n["title"] == "Hello"));
    dispatch(&app, &state, "delete_note_folder", json!({ "id": folder["id"] })).await.unwrap();
    assert_eq!(json_of(dispatch(&app, &state, "note_folders", Value::Null).await.unwrap()), json!([]));
    // Note reminders (ADR-0039): set, then 0 clears.
    let reminded = json_of(dispatch(&app, &state, "set_note_meta", json!({ "id": note["id"], "meta": { "remindAt": 4_000_000_000_i64 } })).await.unwrap());
    assert_eq!(reminded["remindAt"], 4_000_000_000_i64);
    let cleared = json_of(dispatch(&app, &state, "set_note_meta", json!({ "id": note["id"], "meta": { "remindAt": 0 } })).await.unwrap());
    assert_eq!(cleared["remindAt"], Value::Null);
    // Older clients send prefs without the grid; that means the list.
    let prefs = json_of(dispatch(&app, &state, "set_notes_prefs", json!({ "prefs": { "sortChecked": false } })).await.unwrap());
    assert_eq!(prefs["grid"], false);
    let files = json_of(dispatch(&app, &state, "export_notes", Value::Null).await.unwrap());
    let mut paths: Vec<&str> = files.as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    paths.sort();
    assert_eq!(paths, ["Hello.md", "Reply.md"]);
    let saved = json_of(dispatch(&app, &state, "save_notes_export", Value::Null).await.unwrap());
    let saved = std::path::PathBuf::from(saved.as_str().unwrap());
    assert!(std::fs::read_to_string(saved.join("Reply.md")).unwrap().ends_with("# Reply\nsee [[hello]]\n"));
    let _ = std::fs::remove_dir_all(saved);
    let events = host.events.lock().unwrap().clone();
    assert!(events.contains(&"pim:changed".to_string()) && events.contains(&"notes:changed".to_string()), "{events:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn compose_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-compose-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let host = TestHost::default();
    let app = AppHandle::new(host.clone());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };

    // An account and two list messages, stored directly (adding one through
    // the dispatcher would sign in to a real server).
    let (account, by_mail, by_web) = {
        let s = state.store.lock().unwrap();
        let server = pim_core::ServerConfig { host: "localhost".into(), port: 143, security: pim_core::Security::Plain };
        let a = s
            .add_account(&pim_core::AccountConfig {
                display_name: "Me".into(),
                address: "me@example.com".into(),
                username: "me".into(),
                provider: pim_core::Provider::Generic,
                imap: server.clone(),
                smtp: server,
                jmap: None,
                dav: None,
                oauth: None,
            })
            .unwrap();
        let mail = s.insert_local(&a.id, "INBOX", b"From: news@list.example\r\nSubject: Weekly\r\nList-Unsubscribe: <mailto:leave@list.example?subject=remove%20me>\r\n\r\nx\r\n", false).unwrap();
        let web = s.insert_local(&a.id, "INBOX", b"From: deals@shop.example\r\nSubject: Sale\r\nList-Unsubscribe: <https://shop.example/prefs>\r\n\r\nx\r\n", false).unwrap();
        (a.id, mail, web)
    };

    // Unsubscribe: by mail queues a message to the list's address; by web opens the page.
    assert_eq!(call("unsubscribe", json!({ "id": by_mail })).await.unwrap(), json!("mail"));
    let outbox = call("list_outbox", Value::Null).await.unwrap();
    assert_eq!(outbox[0]["draft"]["to"][0]["email"], "leave@list.example");
    assert_eq!(outbox[0]["draft"]["subject"], "remove me");
    assert_eq!(call("unsubscribe", json!({ "id": by_web })).await.unwrap(), json!("web"));
    assert_eq!(host.opened.lock().unwrap().as_slice(), ["https://shop.example/prefs"]);

    // Send later, then move it to now.
    let draft = json!({ "accountId": account, "to": [{ "email": "ana@example.com" }], "subject": "Later", "body": "x", "followUpAfter": 86400 });
    let at = pim_core::now() + 7200;
    let item = call("queue_send", json!({ "draft": draft, "undoSecs": 10, "sendAt": at })).await.unwrap();
    assert_eq!(item["scheduled"], true);
    assert_eq!(item["draft"]["followUpAfter"], 86400);
    let moved = call("reschedule_send", json!({ "id": item["id"], "sendAt": null })).await.unwrap();
    assert!(moved["sendAt"].as_i64().unwrap() <= pim_core::now());

    // Follow-ups need mail you sent.
    let thread = state.store.lock().unwrap().message(&by_mail).unwrap().summary.thread_id;
    assert!(call("set_follow_up", json!({ "threadId": thread, "dueAt": at })).await.unwrap_err().contains("you've sent"));

    // Templates and signatures.
    let t = call("save_template", json!({ "input": { "name": "Thanks", "subject": "Thank you", "html": "<p>Thanks!</p>" } })).await.unwrap();
    assert_eq!(call("list_templates", Value::Null).await.unwrap()[0]["name"], "Thanks");
    call("delete_template", json!({ "id": t["id"] })).await.unwrap();
    assert_eq!(call("list_templates", Value::Null).await.unwrap(), json!([]));
    call("set_signature", json!({ "accountId": account, "html": "<p>— Me</p>" })).await.unwrap();
    assert_eq!(call("list_signatures", Value::Null).await.unwrap(), json!([{ "accountId": account, "html": "<p>— Me</p>" }]));
    assert!(host.events.lock().unwrap().contains(&"compose:changed".to_string()));

    // The Screener and sender decisions, by their UI names.
    assert_eq!(call("screener_status", Value::Null).await.unwrap()["enabled"], false);
    assert_eq!(call("set_screener", json!({ "enabled": true })).await.unwrap()["enabled"], true);
    call("decide_sender", json!({ "email": "deals@shop.example", "decision": "blocked" })).await.unwrap();
    call("set_sender_category", json!({ "email": "news@list.example", "category": "newsletters" })).await.unwrap();
    let senders = call("list_senders", Value::Null).await.unwrap();
    assert_eq!(senders.as_array().unwrap().len(), 2);
    assert!(call("decide_sender", json!({ "email": "x", "decision": "nope" })).await.unwrap_err().contains("bad arguments"));
    let screener = call("list_messages", json!({ "query": { "lane": "screener", "category": "people" } })).await.unwrap();
    assert_eq!(screener, json!([]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn connected_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-connected-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    call("set_time_zone", json!({ "tz": "Europe/Lisbon" })).await.unwrap();

    // A contact's birthday shows on the read-only Birthdays calendar, pointing back at them.
    let books = call("list_collections", json!({ "kind": "contacts" })).await.unwrap();
    let input = json!({ "bookId": books[0]["id"], "fullName": "Ana Duarte", "emails": [{ "label": null, "value": "ana@example.com" }], "phones": [], "birthday": "1992-03-14" });
    let ana = call("create_contact", json!({ "input": input })).await.unwrap()["id"].as_str().unwrap().to_owned();
    let cals = call("list_collections", json!({ "kind": "calendar" })).await.unwrap();
    assert!(cals.as_array().unwrap().iter().any(|c| c["id"] == "birthdays" && c["writable"] == false), "{cals}");
    // 2027-03-01 → 2027-04-01.
    let occ = call("list_occurrences", json!({ "from": 1_803_859_200i64, "to": 1_806_537_600i64 })).await.unwrap();
    assert_eq!(occ[0]["title"], "Ana Duarte turns 35");
    assert_eq!(occ[0]["contactId"], json!(ana));

    // No mail or meetings yet: empty lists, not an error.
    assert_eq!(call("contact_activity", json!({ "id": ana })).await.unwrap(), json!({ "threads": [], "upcoming": [], "past": [] }));

    // Missed reminders are handed over once.
    let missed = pim_core::DueReminder { event_id: "e1".into(), title: "Standup".into(), location: None, start: 100, fire_at: 40, leave: false, note_id: None };
    *state.missed_reminders.lock().unwrap() = vec![missed];
    assert_eq!(call("take_missed_reminders", Value::Null).await.unwrap()[0]["title"], "Standup");
    assert_eq!(call("take_missed_reminders", Value::Null).await.unwrap(), json!([]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn contacts_depth_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-contacts-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    let books = call("list_collections", json!({ "kind": "contacts" })).await.unwrap();

    // Pasted signature → editor card → a labeled contact.
    let card = call("parse_signature", json!({ "text": "Rui Costa\nKiln manager | Clay Club\nm: +351 912 000 111" })).await.unwrap();
    assert_eq!((card["fullName"].as_str(), card["title"].as_str(), card["org"].as_str()), (Some("Rui Costa"), Some("Kiln manager"), Some("Clay Club")));
    let input = json!({ "bookId": books[0]["id"], "fullName": card["fullName"], "phones": card["phones"], "org": card["org"], "title": card["title"], "labels": ["Clay club"] });
    let rui = call("create_contact", json!({ "input": input })).await.unwrap()["id"].as_str().unwrap().to_owned();
    assert_eq!(call("contact_labels", Value::Null).await.unwrap(), json!([{ "name": "Clay club", "count": 1 }]));
    assert_eq!(call("list_contacts", json!({ "label": "clay club" })).await.unwrap()[0]["labels"], json!(["Clay club"]));

    // Share, delete, restore.
    let file = call("contact_vcard", json!({ "id": rui })).await.unwrap();
    assert_eq!(file["fileName"], "Rui Costa.vcf");
    assert!(call("contact_qr", json!({ "id": rui })).await.unwrap().as_str().unwrap().contains("<svg"));
    call("delete_contact", json!({ "id": rui })).await.unwrap();
    let gone = call("deleted_contacts", Value::Null).await.unwrap();
    assert_eq!(gone[0]["fullName"], "Rui Costa");
    let back = call("restore_contact", json!({ "id": gone[0]["id"] })).await.unwrap();
    assert_eq!(back["labels"], json!(["Clay club"]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn planning_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-planning-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    call("set_time_zone", json!({ "tz": "Europe/Lisbon" })).await.unwrap();
    let cals = call("list_collections", json!({ "kind": "calendar" })).await.unwrap();
    let cal = cals[0]["id"].as_str().unwrap().to_owned();
    let input = json!({ "calendarId": cal, "title": "Standup", "start": "2030-06-04T09:00", "end": "2030-06-04T10:00", "timeZone": "Europe/Lisbon" });
    call("create_event", json!({ "input": input })).await.unwrap();

    // Tue 4 Jun 2030, from midnight UTC: the first free hour after standup.
    let slots = call("find_times", json!({ "from": 1_906_761_600i64, "minutes": 60, "dayStart": 540, "dayEnd": 1020, "weekdaysOnly": true, "limit": 1 })).await.unwrap();
    assert_eq!(slots, json!([{ "start": 1_906_794_000i64, "end": 1_906_797_600i64 }]), "10:00–11:00 Lisbon");
    assert!(call("find_times", json!({ "from": 0, "minutes": 0, "dayStart": 540, "dayEnd": 1020, "weekdaysOnly": true })).await.unwrap_err().contains("doesn't fit"));

    let sets = call("save_calendar_set", json!({ "name": "Everything" })).await.unwrap();
    let id = sets[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(call("calendar_sets", Value::Null).await.unwrap()[0]["name"], "Everything");
    call("apply_calendar_set", json!({ "id": id })).await.unwrap();
    assert_eq!(call("delete_calendar_set", json!({ "id": id })).await.unwrap(), json!([]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn split_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-splits-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    let split = call("save_split", json!({ "input": { "name": "Work", "senders": ["@studio.example"], "exclusive": true } })).await.unwrap();
    assert_eq!((split["name"].as_str(), split["exclusive"].as_bool()), (Some("Work"), Some(true)), "the rule is flattened into the split");
    let id = split["id"].as_str().unwrap().to_owned();
    assert!(call("save_split", json!({ "input": { "name": "Bad" } })).await.unwrap_err().contains("say what goes in it"));
    assert_eq!(call("list_messages", json!({ "query": { "lane": "inbox", "split": id, "bundle": false } })).await.unwrap(), json!([]));
    assert_eq!(call("inbox_overview", Value::Null).await.unwrap(), json!({ "splits": [{ "id": id, "threads": 0, "unread": 0 }], "bundle": null }));
    assert_eq!(call("bundle_archive", Value::Null).await.unwrap(), json!([]));
    assert_eq!(call("delete_split", json!({ "id": id })).await.unwrap(), json!([]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn smart_group_and_restore_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-people-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    let books = call("list_collections", json!({ "kind": "contacts" })).await.unwrap();
    let book = books.as_array().unwrap().iter().find(|b| b["writable"] == json!(true) && b["id"] != json!("birthdays")).unwrap()["id"].clone();
    let since = call("restore_contacts", json!({})).await.unwrap_err();
    assert!(since.contains("say when"));
    let start = chrono_free_now() - 5;
    call("create_contact", json!({ "input": { "bookId": book, "fullName": "Priya Raman", "emails": [{ "value": "priya@studio.example" }] } })).await.unwrap();
    let g = call("save_smart_group", json!({ "input": { "name": "Studio", "domain": "studio.example" } })).await.unwrap();
    assert_eq!((g["name"].as_str(), g["count"].as_u64()), (Some("Studio"), Some(1)), "the rule is flattened, with a count");
    let listed = call("list_contacts", json!({ "group": g["id"] })).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(call("smart_groups", Value::Null).await.unwrap().as_array().unwrap().len(), 1);
    let preview = call("contacts_restore_preview", json!({ "since": start })).await.unwrap();
    assert_eq!(preview["added"], json!(["Priya Raman"]));
    let done = call("restore_contacts", json!({ "since": start })).await.unwrap();
    assert_eq!(done["changed"], json!(1));
    assert_eq!(call("list_contacts", Value::Null).await.unwrap(), json!([]));
    call("restore_contacts", json!({ "after": done["mark"] })).await.unwrap();
    assert_eq!(call("list_contacts", Value::Null).await.unwrap().as_array().unwrap().len(), 1, "undone");
    call("delete_smart_group", json!({ "id": g["id"] })).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

fn chrono_free_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

#[tokio::test]
async fn interesting_calendar_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-interesting-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    let list = call("interesting_calendars", Value::Null).await.unwrap();
    let us = list.as_array().unwrap().iter().find(|c| c["country"] == json!("US")).unwrap();
    assert_eq!((us["name"].as_str(), us["subscribed"].as_bool()), (Some("Holidays in the United States"), Some(false)));
    call("add_interesting_calendar", json!({ "id": "interesting:holidays-us" })).await.unwrap();
    assert!(call("add_interesting_calendar", json!({ "id": "nope" })).await.is_err());
    // 1–31 December 2026 (UTC).
    let occ = call("list_occurrences", json!({ "from": 1_796_083_200i64, "to": 1_798_761_600i64 })).await.unwrap();
    assert!(occ.as_array().unwrap().iter().any(|o| o["title"] == json!("Christmas Day") && o["calendarId"] == json!("interesting:holidays-us")));
    call("remove_interesting_calendar", json!({ "id": "interesting:holidays-us" })).await.unwrap();

    // Regions (ADR-0033): pick one, see its name, go back to nationwide.
    call("set_holiday_region", json!({ "id": "interesting:holidays-de", "region": "BY" })).await.unwrap();
    let list = call("interesting_calendars", Value::Null).await.unwrap();
    let de = list.as_array().unwrap().iter().find(|c| c["id"] == json!("interesting:holidays-de")).unwrap();
    assert_eq!((&de["name"], &de["region"]), (&json!("Holidays in Bavaria"), &json!("BY")));
    assert!(de["regions"].as_array().unwrap().iter().any(|r| r == &json!({ "code": "SN", "name": "Saxony" })));
    assert!(call("set_holiday_region", json!({ "id": "interesting:holidays-de", "region": "QC" })).await.is_err());
    call("set_holiday_region", json!({ "id": "interesting:holidays-de", "region": null })).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn swipe_action_commands() {
    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-swipes-{}", std::process::id()));
    let state = AppState::open(&dir).unwrap();
    let app = AppHandle::new(TestHost::default());
    let call = |name: &'static str, args: Value| {
        let (app, state) = (app.clone(), state.clone());
        async move { dispatch(&app, &state, name, args).await.map(json_of) }
    };
    assert_eq!(call("swipe_actions", Value::Null).await.unwrap(), json!({ "right": "read", "rightLong": "none", "left": "archive", "leftLong": "none" }));
    let mine = json!({ "right": "star", "rightLong": "remind", "left": "snooze-tomorrow", "leftLong": "archive" });
    assert_eq!(call("set_swipe_actions", json!({ "actions": mine })).await.unwrap(), mine);
    assert!(call("set_swipe_actions", json!({ "actions": { "right": "explode", "rightLong": "none", "left": "archive", "leftLong": "none" } })).await.is_err());
    assert_eq!(call("swipe_actions", Value::Null).await.unwrap(), mine);

    // Keys (ADR-0032): defaults, a swap, a refusal, and a reset.
    let keys = call("key_bindings", Value::Null).await.unwrap();
    assert_eq!((&keys["mail.archive"], &keys["calendar.previous"]), (&json!("e"), &json!("ArrowLeft")));
    let mut swapped = keys.clone();
    swapped["mail.archive"] = json!("s");
    swapped["mail.star"] = json!("e");
    assert_eq!(call("set_key_bindings", json!({ "bindings": swapped })).await.unwrap(), swapped);
    let mut clash = swapped.clone();
    clash["mail.compose"] = json!("e");
    assert!(call("set_key_bindings", json!({ "bindings": clash })).await.unwrap_err().to_string().contains("already the key"));
    assert_eq!(call("key_bindings", Value::Null).await.unwrap(), swapped);
    assert_eq!(call("set_key_bindings", json!({ "bindings": {} })).await.unwrap(), keys);
    let _ = std::fs::remove_dir_all(dir);
}

/// ADR-0051: the locked-notes key is wrapped under the shared identity on
/// every passphrase unlock or change, and the identity can open the notes
/// in its place. The passphrase keeps working; the notes never move.
#[tokio::test]
async fn the_identity_holds_the_notes_key() {
    use ecosystem_identity::{Attach, FileKeystore, Identity, Purpose};
    use pim_app::identity::{APP_ID, IdentityConfig};

    pim_app::secrets::install(Box::new(Memory::default()));
    let dir = std::env::temp_dir().join(format!("pim-app-identity-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let state = AppState::open(&dir.join("data")).unwrap();
    let config = IdentityConfig { root: dir.join("identity"), keystore: dir.join("data/identity-device.key"), device_name: "Test laptop".into() };
    state.enable_identity(config.clone());
    let app = AppHandle::new(TestHost::default());
    let app_keys = || {
        let ks = FileKeystore::open_or_create(&config.keystore).unwrap();
        let Attach::Attached(id) = Identity::attach(&config.root, APP_ID, &ks, None).unwrap() else { panic!("no identity") };
        let p = id.personas().next().unwrap().persona_id;
        let n = id.app_keys(p, APP_ID).len();
        assert_eq!(n, id.envelopes().filter(|e| e.purpose == Purpose::AppData).count(), "every app key is labelled Mailbird's");
        n
    };

    let note = json_of(dispatch(&app, &state, "create_note", json!({ "input": { "markdown": "Safe\ncombination 12-34-56" } })).await.unwrap());
    assert!(!config.root.exists(), "nothing is created before the notes have a passphrase");
    dispatch(&app, &state, "set_notes_passphrase", json!({ "passphrase": "lighthouse", "hint": null })).await.unwrap();
    assert_eq!(app_keys(), 1, "setting the passphrase made the identity and wrapped the key under it");
    dispatch(&app, &state, "lock_note", json!({ "id": note["id"] })).await.unwrap();
    dispatch(&app, &state, "lock_notes_now", Value::Null).await.unwrap();

    let info = json_of(dispatch(&app, &state, "notes_lock", Value::Null).await.unwrap());
    assert_eq!((info["unlocked"].as_bool(), info["identity"].as_bool()), (Some(false), Some(true)));
    let info = json_of(dispatch(&app, &state, "unlock_notes_with_identity", Value::Null).await.unwrap());
    assert_eq!(info["unlocked"], true, "the identity opened the notes, no passphrase");
    assert_eq!(json_of(dispatch(&app, &state, "open_locked_note", json!({ "id": note["id"] })).await.unwrap())["markdown"], "Safe\ncombination 12-34-56");

    // The passphrase still works, and unlocking with it again adds nothing.
    dispatch(&app, &state, "lock_notes_now", Value::Null).await.unwrap();
    dispatch(&app, &state, "unlock_notes", json!({ "passphrase": "lighthouse" })).await.unwrap();
    assert_eq!(app_keys(), 1);

    // A new passphrase reseals the notes with a new key: that one is wrapped,
    // and the old wrap (a key that opens nothing now) is retired.
    dispatch(&app, &state, "set_notes_passphrase", json!({ "passphrase": "harbour light", "hint": null })).await.unwrap();
    assert_eq!(app_keys(), 1);
    dispatch(&app, &state, "lock_notes_now", Value::Null).await.unwrap();
    dispatch(&app, &state, "unlock_notes_with_identity", Value::Null).await.unwrap();
    assert!(json_of(dispatch(&app, &state, "open_locked_note", json!({ "id": note["id"] })).await.unwrap())["markdown"].as_str().unwrap().contains("12-34-56"));

    // A device restored from the recovery kit remembers no envelope: the
    // identity's Mailbird keys are searched, and the current one opens.
    state.store.lock().unwrap().set_setting("notes.identity", None).unwrap();
    dispatch(&app, &state, "lock_notes_now", Value::Null).await.unwrap();
    assert_eq!(json_of(dispatch(&app, &state, "notes_lock", Value::Null).await.unwrap())["identity"], true, "an identity is here, so it's offered");
    dispatch(&app, &state, "unlock_notes_with_identity", Value::Null).await.unwrap();
    assert!(state.store.lock().unwrap().setting("notes.identity").unwrap().is_some(), "and the envelope is remembered again");

    // An identity that can't be reached never stands in the passphrase's way.
    let broken = AppState::open(&dir.join("broken")).unwrap();
    std::fs::write(dir.join("not-a-dir"), b"x").unwrap();
    broken.enable_identity(IdentityConfig { root: dir.join("not-a-dir/identity"), keystore: dir.join("broken/device.key"), device_name: "Broken".into() });
    dispatch(&app, &broken, "set_notes_passphrase", json!({ "passphrase": "lighthouse", "hint": null })).await.unwrap();
    dispatch(&app, &broken, "lock_notes_now", Value::Null).await.unwrap();
    assert_eq!(json_of(dispatch(&app, &broken, "unlock_notes", json!({ "passphrase": "lighthouse" })).await.unwrap())["unlocked"], true);
    assert!(dispatch(&app, &broken, "unlock_notes_with_identity", Value::Null).await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
