//! Network adapters: IMAP sync and SMTP send.
//!
//! These functions take config plus a password and return plain data. They
//! never touch the [`Store`](crate::Store), so a shell can run them without
//! holding the database lock across a network round-trip.

use std::{fmt::Debug, sync::Arc, time::Duration};

use async_imap::types::{Flag, NameAttribute};
use futures::TryStreamExt;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, header::ContentType},
    transport::smtp::authentication::Credentials,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::{TlsConnector, rustls};

use crate::{
    AccountConfig, Address, Draft, Error, FetchedMessage, OpKind, PendingOp, Provider, Result,
    Security, ServerConfig, SyncBatch, SyncCursor,
};

/// The first sync of a mailbox fetches only the newest messages. Older mail
/// stays on the server until we add backfill (Phase 1b).
pub const INITIAL_SYNC_LIMIT: usize = 500;
const FETCH_CHUNK: usize = 50;
const TIMEOUT: Duration = Duration::from_secs(30);

pub const INBOX: &str = "INBOX";

trait Io: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> Io for T {}

type Session = async_imap::Session<Box<dyn Io>>;

// ── Connecting ───────────────────────────────────────────────────────────

fn is_local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn tls_connector() -> TlsConnector {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

async fn timed<T>(what: &str, f: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(TIMEOUT, f)
        .await
        .map_err(|_| Error::Network(format!("{what} timed out")))?
}

async fn imap_session(server: &ServerConfig, username: &str, password: &str) -> Result<Session> {
    // Refuse insecure settings before opening any connection.
    match server.security {
        Security::Plain if !is_local(&server.host) => {
            return Err(Error::Invalid(
                "unencrypted connections are only allowed to this computer (localhost)".into(),
            ));
        }
        Security::StartTls => {
            return Err(Error::Invalid("for incoming mail, use SSL/TLS (usually port 993)".into()));
        }
        _ => {}
    }
    let tcp = timed("connecting to the mail server", async {
        TcpStream::connect((server.host.as_str(), server.port))
            .await
            .map_err(|e| Error::Network(format!("{}:{} — {e}", server.host, server.port)))
    })
    .await?;

    let stream: Box<dyn Io> = match server.security {
        Security::Tls => {
            let name = rustls::pki_types::ServerName::try_from(server.host.clone())
                .map_err(|_| Error::Invalid(format!("“{}” isn't a valid server name", server.host)))?;
            let tls = tls_connector()
                .connect(name, tcp)
                .await
                .map_err(|e| Error::Network(format!("secure connection failed: {e}")))?;
            Box::new(tls)
        }
        Security::Plain | Security::StartTls => Box::new(tcp),
    };

    let mut client = async_imap::Client::new(stream);
    // Servers speak first; the greeting must be consumed before LOGIN.
    timed("waiting for the server greeting", async {
        client
            .read_response()
            .await
            .map_err(|e| Error::Network(e.to_string()))?
            .ok_or_else(|| Error::Network("the server closed the connection".into()))
    })
    .await?;
    timed("signing in", async {
        client.login(username, password).await.map_err(|(e, _)| Error::Auth(e.to_string()))
    })
    .await
}

fn imap_err(e: async_imap::error::Error) -> Error {
    Error::Network(e.to_string())
}

/// Check that the account's incoming and outgoing servers accept these
/// credentials. Used before saving a new account.
pub async fn verify(config: &AccountConfig, password: &str) -> Result<()> {
    let mut session = imap_session(&config.imap, &config.username, password).await?;
    let _ = session.logout().await;
    let smtp = smtp_transport(&config.smtp, &config.username, password)?;
    let ok = timed("checking outgoing mail", async {
        smtp.test_connection().await.map_err(|e| Error::Network(e.to_string()))
    })
    .await?;
    if !ok {
        return Err(Error::Network("the outgoing mail server didn't answer".into()));
    }
    Ok(())
}

// ── Sync ─────────────────────────────────────────────────────────────────

/// One sync pass of INBOX: push local changes, then pull new mail and flags.
pub async fn sync_inbox(
    config: &AccountConfig,
    password: &str,
    cursor: SyncCursor,
    ops: &[PendingOp],
) -> Result<SyncBatch> {
    let mut session = imap_session(&config.imap, &config.username, password).await?;
    let result = sync_with(&mut session, cursor, ops).await;
    let _ = session.logout().await;
    result
}

async fn sync_with(session: &mut Session, cursor: SyncCursor, ops: &[PendingOp]) -> Result<SyncBatch> {
    let mailbox = session.select(INBOX).await.map_err(imap_err)?;
    let uid_validity = mailbox
        .uid_validity
        .ok_or_else(|| Error::Network("the server didn't report UIDVALIDITY".into()))?;
    let same_mailbox = cursor.uid_validity == Some(uid_validity);

    // Push local changes first, so the flags we read back include them.
    // After a UIDVALIDITY change the queued UIDs point at the wrong messages.
    let mut applied_ops = Vec::new();
    if same_mailbox && !ops.is_empty() {
        let archive = special_mailbox(session, NameAttribute::Archive).await?;
        for op in ops {
            push_op(session, op, archive.as_deref()).await?;
            applied_ops.push(op.id);
        }
    }

    let mut server_uids: Vec<u32> = session.uid_search("ALL").await.map_err(imap_err)?.into_iter().collect();
    server_uids.sort_unstable();

    let last_uid = if same_mailbox { cursor.last_uid } else { 0 };
    let mut wanted: Vec<u32> = server_uids.iter().copied().filter(|u| *u > last_uid).collect();
    if last_uid == 0 && wanted.len() > INITIAL_SYNC_LIMIT {
        wanted = wanted.split_off(wanted.len() - INITIAL_SYNC_LIMIT);
    }

    let mut new_messages = Vec::with_capacity(wanted.len());
    for chunk in wanted.chunks(FETCH_CHUNK) {
        let set = chunk.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetches: Vec<_> = session
            .uid_fetch(&set, "(UID FLAGS BODY.PEEK[])")
            .await
            .map_err(imap_err)?
            .try_collect()
            .await
            .map_err(imap_err)?;
        for f in fetches {
            let (Some(uid), Some(body)) = (f.uid, f.body()) else { continue };
            let (seen, flagged) = flags_of(&f);
            new_messages.push(FetchedMessage { uid, seen, flagged, raw: body.to_vec() });
        }
    }

    // Flags for mail we already have. Fine for mailboxes of a few thousand;
    // CONDSTORE (RFC 7162) will make this incremental later.
    let mut flags = Vec::new();
    if last_uid > 0 {
        let fetches: Vec<_> = session
            .uid_fetch(format!("1:{last_uid}"), "(UID FLAGS)")
            .await
            .map_err(imap_err)?
            .try_collect()
            .await
            .map_err(imap_err)?;
        for f in fetches {
            if let Some(uid) = f.uid {
                let (seen, flagged) = flags_of(&f);
                flags.push((uid, seen, flagged));
            }
        }
    }

    Ok(SyncBatch { mailbox: INBOX.into(), uid_validity, new_messages, flags, server_uids, applied_ops })
}

fn flags_of(f: &async_imap::types::Fetch) -> (bool, bool) {
    let mut seen = false;
    let mut flagged = false;
    for flag in f.flags() {
        match flag {
            Flag::Seen => seen = true,
            Flag::Flagged => flagged = true,
            _ => {}
        }
    }
    (seen, flagged)
}

async fn push_op(session: &mut Session, op: &PendingOp, archive: Option<&str>) -> Result<()> {
    let store = |change: &'static str| format!("{change}FLAGS.SILENT");
    let (query, flag) = match op.kind {
        OpKind::Seen(on) => (store(if on { "+" } else { "-" }), "\\Seen"),
        OpKind::Flagged(on) => (store(if on { "+" } else { "-" }), "\\Flagged"),
        OpKind::Archive => {
            // No \Archive mailbox on this server: archiving stays local-only.
            if let Some(target) = archive {
                session.uid_mv(op.uid.to_string(), target).await.map_err(imap_err)?;
            }
            return Ok(());
        }
    };
    let _: Vec<_> = session
        .uid_store(op.uid.to_string(), format!("{query} ({flag})"))
        .await
        .map_err(imap_err)?
        .try_collect()
        .await
        .map_err(imap_err)?;
    Ok(())
}

/// Find a special-use mailbox (RFC 6154), e.g. the server's Archive or Sent.
async fn special_mailbox(session: &mut Session, wanted: NameAttribute<'static>) -> Result<Option<String>> {
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .map_err(imap_err)?
        .try_collect()
        .await
        .map_err(imap_err)?;
    Ok(names
        .iter()
        .find(|n| n.attributes().contains(&wanted))
        .map(|n| n.name().to_owned()))
}

// ── Send ─────────────────────────────────────────────────────────────────

fn smtp_transport(
    server: &ServerConfig,
    username: &str,
    password: &str,
) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let creds = Credentials::new(username.to_owned(), password.to_owned());
    let builder = match server.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&server.host),
        Security::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&server.host),
        Security::Plain if is_local(&server.host) => {
            Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&server.host))
        }
        Security::Plain => {
            return Err(Error::Invalid(
                "unencrypted connections are only allowed to this computer (localhost)".into(),
            ));
        }
    }
    .map_err(|e| Error::Network(e.to_string()))?;
    Ok(builder.port(server.port).credentials(creds).timeout(Some(TIMEOUT)).build())
}

fn mailbox(a: &Address) -> Result<Mailbox> {
    let email = a
        .email
        .trim()
        .parse()
        .map_err(|_| Error::Invalid(format!("“{}” isn't an email address", a.email)))?;
    Ok(Mailbox::new(a.name.clone().filter(|n| !n.trim().is_empty()), email))
}

/// Build the RFC 5322 message for a draft.
pub fn build_message(config: &AccountConfig, draft: &Draft) -> Result<Message> {
    let from = mailbox(&Address { name: Some(config.display_name.clone()), email: config.address.clone() })?;
    let mut b = Message::builder().from(from).subject(draft.subject.clone());
    for to in &draft.to {
        b = b.to(mailbox(to)?);
    }
    for cc in &draft.cc {
        b = b.cc(mailbox(cc)?);
    }
    if let Some(id) = &draft.in_reply_to {
        let id = format!("<{}>", id.trim_matches(['<', '>']));
        b = b.in_reply_to(id.clone()).references(id);
    }
    b.header(ContentType::TEXT_PLAIN)
        .body(draft.body.clone())
        .map_err(|e| Error::Invalid(e.to_string()))
}

/// Send a draft, then file a copy in the server's Sent mailbox.
///
/// Gmail and Microsoft file sent mail themselves, so we skip the copy there
/// to avoid duplicates. Returns the raw message that was sent.
pub async fn send(config: &AccountConfig, password: &str, draft: &Draft) -> Result<Vec<u8>> {
    let message = build_message(config, draft)?;
    let raw = message.formatted();
    let smtp = smtp_transport(&config.smtp, &config.username, password)?;
    timed("sending", async {
        smtp.send(message).await.map(|_| ()).map_err(|e| {
            if e.is_permanent() {
                Error::Auth(e.to_string())
            } else {
                Error::Network(e.to_string())
            }
        })
    })
    .await?;

    if !matches!(config.provider, Provider::Google | Provider::Microsoft) {
        // The message is already sent; a failed Sent copy must not report failure.
        if let Ok(mut session) = imap_session(&config.imap, &config.username, password).await {
            if let Ok(Some(sent)) = special_mailbox(&mut session, NameAttribute::Sent).await {
                let _ = session.append(&sent, Some("(\\Seen)"), None, &raw).await;
            }
            let _ = session.logout().await;
        }
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AccountConfig {
        let server = ServerConfig { host: "mail.example.com".into(), port: 993, security: Security::Tls };
        AccountConfig {
            display_name: "Sean".into(),
            address: "sean@example.com".into(),
            username: "sean".into(),
            provider: Provider::Generic,
            imap: server.clone(),
            smtp: ServerConfig { port: 465, ..server },
        }
    }

    #[test]
    fn builds_a_threaded_reply() {
        let draft = Draft {
            account_id: "a".into(),
            to: vec![Address { name: Some("Ana".into()), email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Re: Photos".into(),
            body: "Love them".into(),
            in_reply_to: Some("abc@example.com".into()),
        };
        let raw = String::from_utf8(build_message(&config(), &draft).unwrap().formatted()).unwrap();
        assert!(raw.contains("From: Sean <sean@example.com>"));
        assert!(raw.contains("To: Ana <ana@example.com>"));
        assert!(raw.contains("In-Reply-To: <abc@example.com>"));
        assert!(raw.contains("References: <abc@example.com>"));
        // Round-trips through our own parser.
        let parsed = crate::mime::parse(raw.as_bytes()).unwrap();
        assert_eq!(parsed.subject, "Re: Photos");
        assert_eq!(parsed.body_text.trim(), "Love them");
    }

    #[test]
    fn rejects_bad_recipients() {
        let draft = Draft {
            account_id: "a".into(),
            to: vec![Address { name: None, email: "nope".into() }],
            cc: vec![],
            subject: String::new(),
            body: String::new(),
            in_reply_to: None,
        };
        assert!(matches!(build_message(&config(), &draft), Err(Error::Invalid(_))));
    }

    #[tokio::test]
    async fn refuses_plaintext_to_remote_hosts() {
        let server = ServerConfig { host: "mail.example.com".into(), port: 143, security: Security::Plain };
        let err = imap_session(&server, "u", "p").await.unwrap_err();
        assert!(matches!(err, Error::Invalid(_)));
        assert!(smtp_transport(&server, "u", "p").is_err());
    }
}
