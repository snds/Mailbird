//! Team members on the gateway (ADR-0063): people the owner adds so a shared
//! inbox has more than one person working it. Each signs in with their own
//! email and password. They're kept in `members.json` beside the mail
//! database, mode 0600, with passwords as PBKDF2 hashes and invitations as
//! hashes of their one-time codes: the file alone lets nobody in.

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, pbkdf2};
use serde::{Deserialize, Serialize};

/// OWASP's 2023 figure for PBKDF2-HMAC-SHA256.
const ITERATIONS: u32 = 600_000;
/// How long an invitation link works.
pub const INVITE_DAYS: i64 = 7;
/// The shortest password a member may choose.
pub const MIN_PASSWORD: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created: i64,
    /// Set once they've chosen a password.
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    salt: Option<String>,
    /// An unused invitation: the hash of its code, and when it stops working.
    #[serde(default)]
    invite: Option<String>,
    #[serde(default)]
    invite_expires: Option<i64>,
}

impl Member {
    /// Still waiting for them to open their invitation.
    pub fn pending(&self) -> bool {
        self.hash.is_none()
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    SystemRandom::new().fill(&mut b).expect("the OS random source works");
    b
}

fn code_hash(code: &str) -> String {
    STANDARD.encode(digest::digest(&digest::SHA256, code.as_bytes()))
}

fn derive(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(ITERATIONS).expect("non-zero"), salt, password.as_bytes(), &mut out);
    out
}

/// An address as people type it, compared without case.
fn clean_email(email: &str) -> Option<String> {
    let e = email.trim().to_lowercase();
    (e.len() <= 254 && e.split_once('@').is_some_and(|(u, d)| !u.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.'))).then_some(e)
}

pub struct Members {
    path: PathBuf,
    list: Mutex<Vec<Member>>,
}

impl Members {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let list = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{} is damaged: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("can't read {}: {e}", path.display())),
        };
        Ok(Self { path, list: Mutex::new(list) })
    }

    fn save(&self, list: &[Member]) -> Result<(), String> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(list).expect("members serialize")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("couldn't save the team: {e}"))
    }

    pub fn list(&self) -> Vec<Member> {
        self.list.lock().expect("members lock").clone()
    }

    pub fn get(&self, id: &str) -> Option<Member> {
        self.list.lock().expect("members lock").iter().find(|m| m.id == id).cloned()
    }

    /// Adds someone, with an invitation code for them to choose a password.
    pub fn add(&self, name: &str, email: &str) -> Result<(Member, String), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("give them a name, up to 80 characters".into());
        }
        let email = clean_email(email).ok_or("that email address doesn't look complete")?;
        let mut list = self.list.lock().expect("members lock");
        if list.iter().any(|m| m.email == email) {
            return Err(format!("{email} is already on the team"));
        }
        let code = crate::random_token();
        let m = Member {
            id: hex(&random(8)),
            name: name.into(),
            email,
            created: now(),
            hash: None,
            salt: None,
            invite: Some(code_hash(&code)),
            invite_expires: Some(now() + INVITE_DAYS * 86_400),
        };
        list.push(m.clone());
        self.save(&list)?;
        Ok((m, code))
    }

    /// A fresh invitation, for someone who hasn't used theirs or forgot their
    /// password. Their old password stops working once they choose a new one.
    pub fn reinvite(&self, id: &str) -> Result<(Member, String), String> {
        let mut list = self.list.lock().expect("members lock");
        let m = list.iter_mut().find(|m| m.id == id).ok_or("they aren't on the team any more")?;
        let code = crate::random_token();
        m.invite = Some(code_hash(&code));
        m.invite_expires = Some(now() + INVITE_DAYS * 86_400);
        let out = m.clone();
        self.save(&list)?;
        Ok((out, code))
    }

    pub fn remove(&self, id: &str) -> Result<Member, String> {
        let mut list = self.list.lock().expect("members lock");
        let i = list.iter().position(|m| m.id == id).ok_or("they aren't on the team any more")?;
        let m = list.remove(i);
        self.save(&list)?;
        Ok(m)
    }

    /// Opening an invitation: they choose a password, and the code is spent.
    pub fn accept(&self, code: &str, password: &str) -> Result<Member, String> {
        if password.chars().count() < MIN_PASSWORD {
            return Err(format!("choose a password of at least {MIN_PASSWORD} characters"));
        }
        let h = code_hash(code.trim());
        let mut list = self.list.lock().expect("members lock");
        let m = list
            .iter_mut()
            .find(|m| m.invite.as_deref().is_some_and(|i| crate::same(i, &h)))
            .filter(|m| m.invite_expires.is_some_and(|e| e > now()))
            .ok_or("this invitation doesn't work any more. Ask for a new one.")?;
        let salt = random(16);
        m.hash = Some(STANDARD.encode(derive(password, &salt)));
        m.salt = Some(STANDARD.encode(&salt));
        m.invite = None;
        m.invite_expires = None;
        let out = m.clone();
        self.save(&list)?;
        Ok(out)
    }

    /// Who signs in with this email and password, if anyone.
    pub fn check(&self, email: &str, password: &str) -> Option<Member> {
        let email = clean_email(email)?;
        let m = self.list.lock().expect("members lock").iter().find(|m| m.email == email).cloned();
        // An unknown address costs the same as a wrong password, so timing doesn't tell which.
        let salt = m.as_ref().and_then(|m| m.salt.as_deref()).and_then(|s| STANDARD.decode(s).ok()).unwrap_or_else(|| vec![0; 16]);
        let got = STANDARD.encode(derive(password, &salt));
        m.filter(|m| m.hash.as_deref().is_some_and(|h| crate::same(h, &got)))
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invitation_becomes_a_password_once() {
        let dir = std::env::temp_dir().join(format!("members-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("members.json");
        let _ = std::fs::remove_file(&path);
        let team = Members::open(path.clone()).unwrap();
        let (ana, code) = team.add(" Ana ", " Ana@Example.com ").unwrap();
        assert_eq!((ana.name.as_str(), ana.email.as_str(), ana.pending()), ("Ana", "ana@example.com", true));
        assert!(team.add("Ana again", "ana@example.com").is_err(), "one person per address");
        assert!(team.add("", "x@example.com").is_err() && team.add("X", "not-an-address").is_err());
        assert!(team.check("ana@example.com", "anything at all").is_none(), "no password yet");
        assert!(team.accept(&code, "short").is_err(), "too short");
        team.accept(&code, "a long enough password").unwrap();
        assert!(team.accept(&code, "a long enough password").is_err(), "the code is spent");
        assert_eq!(team.check("ANA@example.com", "a long enough password").map(|m| m.id), Some(ana.id.clone()));
        assert!(team.check("ana@example.com", "the wrong password").is_none());
        // Reloaded from disk, with no plain password or code in it.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("a long enough password") && !text.contains(&code));
        let again = Members::open(path).unwrap();
        assert!(again.check("ana@example.com", "a long enough password").is_some());
        let (_, fresh) = again.reinvite(&ana.id).unwrap();
        again.accept(&fresh, "a brand new password!").unwrap();
        assert!(again.check("ana@example.com", "a long enough password").is_none(), "the old password stops working");
        again.remove(&ana.id).unwrap();
        assert!(again.check("ana@example.com", "a brand new password!").is_none());
    }
}
