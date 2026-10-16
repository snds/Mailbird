//! The on-disk layout (spec §5) and the checks a reader runs before it
//! trusts anything in it (spec §6 step 2).
//!
//! ```text
//! <identity-root>/
//!   FORMAT                              "ecosystem-identity/1"
//!   profile.cbor
//!   personas/<persona_id>.cbor
//!   devices/<device_id>.cbor
//!   envelopes/<key_id>.<kind>.<id>.cbor
//!   consents/<bridge>.<version>.cbor
//!   manifest.cbor                       signed, hash-chained list of all of the above
//! ```
//!
//! Loading verifies the manifest's signature, every record's signature,
//! every file's hash against the manifest, and that nothing is on disk the
//! manifest does not list. A rollback is caught one level up, by comparing
//! the manifest head with the one this device last accepted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::records::{
    Consent, Device, KeyEnvelope, Manifest, ManifestEntry, Persona, Profile, RECORD_V, Record,
    Timestamp,
};
use crate::{Error, Id, Result};

/// The store format this crate writes.
pub const FORMAT: &str = "ecosystem-identity/1";
/// The highest format major this crate reads.
pub const FORMAT_MAJOR: u16 = 1;
/// The Apple App Group every ecosystem app declares (D15).
pub const APPLE_APP_GROUP: &str = "group.design.snds.identity";
/// The folder under the platform's local data directory on Windows and Linux (D15).
pub const SHARED_FOLDER: &str = "snds/identity";

const FORMAT_FILE: &str = "FORMAT";
const PROFILE_FILE: &str = "profile.cbor";
const MANIFEST_FILE: &str = "manifest.cbor";
const PERSONAS_DIR: &str = "personas";
const DEVICES_DIR: &str = "devices";
const ENVELOPES_DIR: &str = "envelopes";
const CONSENTS_DIR: &str = "consents";

/// Where the identity lives on this platform (spec §5). Apps never hardcode
/// this. Android and iOS need the platform's own container APIs, which this
/// build does not call; they return an error until a shell supplies the path.
pub fn default_root() -> Result<PathBuf> {
    if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| Error::Unsupported("no home directory".into()))?;
        Ok(PathBuf::from(home)
            .join("Library/Group Containers")
            .join(APPLE_APP_GROUP))
    } else if cfg!(target_os = "windows") {
        let local = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| Error::Unsupported("no %LOCALAPPDATA%".into()))?;
        Ok(PathBuf::from(local).join("snds").join("identity"))
    } else if cfg!(any(target_os = "ios", target_os = "android")) {
        Err(Error::Unsupported(
            "the shell must pass the shared container path on this platform".into(),
        ))
    } else {
        let data = match std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
            Some(v) => PathBuf::from(v),
            None => PathBuf::from(
                std::env::var_os("HOME")
                    .ok_or_else(|| Error::Unsupported("no home directory".into()))?,
            )
            .join(".local/share"),
        };
        Ok(data.join("snds").join("identity"))
    }
}

/// What a probe of a root finds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Probe {
    /// No `FORMAT` file: nothing is here.
    Missing,
    /// A store this crate can read.
    Present,
}

/// The newest manifest a device accepted: its sequence and hash. Keep it;
/// hand it back on the next attach to catch a rollback.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Head {
    /// The manifest's `seq`.
    pub seq: u64,
    /// SHA-256 of the manifest file.
    pub hash: [u8; 32],
}

/// Every record in a store, decoded and verified.
#[derive(Clone, Debug, Default)]
pub struct Contents {
    /// The one profile.
    pub profile: Option<Profile>,
    /// Personas by id.
    pub personas: BTreeMap<Id, Persona>,
    /// Devices by id.
    pub devices: BTreeMap<Id, Device>,
    /// Envelopes by file name.
    pub envelopes: BTreeMap<String, KeyEnvelope>,
    /// Consents by file name.
    pub consents: BTreeMap<String, Consent>,
}

impl Contents {
    /// The profile, or an error if the store has none.
    pub fn profile(&self) -> Result<&Profile> {
        self.profile
            .as_ref()
            .ok_or_else(|| Error::Decode("the store has no profile".into()))
    }

    /// Adds or replaces an envelope under its file name.
    pub fn put_envelope(&mut self, envelope: KeyEnvelope) {
        self.envelopes.insert(envelope.file_name(), envelope);
    }
}

/// What a load gives back.
#[derive(Debug)]
pub struct Loaded {
    /// The records.
    pub contents: Contents,
    /// The manifest as read.
    pub manifest: Manifest,
    /// Its head.
    pub head: Head,
}

/// A store at one root.
#[derive(Clone, Debug)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// A store at `root`. Nothing is read yet.
    pub fn at(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    /// The root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Reads `FORMAT`. Refuses a newer major with a message that says so.
    pub fn probe(&self) -> Result<Probe> {
        let path = self.root.join(FORMAT_FILE);
        if !path.exists() {
            return Ok(Probe::Missing);
        }
        let text = std::fs::read_to_string(&path)?;
        let text = text.trim();
        let Some(major) = text.strip_prefix("ecosystem-identity/") else {
            return Err(Error::FormatUnknown(text.to_string()));
        };
        let major: u16 = major
            .parse()
            .map_err(|_| Error::FormatUnknown(text.to_string()))?;
        if major == 0 {
            return Err(Error::FormatUnknown(text.to_string()));
        }
        if major > FORMAT_MAJOR {
            return Err(Error::FormatTooNew {
                found: major,
                supported: FORMAT_MAJOR,
            });
        }
        Ok(Probe::Present)
    }

    /// Whether the root has nothing in it (so a recovery can start there).
    pub fn is_empty(&self) -> Result<bool> {
        if !self.root.exists() {
            return Ok(true);
        }
        Ok(std::fs::read_dir(&self.root)?.next().is_none())
    }

    /// Creates the root and writes `FORMAT`. The first step of a create.
    pub fn init(&self) -> Result<()> {
        if self.probe()? == Probe::Present {
            return Err(Error::Invalid(format!(
                "an identity already exists at {}",
                self.root.display()
            )));
        }
        create_private_dir(&self.root)?;
        for dir in [PERSONAS_DIR, DEVICES_DIR, ENVELOPES_DIR, CONSENTS_DIR] {
            create_private_dir(&self.root.join(dir))?;
        }
        write_private(
            &self.root.join(FORMAT_FILE),
            format!("{FORMAT}\n").as_bytes(),
        )
    }

    /// Reads and verifies everything.
    pub fn load(&self) -> Result<Loaded> {
        if self.probe()? == Probe::Missing {
            return Err(Error::NoIdentity(self.root.display().to_string()));
        }
        let manifest_bytes = std::fs::read(self.root.join(MANIFEST_FILE))
            .map_err(|_| Error::Tampered("the manifest is missing".into()))?;
        let manifest = Manifest::from_bytes(&manifest_bytes)?;
        let profile_bytes = std::fs::read(self.root.join(PROFILE_FILE))
            .map_err(|_| Error::Tampered("the profile is missing".into()))?;
        let profile = Profile::from_bytes(&profile_bytes)?;
        let isk = VerifyingKey::from_bytes(&profile.isk_pub)
            .map_err(|_| Error::BadSignature("profile (its signing key is malformed)".into()))?;
        manifest.verify(&isk)?;
        profile.verify(&isk)?;
        if profile.format_v > FORMAT_MAJOR {
            return Err(Error::FormatTooNew {
                found: profile.format_v,
                supported: FORMAT_MAJOR,
            });
        }
        profile.kdf.check_floor()?;

        let mut contents = Contents::default();
        let mut listed = std::collections::BTreeSet::new();
        for entry in &manifest.entries {
            if !listed.insert(entry.path.clone()) {
                return Err(Error::Tampered(format!("{} is listed twice", entry.path)));
            }
            let (dir, name) = split_path(&entry.path)?;
            let bytes = if entry.path == PROFILE_FILE {
                profile_bytes.clone()
            } else {
                std::fs::read(self.root.join(&entry.path))
                    .map_err(|_| Error::Tampered(format!("{} is missing", entry.path)))?
            };
            if sha256(&bytes).as_slice() != entry.hash.as_slice() {
                return Err(Error::Tampered(format!("{} was changed", entry.path)));
            }
            match dir {
                "" if name == PROFILE_FILE => {
                    check_version(entry, profile.v)?;
                    contents.profile = Some(profile.clone());
                }
                PERSONAS_DIR => {
                    let r = Persona::from_bytes(&bytes)?;
                    r.verify(&isk)?;
                    check_version(entry, r.v)?;
                    check_name(entry, &format!("{}.cbor", r.persona_id))?;
                    contents.personas.insert(r.persona_id, r);
                }
                DEVICES_DIR => {
                    let r = Device::from_bytes(&bytes)?;
                    r.verify(&isk)?;
                    check_version(entry, r.v)?;
                    check_name(entry, &format!("{}.cbor", r.device_id))?;
                    contents.devices.insert(r.device_id, r);
                }
                ENVELOPES_DIR => {
                    let r = KeyEnvelope::from_bytes(&bytes)?;
                    r.verify(&isk)?;
                    check_version(entry, r.v)?;
                    check_name(entry, &r.file_name())?;
                    contents.envelopes.insert(r.file_name(), r);
                }
                CONSENTS_DIR => {
                    let r = Consent::from_bytes(&bytes)?;
                    r.verify(&isk)?;
                    check_version(entry, r.v)?;
                    check_name(entry, &r.file_name())?;
                    contents.consents.insert(r.file_name(), r);
                }
                _ => {
                    return Err(Error::Tampered(format!(
                        "{} isn't a place records live",
                        entry.path
                    )));
                }
            }
        }
        if contents.profile.is_none() {
            return Err(Error::Tampered(
                "the manifest doesn't list the profile".into(),
            ));
        }
        for path in self.record_files()? {
            if !listed.contains(&path) {
                return Err(Error::Tampered(format!("{path} isn't in the manifest")));
            }
        }
        let head = Head {
            seq: manifest.seq,
            hash: sha256(&manifest_bytes),
        };
        Ok(Loaded {
            contents,
            manifest,
            head,
        })
    }

    /// Writes every record, removes files no longer in `contents`, and
    /// writes a new manifest chained to the one on disk and signed by `isk`.
    /// The records themselves must already be signed.
    pub fn write(
        &self,
        contents: &Contents,
        isk: &SigningKey,
        written_by: Id,
    ) -> Result<(Manifest, Head)> {
        let profile = contents.profile()?;
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        files.insert(PROFILE_FILE.into(), profile.to_bytes()?);
        for p in contents.personas.values() {
            files.insert(
                format!("{PERSONAS_DIR}/{}.cbor", p.persona_id),
                p.to_bytes()?,
            );
        }
        for d in contents.devices.values() {
            files.insert(format!("{DEVICES_DIR}/{}.cbor", d.device_id), d.to_bytes()?);
        }
        for (name, e) in &contents.envelopes {
            files.insert(format!("{ENVELOPES_DIR}/{name}"), e.to_bytes()?);
        }
        for (name, c) in &contents.consents {
            files.insert(format!("{CONSENTS_DIR}/{name}"), c.to_bytes()?);
        }

        let (seq, prev) = match std::fs::read(self.root.join(MANIFEST_FILE)) {
            Ok(old) => (Manifest::from_bytes(&old)?.seq + 1, sha256(&old).to_vec()),
            Err(_) => (1, Vec::new()),
        };

        for (path, bytes) in &files {
            write_private(&self.root.join(path), bytes)?;
        }
        for stale in self
            .record_files()?
            .into_iter()
            .filter(|p| !files.contains_key(p))
        {
            std::fs::remove_file(self.root.join(&stale))?;
        }

        let entries = files
            .iter()
            .map(|(path, bytes)| ManifestEntry {
                path: path.clone(),
                hash: sha256(bytes).to_vec(),
                version: RECORD_V,
            })
            .collect();
        let mut manifest = Manifest {
            v: RECORD_V,
            seq,
            prev,
            entries,
            written_at: Timestamp::now(),
            written_by,
            extra: Default::default(),
            sig: Vec::new(),
        };
        manifest.sign(isk)?;
        let bytes = manifest.to_bytes()?;
        write_private(&self.root.join(MANIFEST_FILE), &bytes)?;
        Ok((
            manifest,
            Head {
                seq,
                hash: sha256(&bytes),
            },
        ))
    }

    /// Every record file on disk, as manifest paths.
    fn record_files(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        if self.root.join(PROFILE_FILE).exists() {
            out.push(PROFILE_FILE.to_string());
        }
        for dir in [PERSONAS_DIR, DEVICES_DIR, ENVELOPES_DIR, CONSENTS_DIR] {
            let Ok(read) = std::fs::read_dir(self.root.join(dir)) else {
                continue;
            };
            for entry in read {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".cbor") {
                    out.push(format!("{dir}/{name}"));
                }
            }
        }
        out.sort();
        Ok(out)
    }
}

fn check_version(entry: &ManifestEntry, v: u16) -> Result<()> {
    if entry.version == v {
        Ok(())
    } else {
        Err(Error::Tampered(format!(
            "{} isn't the version the manifest says",
            entry.path
        )))
    }
}

fn check_name(entry: &ManifestEntry, expected: &str) -> Result<()> {
    if entry.path.rsplit('/').next() == Some(expected) {
        Ok(())
    } else {
        Err(Error::Tampered(format!(
            "{} holds a record that belongs at {expected}",
            entry.path
        )))
    }
}

fn split_path(path: &str) -> Result<(&str, &str)> {
    if path.contains("..") || path.starts_with('/') || path.contains('\\') {
        return Err(Error::Tampered(format!(
            "{path} isn't a path inside the store"
        )));
    }
    Ok(match path.split_once('/') {
        Some((dir, name)) if !name.contains('/') => (dir, name),
        Some(_) => return Err(Error::Tampered(format!("{path} is nested too deep"))),
        None => ("", path),
    })
}

/// SHA-256 of some bytes.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn create_private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes a file readable only by the user, through a temporary file and a
/// rename, so a crash leaves the old file or the new one, never half of one.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        std::io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}
