//! Watching mailboxes: one task per IMAP or JMAP watch, holding the same
//! IDLE or EventSource connection the desktop app holds (it's the same
//! `pim-core` code). Outlook needs no task: Graph calls the relay.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pim_core::net::{self, Change};

use crate::notify::{Delivery, Notifier};
use crate::store::{Store, WatchKind};
use crate::crypto::Sealer;

/// How long one IDLE or EventSource wait lasts before reconnecting.
const WAIT: Duration = Duration::from_secs(25 * 60);
/// Pushes for one mailbox are at least this far apart; a change inside the
/// window is pushed when it closes, so the last arrival is never missed.
pub const DEBOUNCE: i64 = 15;
const FIRST_RETRY: Duration = Duration::from_secs(30);
const MAX_RETRY: Duration = Duration::from_secs(15 * 60);

pub struct Relay {
    pub store: Store,
    pub notifier: Notifier,
    pub sealer: Sealer,
    /// Seconds between pushes for one mailbox ([`DEBOUNCE`]; tests shorten it).
    pub debounce: i64,
    tasks: Mutex<HashMap<(String, String), tokio::task::JoinHandle<()>>>,
    /// Pending trailing pushes, so a burst becomes one push per window.
    pending: Mutex<HashMap<(String, String), bool>>,
}

impl Relay {
    pub fn new(store: Store, notifier: Notifier, sealer: Sealer) -> Arc<Self> {
        Self::with_debounce(store, notifier, sealer, DEBOUNCE)
    }

    pub fn with_debounce(store: Store, notifier: Notifier, sealer: Sealer, debounce: i64) -> Arc<Self> {
        Arc::new(Self { store, notifier, sealer, debounce, tasks: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()) })
    }

    /// Starts a task for every IMAP or JMAP watch that has none, and stops
    /// tasks whose watch is gone. Called at start and after every change.
    pub fn reconcile(self: &Arc<Self>) {
        let wanted: Vec<(String, String)> = self.store.read(|devices| {
            devices
                .iter()
                .flat_map(|(d, dev)| dev.watches.iter().filter(|(_, w)| !matches!(w.kind, WatchKind::Graph { .. })).map(move |(a, _)| (d.clone(), a.clone())))
                .collect()
        });
        let mut tasks = self.tasks.lock().expect("tasks lock");
        tasks.retain(|key, handle| {
            let keep = wanted.contains(key) && !handle.is_finished();
            if !keep {
                handle.abort();
            }
            keep
        });
        for key in wanted {
            if !tasks.contains_key(&key) {
                let relay = self.clone();
                let (d, a) = key.clone();
                tasks.insert(key, tokio::spawn(async move { relay.watch(d, a).await }));
            }
        }
    }

    /// Restarts one watch (its config or secret changed).
    pub fn restart(self: &Arc<Self>, device: &str, account: &str) {
        if let Some(h) = self.tasks.lock().expect("tasks lock").remove(&(device.to_owned(), account.to_owned())) {
            h.abort();
        }
        self.reconcile();
    }

    pub fn watching(&self) -> usize {
        self.tasks.lock().expect("tasks lock").values().filter(|h| !h.is_finished()).count()
    }

    async fn watch(self: Arc<Self>, device: String, account: String) {
        let mut retry = FIRST_RETRY;
        let mut jmap_state: Option<String> = None;
        loop {
            let Some(kind) = self.store.device(&device).and_then(|d| d.watches.get(&account).map(|w| w.kind.clone())) else { return };
            let outcome = match &kind {
                WatchKind::Imap { config, secret } => match self.sealer.open(secret) {
                    Ok(s) => net::wait_for_change(config, &s, WAIT).await,
                    Err(e) => return self.fail(&device, &account, e),
                },
                WatchKind::Jmap { config, secret } => match self.sealer.open(secret) {
                    Ok(s) => net::jmap::wait_for_state(config, &s, jmap_state.as_deref(), WAIT).await.map(|(c, st)| {
                        if st.is_some() {
                            jmap_state = st;
                        }
                        c
                    }),
                    Err(e) => return self.fail(&device, &account, e),
                },
                WatchKind::Graph { .. } => return,
            };
            match outcome {
                Ok(Change::Changed) => {
                    retry = FIRST_RETRY;
                    self.store.status(&device, &account, |s| {
                        s.last_change = Some(pim_core::now());
                        s.error = None;
                    });
                    self.changed(&device, &account).await;
                }
                Ok(Change::Quiet) => {
                    retry = FIRST_RETRY;
                    self.store.status(&device, &account, |s| s.error = None);
                }
                Ok(Change::Unsupported) => {
                    return self.fail(&device, &account, "this server doesn't announce new mail (no IMAP IDLE or JMAP push); the app checks on its own schedule instead".into());
                }
                Err(e) => {
                    let msg = match &e {
                        pim_core::Error::Auth(_) => format!("the server refused the sign-in: update the account on your phone ({e})"),
                        _ => e.to_string(),
                    };
                    self.store.status(&device, &account, |s| s.error = Some(msg));
                    tokio::time::sleep(retry).await;
                    retry = (retry * 2).min(MAX_RETRY);
                }
            }
        }
    }

    fn fail(&self, device: &str, account: &str, error: String) {
        self.store.status(device, account, |s| s.error = Some(error));
    }

    /// A mailbox changed: push now, or at the end of the debounce window.
    pub async fn changed(self: &Arc<Self>, device: &str, account: &str) {
        let key = (device.to_owned(), account.to_owned());
        let last = self.store.device(device).and_then(|d| d.watches.get(account).and_then(|w| w.status.last_push));
        let wait = last.map(|l| self.debounce - (pim_core::now() - l)).filter(|w| *w > 0);
        if let Some(wait) = wait {
            // One trailing push per window, however many changes arrive in it.
            if self.pending.lock().expect("pending lock").insert(key.clone(), true).is_some() {
                return;
            }
            let relay = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                relay.pending.lock().expect("pending lock").remove(&key);
                let _ = relay.push(&key.0, &key.1, "mail").await;
            });
            return;
        }
        let _ = self.push(device, account, "mail").await;
    }

    /// Sends one push. A device whose token is gone is forgotten.
    pub async fn push(self: &Arc<Self>, device: &str, account: &str, kind: &str) -> Result<(), String> {
        let Some(target) = self.store.device(device).map(|d| d.target) else { return Err("no such device".into()) };
        match self.notifier.send(&target, account, kind).await {
            Ok(Delivery::Sent) => {
                self.store.status(device, account, |s| s.last_push = Some(pim_core::now()));
                Ok(())
            }
            Ok(Delivery::Gone) => {
                eprintln!("push-relay: the push service says device {device} is gone; forgetting it");
                self.store.write(|d| d.remove(device));
                self.reconcile();
                Err("the push service no longer knows this device".into())
            }
            Err(e) => {
                self.store.status(device, account, |s| s.error = Some(format!("push failed: {e}")));
                Err(e)
            }
        }
    }
}
