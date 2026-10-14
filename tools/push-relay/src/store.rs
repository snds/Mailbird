//! What the relay remembers: devices, where to push them, and the mailboxes
//! each one asked to have watched. One JSON file, written atomically, with
//! account secrets sealed (see [`crate::crypto::Sealer`]).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use pim_core::AccountConfig;
use serde::{Deserialize, Serialize};

/// Where a device receives pushes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "lowercase")]
pub enum Target {
    /// Apple Push Notification service. `sandbox` for development builds.
    Apns {
        token: String,
        #[serde(default)]
        sandbox: bool,
    },
    /// Firebase Cloud Messaging (Android with Google Play services).
    Fcm { token: String },
    /// A UnifiedPush endpoint, such as an ntfy topic: Android without
    /// Google, or anything that takes a plain HTTP POST.
    UnifiedPush { endpoint: String },
}

impl Target {
    pub fn platform(&self) -> &'static str {
        match self {
            Target::Apns { .. } => "apns",
            Target::Fcm { .. } => "fcm",
            Target::UnifiedPush { .. } => "unifiedpush",
        }
    }
}

/// How one mailbox is watched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WatchKind {
    /// IMAP IDLE on the inbox. `secret` is sealed.
    Imap { config: AccountConfig, secret: String },
    /// JMAP EventSource. `secret` is sealed.
    Jmap { config: AccountConfig, secret: String },
    /// Outlook pushes to us: the device holds a Graph subscription whose
    /// notification URL is `/graph/{hook}`, and Graph echoes `client_state`.
    Graph { hook: String, client_state: String },
}

impl WatchKind {
    pub fn name(&self) -> &'static str {
        match self {
            WatchKind::Imap { .. } => "imap",
            WatchKind::Jmap { .. } => "jmap",
            WatchKind::Graph { .. } => "graph",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// Unix seconds of the last change the server reported.
    pub last_change: Option<i64>,
    /// Unix seconds of the last push sent for this mailbox.
    pub last_push: Option<i64>,
    /// Why watching stopped or keeps failing, in plain words.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watch {
    #[serde(flatten)]
    pub kind: WatchKind,
    #[serde(default)]
    pub status: WatchStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub target: Target,
    /// Keyed by the device's opaque name for the account (never its address).
    #[serde(default)]
    pub watches: BTreeMap<String, Watch>,
    pub created_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    devices: BTreeMap<String, Device>,
}

pub struct Store {
    path: Option<PathBuf>,
    data: Mutex<Data>,
}

impl Store {
    /// Loads `dir/relay.json`, or starts empty.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
        let path = dir.join("relay.json");
        let data = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{} is damaged: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(e) => return Err(format!("can't read {}: {e}", path.display())),
        };
        Ok(Self { path: Some(path), data: Mutex::new(data) })
    }

    /// For tests: nothing written to disk.
    pub fn in_memory() -> Self {
        Self { path: None, data: Mutex::new(Data::default()) }
    }

    fn save(&self, data: &Data) {
        let Some(path) = &self.path else { return };
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(data).expect("relay data serializes");
        let written = std::fs::write(&tmp, json).and_then(|_| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&tmp, path)
        });
        if let Err(e) = written {
            eprintln!("push-relay: couldn't save {}: {e}", path.display());
        }
    }

    /// Reads under the lock.
    pub fn read<T>(&self, f: impl FnOnce(&BTreeMap<String, Device>) -> T) -> T {
        f(&self.data.lock().expect("store lock").devices)
    }

    /// Changes under the lock, then saves.
    pub fn write<T>(&self, f: impl FnOnce(&mut BTreeMap<String, Device>) -> T) -> T {
        let mut data = self.data.lock().expect("store lock");
        let out = f(&mut data.devices);
        self.save(&data);
        out
    }

    pub fn device(&self, id: &str) -> Option<Device> {
        self.read(|d| d.get(id).cloned())
    }

    /// Updates one watch's status (not saved on every push: status is advisory).
    pub fn status(&self, device: &str, account: &str, f: impl FnOnce(&mut WatchStatus)) {
        let mut data = self.data.lock().expect("store lock");
        if let Some(w) = data.devices.get_mut(device).and_then(|d| d.watches.get_mut(account)) {
            f(&mut w.status);
        }
    }

    /// The device and account a Graph hook belongs to.
    pub fn graph_hook(&self, hook: &str) -> Option<(String, String, String)> {
        self.read(|devices| {
            devices.iter().find_map(|(id, d)| {
                d.watches.iter().find_map(|(acct, w)| match &w.kind {
                    WatchKind::Graph { hook: h, client_state } if crate::crypto::same(h, hook) => Some((id.clone(), acct.clone(), client_state.clone())),
                    _ => None,
                })
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_reloads() {
        let dir = std::env::temp_dir().join(format!("relay-store-{}", uuid::Uuid::new_v4()));
        let s = Store::open(&dir).unwrap();
        s.write(|d| {
            d.insert("dev1".into(), Device { target: Target::UnifiedPush { endpoint: "https://ntfy.sh/x".into() }, watches: BTreeMap::new(), created_at: 1 });
        });
        let again = Store::open(&dir).unwrap();
        assert_eq!(again.device("dev1").unwrap().target.platform(), "unifiedpush");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("relay.json")).unwrap().permissions().mode() & 0o777, 0o600, "only the relay's user can read it");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
