//! The shared identity (ADR-0050): the locked-notes key, wrapped as
//! Mailbird's App Data Key under the default persona, so the identity's
//! recovery kit reaches locked notes.
//!
//! The passphrase stays the way in. This only adds a second one: after every
//! passphrase unlock (or change) the key is wrapped under the identity, if it
//! isn't already, and the identity can then hand it back. The notes are never
//! moved or resealed for it. Off unless the host turns it on (the desktop
//! shell does; the web gateway, which is a server, doesn't).

use std::path::PathBuf;

use ecosystem_identity::{AppDataKey, Attach, FileKeystore, Head, Id, Identity, KeyRefKind, PersonaKind, Purpose, SymmetricKey};
use pim_core::NotesKey;
use serde::{Deserialize, Serialize};

use crate::Shared;
use crate::commands::with_store;

/// This app's id in the identity.
pub const APP_ID: &str = "mailbird";
/// Where this device remembers which envelope holds the key. Local only: the
/// identity itself is the truth, this is a shortcut to it.
const LINK: &str = "notes.identity";

/// Where the identity lives on this device, and this device's own keys.
#[derive(Debug, Clone)]
pub struct IdentityConfig {
    /// The identity store every ecosystem app on the device shares.
    pub root: PathBuf,
    /// This device's keystore file. A file for now; Secure Enclave, StrongBox,
    /// and TPM keystores come with the device work (ADR-0050).
    pub keystore: PathBuf,
    /// What the identity calls this device.
    pub device_name: String,
}

/// Which envelope holds the notes key, and the newest identity head this
/// device has seen (so a store rolled back behind it is refused).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    persona_id: Id,
    key_id: Id,
    head_seq: u64,
    head_hash: String,
}

/// The desktop setup: the identity in the place every ecosystem app on this
/// computer looks for it, this device's keys in Mailbird's own data folder.
/// `None` where the platform has no default (phones pass their shared
/// container path instead, once the device work lands).
pub fn desktop_config(data_dir: &std::path::Path) -> Option<IdentityConfig> {
    let root = ecosystem_identity::default_root().ok()?;
    Some(IdentityConfig { root, keystore: data_dir.join("identity-device.key"), device_name: "Mailbird".into() })
}

fn config(state: &Shared) -> Option<IdentityConfig> {
    state.identity.lock().ok().and_then(|c| c.clone())
}

fn link(state: &Shared) -> Option<Link> {
    with_store(state, |s| s.setting(LINK)).ok().flatten().and_then(|v| serde_json::from_str(&v).ok())
}

fn save_link(state: &Shared, persona_id: Id, key_id: Id, head: Head) -> Result<(), String> {
    let l = Link { persona_id, key_id, head_seq: head.seq, head_hash: hex(&head.hash) };
    let v = serde_json::to_string(&l).map_err(|e| e.to_string())?;
    with_store(state, |s| s.set_setting(LINK, Some(&v)))
}

fn remembered(l: &Option<Link>) -> Option<Head> {
    let l = l.as_ref()?;
    let mut hash = [0u8; 32];
    for (i, b) in hash.iter_mut().enumerate() {
        *b = u8::from_str_radix(l.head_hash.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(Head { seq: l.head_seq, hash })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn keystore(cfg: &IdentityConfig) -> Result<FileKeystore, String> {
    FileKeystore::open_or_create(&cfg.keystore).map_err(|e| format!("couldn't open this device's keys: {e}"))
}

/// The persona Mailbird keeps its key under: the one every identity starts with.
fn persona(identity: &Identity) -> Result<Id, String> {
    identity
        .personas()
        .find(|p| p.kind == PersonaKind::Personal)
        .or_else(|| identity.personas().next())
        .map(|p| p.persona_id)
        .ok_or_else(|| "the identity has no persona".to_string())
}

/// Whether this device can try the identity: it's turned on, and either this
/// device linked the key before or an identity is already here (one restored
/// from the recovery kit, say). Cheap: it doesn't open the identity.
pub fn available(state: &Shared) -> bool {
    let Some(cfg) = config(state) else { return false };
    link(state).is_some() || ecosystem_identity::Store::at(&cfg.root).probe().is_ok_and(|p| p == ecosystem_identity::store::Probe::Present)
}

/// Wraps `key` under the identity, creating the identity if there's none,
/// unless the remembered envelope already holds this exact key.
pub fn link_notes_key(state: &Shared, key: &NotesKey) -> Result<(), String> {
    let Some(cfg) = config(state) else { return Ok(()) };
    let ks = keystore(&cfg)?;
    let known = link(state);
    let mut identity = Identity::open_or_create(&cfg.root, APP_ID, &cfg.device_name, &ks, remembered(&known)).map_err(|e| e.to_string())?;
    let persona_id = persona(&identity)?;
    if let Some(l) = &known
        && l.persona_id == persona_id
        && identity.unwrap_app_key(l.persona_id, l.key_id).is_ok_and(|k| k.expose() == key.expose_bytes())
    {
        return save_link(state, l.persona_id, l.key_id, identity.head());
    }
    let key_id = identity.wrap_app_key(persona_id, &AppDataKey::from_bytes(*key.expose_bytes())).map_err(|e| e.to_string())?;
    save_link(state, persona_id, key_id, identity.head())
}

/// [`link_notes_key`], logged instead of failing: the passphrase already
/// opened the notes, and that mustn't depend on the identity.
pub fn link_quietly(state: &Shared, key: &NotesKey) {
    if let Err(e) = link_notes_key(state, key) {
        log::info!("couldn't keep the notes key in the identity: {e}");
    }
}

/// The notes key, from the identity instead of the passphrase. Tries the
/// envelope this device remembers, then every app key under every persona
/// the identity holds (a device restored from the kit remembers none), and
/// keeps the first one that opens this device's notes.
pub fn unlock_with_identity(state: &Shared) -> Result<NotesKey, String> {
    let cfg = config(state).ok_or_else(|| "this device doesn't use a shared identity".to_string())?;
    let ks = keystore(&cfg)?;
    let known = link(state);
    let identity = match Identity::attach(&cfg.root, APP_ID, &ks, remembered(&known)).map_err(|e| e.to_string())? {
        Attach::Attached(i) => *i,
        Attach::Nothing => return Err("there's no identity on this device yet: unlock with the passphrase once".into()),
        Attach::NotEnrolled { .. } => return Err("this device isn't part of your identity yet".into()),
    };
    let mut candidates: Vec<(Id, Id)> = known.iter().map(|l| (l.persona_id, l.key_id)).collect();
    candidates.extend(
        identity
            .envelopes()
            .filter(|e| e.purpose == Purpose::AppData && e.wrapped_by.kind == KeyRefKind::Persona)
            .map(|e| (e.wrapped_by.id, e.key_id))
            .filter(|c| known.as_ref().is_none_or(|l| (l.persona_id, l.key_id) != *c)),
    );
    for (persona_id, key_id) in candidates {
        let Ok(k) = identity.unwrap_app_key(persona_id, key_id) else { continue };
        let key = NotesKey::from_bytes(*k.expose());
        if with_store(state, |s| s.verify_notes_key(&key)).is_ok() {
            save_link(state, persona_id, key_id, identity.head())?;
            return Ok(key);
        }
    }
    Err("your identity doesn't hold the key for these notes: unlock with the passphrase once".into())
}
