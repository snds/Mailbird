//! Network adapters: IMAP sync and SMTP send.
//!
//! These functions take config plus a password and return plain data. They
//! never touch the [`Store`](crate::Store), so a shell can run them without
//! holding the database lock across a network round-trip.

use std::{fmt::Debug, sync::Arc, time::Duration};

use async_imap::types::{Flag, NameAttribute};
use futures::TryStreamExt;
use base64::Engine;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType},
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

/// The first sync of a mailbox fetches only the newest messages, so the inbox
/// is usable in seconds. Older mail then arrives in [`BACKFILL_CHUNK`]s, one
/// chunk per pass, newest first.
pub const INITIAL_SYNC_LIMIT: usize = 500;
pub const BACKFILL_CHUNK: usize = 200;
/// RFC 2177: clients must re-issue IDLE at least every 29 minutes.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(25 * 60);
const FETCH_CHUNK: usize = 50;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(30);

pub const INBOX: &str = "INBOX";

pub mod dav;
pub mod gmail;
pub mod graph;
pub mod graph_pim;
pub mod push_relay;
pub mod unsubscribe;
pub mod jmap;
pub mod oauth;

trait Io: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> Io for T {}

type Session = async_imap::Session<Box<dyn Io>>;

// ── Connecting ───────────────────────────────────────────────────────────

fn is_local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// One TLS setup for every protocol: rustls with ring and the Mozilla roots.
pub fn tls_config() -> rustls::ClientConfig {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

fn tls_connector() -> TlsConnector {
    TlsConnector::from(Arc::new(tls_config()))
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
    let plan = MailboxPlan { store: crate::store::INBOX, cursor, ops: ops.to_vec() };
    Ok(sync_account(config, password, vec![plan]).await?.remove(0))
}

/// One store mailbox to sync, with where to resume and what to push.
#[derive(Debug, Clone)]
pub struct MailboxPlan {
    /// `store::INBOX`, `store::ARCHIVE`, or `store::SENT`.
    pub store: &'static str,
    pub cursor: SyncCursor,
    pub ops: Vec<PendingOp>,
}

/// The server mailboxes that play each role. Names vary ("Sent Items",
/// "[Gmail]/Sent Mail"), so roles come from RFC 6154 special-use flags.
struct Specials {
    archive: Option<String>,
    sent: Option<String>,
}

/// One pass over several mailboxes on one connection. Mailboxes the server
/// doesn't have (no `\Archive`) are skipped and return no batch.
pub async fn sync_account(config: &AccountConfig, password: &str, plans: Vec<MailboxPlan>) -> Result<Vec<SyncBatch>> {
    let mut session = imap_session(&config.imap, &config.username, password).await?;
    let result = async {
        let specials = Specials {
            archive: special_mailbox(&mut session, NameAttribute::Archive).await?,
            sent: special_mailbox(&mut session, NameAttribute::Sent).await?,
        };
        let mut work = Vec::new();
        for plan in plans {
            let server = match plan.store {
                crate::store::INBOX => Some(INBOX.to_owned()),
                crate::store::ARCHIVE => specials.archive.clone(),
                crate::store::SENT => specials.sent.clone(),
                other => Some(other.to_owned()),
            };
            if let Some(server) = server {
                work.push((server, plan));
            }
        }
        // Push every mailbox's changes before fetching any, so a move made in
        // one mailbox (unarchive) is already visible when its destination syncs.
        let mut pushed = Vec::new();
        for (server, plan) in &work {
            pushed.push(push_ops(&mut session, server, plan, &specials).await?);
        }
        let mut batches = Vec::new();
        for ((server, plan), push) in work.into_iter().zip(pushed) {
            batches.push(sync_with(&mut session, &server, plan, push).await?);
        }
        Ok(batches)
    }
    .await;
    let _ = session.logout().await;
    result
}

/// What [`wait_for_change`] saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// The server announced new mail, expunges, or flag changes.
    Changed,
    /// Nothing happened before the timeout; call again.
    Quiet,
    /// The server has no IDLE; fall back to polling.
    Unsupported,
}

/// Hold an IDLE connection on INBOX until the server reports a change or
/// `timeout` passes. The shell runs this in a loop per account and syncs on
/// `Changed`, which makes new mail appear within a second or two.
pub async fn wait_for_change(config: &AccountConfig, password: &str, timeout: Duration) -> Result<Change> {
    let mut session = imap_session(&config.imap, &config.username, password).await?;
    if !session.capabilities().await.map_err(imap_err)?.has_str("IDLE") {
        let _ = session.logout().await;
        return Ok(Change::Unsupported);
    }
    session.select(INBOX).await.map_err(imap_err)?;
    let mut idle = session.idle();
    idle.init().await.map_err(imap_err)?;
    let (wait, _stop) = idle.wait_with_timeout(timeout);
    let outcome = wait.await.map_err(imap_err)?;
    let change = match outcome {
        async_imap::extensions::idle::IdleResponse::NewData(_) => Change::Changed,
        _ => Change::Quiet,
    };
    if let Ok(mut session) = idle.done().await {
        let _ = session.logout().await;
    }
    Ok(change)
}

/// What pushing one mailbox's changes did.
struct Pushed {
    uid_validity: u32,
    applied_ops: Vec<i64>,
    moved_out: Vec<u32>,
}

/// Push one mailbox's local changes. After a UIDVALIDITY change the queued
/// UIDs point at the wrong messages, so nothing is pushed (or confirmed).
async fn push_ops(session: &mut Session, server_mailbox: &str, plan: &MailboxPlan, specials: &Specials) -> Result<Pushed> {
    let mailbox = session.select(server_mailbox).await.map_err(imap_err)?;
    let uid_validity = mailbox
        .uid_validity
        .ok_or_else(|| Error::Network("the server didn't report UIDVALIDITY".into()))?;
    let mut pushed = Pushed { uid_validity, applied_ops: Vec::new(), moved_out: Vec::new() };
    if plan.cursor.uid_validity == Some(uid_validity) {
        for op in &plan.ops {
            if push_op(session, op, specials).await? {
                pushed.moved_out.push(op.uid);
            }
            pushed.applied_ops.push(op.id);
        }
    }
    Ok(pushed)
}

async fn sync_with(session: &mut Session, server_mailbox: &str, plan: MailboxPlan, pushed: Pushed) -> Result<SyncBatch> {
    let MailboxPlan { store: store_mailbox, cursor, .. } = plan;
    session.select(server_mailbox).await.map_err(imap_err)?;
    let Pushed { uid_validity, applied_ops, moved_out } = pushed;
    let same_mailbox = cursor.uid_validity == Some(uid_validity);

    let mut server_uids: Vec<u32> = session.uid_search("ALL").await.map_err(imap_err)?.into_iter().collect();
    server_uids.sort_unstable();

    // Moved mail is gone from this mailbox; don't fetch it back.
    server_uids.retain(|u| !moved_out.contains(u));
    let last_uid = if same_mailbox { cursor.last_uid } else { 0 };
    let mut wanted: Vec<u32> = server_uids.iter().copied().filter(|u| *u > last_uid).collect();
    // The inbox matters most on first launch; Sent and Archive start smaller.
    let initial = if store_mailbox == crate::store::INBOX { INITIAL_SYNC_LIMIT } else { BACKFILL_CHUNK };
    if last_uid == 0 && wanted.len() > initial {
        wanted = wanted.split_off(wanted.len() - initial);
    }

    // Backfill: the next chunk of older mail below what we hold, newest first.
    let mut more_older = false;
    if let Some(oldest) = cursor.oldest_uid.filter(|_| same_mailbox) {
        let mut older: Vec<u32> = server_uids.iter().copied().filter(|u| *u < oldest).collect();
        more_older = older.len() > BACKFILL_CHUNK;
        if more_older {
            older = older.split_off(older.len() - BACKFILL_CHUNK);
        }
        wanted.extend(older);
    } else if last_uid == 0 {
        more_older = server_uids.len() > wanted.len();
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

    Ok(SyncBatch { mailbox: store_mailbox.into(), uid_validity, new_messages, flags, server_uids, applied_ops, more_older, moved_out })
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

/// Push one local change. Returns true when the message moved out of the
/// selected mailbox.
async fn push_op(session: &mut Session, op: &PendingOp, specials: &Specials) -> Result<bool> {
    let store = |change: &'static str| format!("{change}FLAGS.SILENT");
    let (query, flag) = match op.kind {
        OpKind::Seen(on) => (store(if on { "+" } else { "-" }), "\\Seen"),
        OpKind::Flagged(on) => (store(if on { "+" } else { "-" }), "\\Flagged"),
        OpKind::Archive | OpKind::Unarchive => {
            let target = match op.kind {
                OpKind::Archive => specials.archive.as_deref(),
                _ => Some(INBOX),
            };
            // No \Archive mailbox on this server: archiving stays local-only.
            let Some(target) = target else { return Ok(false) };
            session.uid_mv(op.uid.to_string(), target).await.map_err(imap_err)?;
            return Ok(true);
        }
    };
    let _: Vec<_> = session
        .uid_store(op.uid.to_string(), format!("{query} ({flag})"))
        .await
        .map_err(imap_err)?
        .try_collect()
        .await
        .map_err(imap_err)?;
    Ok(false)
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
    // Our own Message-ID, so replies thread on it and the server's Sent copy
    // matches the local one. The domain is the sender's, never this
    // computer's hostname (lettre's default), which would leak to recipients.
    let domain = config.address.rsplit_once('@').map(|(_, d)| d).filter(|d| !d.is_empty()).unwrap_or("localhost");
    let mut b = Message::builder()
        .from(from)
        .subject(draft.subject.clone())
        .message_id(Some(format!("<{}@{domain}>", uuid::Uuid::new_v4())));
    for to in &draft.to {
        b = b.to(mailbox(to)?);
    }
    for cc in &draft.cc {
        b = b.cc(mailbox(cc)?);
    }
    let bracket = |id: &str| format!("<{}>", id.trim().trim_matches(['<', '>']));
    if let Some(parent) = &draft.in_reply_to {
        // References = the parent's chain + the parent (RFC 5322 §3.6.4).
        let mut chain: Vec<String> = draft.references.iter().map(|r| bracket(r)).collect();
        if !chain.contains(&bracket(parent)) {
            chain.push(bracket(parent));
        }
        b = b.in_reply_to(bracket(parent)).references(chain.join(" "));
    }
    let html = draft.body_html.as_deref().filter(|h| !h.trim().is_empty()).map(html_document);
    // iMIP: the calendar object rides as the last alternative, which calendar
    // clients (Outlook, Apple Mail, Gmail) read as the invitation.
    let calendar = draft.calendar.as_ref().map(|c| {
        let ct = ContentType::parse(&format!("text/calendar; method={}; charset=utf-8", c.method.to_ascii_uppercase()))
            .unwrap_or_else(|_| ContentType::parse("text/calendar; charset=utf-8").unwrap());
        SinglePart::builder().header(ct).body(c.ics.clone())
    });
    let body = match (&html, calendar) {
        (None, None) => None,
        (Some(html), None) => Some(MultiPart::alternative_plain_html(draft.body.clone(), html.clone())),
        (html, Some(cal)) => {
            let mut alt = MultiPart::alternative().singlepart(SinglePart::plain(draft.body.clone()));
            if let Some(h) = html {
                alt = alt.singlepart(SinglePart::html(h.clone()));
            }
            Some(alt.singlepart(cal))
        }
    };
    if draft.attachments.is_empty() {
        return match body {
            Some(alt) => b.multipart(alt),
            None => b.header(ContentType::TEXT_PLAIN).body(draft.body.clone()),
        }
        .map_err(|e| Error::Invalid(e.to_string()));
    }
    let mut parts = match body {
        Some(alt) => MultiPart::mixed().multipart(alt),
        None => MultiPart::mixed().singlepart(SinglePart::plain(draft.body.clone())),
    };
    for a in &draft.attachments {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(a.data_base64.as_bytes())
            .map_err(|_| Error::Invalid(format!("“{}” couldn't be read", a.filename)))?;
        let ct = ContentType::parse(&a.mime_type).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
        parts = parts.singlepart(Attachment::new(a.filename.clone()).body(bytes, ct));
    }
    b.multipart(parts).map_err(|e| Error::Invalid(e.to_string()))
}

/// Wraps the composer's fragment in a document with a charset and quote
/// styling that survives clients which ignore `<style>` (inline styles only).
fn html_document(fragment: &str) -> String {
    let fragment = fragment.replace(
        "<blockquote>",
        r#"<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">"#,
    );
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5\">{fragment}</body></html>"
    )
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
            jmap: None,
            dav: None,
            oauth: None,
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
            body_html: None,
            in_reply_to: Some("abc@example.com".into()),
            references: vec!["root@example.com".into()],
            attachments: vec![],
            calendar: None,
            follow_up_after: None,
        };
        let raw = String::from_utf8(build_message(&config(), &draft).unwrap().formatted()).unwrap();
        assert!(raw.contains("From: Sean <sean@example.com>"));
        let id_line = raw.lines().find(|l| l.starts_with("Message-ID: ")).expect("has a Message-ID");
        assert!(id_line.ends_with("@example.com>"), "uses the sender's domain, not the hostname: {id_line}");
        assert!(raw.contains("To: Ana <ana@example.com>"));
        assert!(raw.contains("In-Reply-To: <abc@example.com>"));
        assert!(raw.contains("References: <root@example.com> <abc@example.com>"));
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
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            calendar: None,
            follow_up_after: None,
        };
        assert!(matches!(build_message(&config(), &draft), Err(Error::Invalid(_))));
    }

    #[test]
    fn attachments_round_trip_through_the_parser() {
        let draft = Draft {
            account_id: "a".into(),
            to: vec![Address { name: None, email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Tickets".into(),
            body: "Attached.".into(),
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![crate::OutgoingAttachment {
                filename: "tickets.pdf".into(),
                mime_type: "application/pdf".into(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7 hello"),
            }],
            calendar: None,
            follow_up_after: None,
        };
        let raw = build_message(&config(), &draft).unwrap().formatted();
        let parsed = crate::mime::parse(&raw).unwrap();
        assert_eq!(parsed.body_text.trim(), "Attached.");
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].filename, "tickets.pdf");
        assert_eq!(crate::mime::attachment_bytes(&raw, 0).unwrap(), b"%PDF-1.7 hello");
    }

    #[test]
    fn rich_bodies_go_out_as_alternative_parts() {
        let mut draft = Draft {
            account_id: "a".into(),
            to: vec![Address { name: None, email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Plan".into(),
            body: "Bring **snacks**".into(),
            body_html: Some("<p>Bring <strong>snacks</strong></p><blockquote><p>old</p></blockquote>".into()),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            calendar: None,
            follow_up_after: None,
        };
        let raw = String::from_utf8(build_message(&config(), &draft).unwrap().formatted()).unwrap();
        assert!(raw.contains("multipart/alternative"));
        let parsed = crate::mime::parse(raw.as_bytes()).unwrap();
        assert_eq!(parsed.body_text.trim(), "Bring **snacks**");
        let html = parsed.body_html.expect("has an HTML part");
        assert!(html.contains("<strong>snacks</strong>"));
        assert!(html.contains("border-left"), "quotes are styled inline");

        // With a file attached, the alternative nests inside multipart/mixed.
        draft.attachments.push(crate::OutgoingAttachment {
            filename: "a.txt".into(),
            mime_type: "text/plain".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(b"hi"),
        });
        let raw = build_message(&config(), &draft).unwrap().formatted();
        let parsed = crate::mime::parse(&raw).unwrap();
        assert!(parsed.body_html.unwrap().contains("<strong>snacks</strong>"));
        assert_eq!(parsed.attachments.len(), 1);
    }

    #[test]
    fn invitations_ride_as_a_text_calendar_alternative() {
        let draft = Draft {
            account_id: "a".into(),
            to: vec![Address { name: None, email: "ana@example.com".into() }],
            cc: vec![],
            subject: "Invitation: Lunch".into(),
            body: "You're invited.".into(),
            body_html: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            calendar: Some(crate::CalendarPart { method: "request".into(), ics: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n".into() }),
            follow_up_after: None,
        };
        let raw = build_message(&config(), &draft).unwrap().formatted();
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("multipart/alternative"));
        assert!(text.contains("text/calendar; method=REQUEST"), "{text}");
        assert!(crate::mime::calendar_part(&raw).is_some_and(|c| c.contains("METHOD:REQUEST")), "our own parser finds it");
        assert_eq!(crate::mime::parse(&raw).unwrap().body_text.trim(), "You're invited.");
    }

    #[tokio::test]
    async fn refuses_plaintext_to_remote_hosts() {
        let server = ServerConfig { host: "mail.example.com".into(), port: 143, security: Security::Plain };
        let err = imap_session(&server, "u", "p").await.unwrap_err();
        assert!(matches!(err, Error::Invalid(_)));
        assert!(smtp_transport(&server, "u", "p").is_err());
    }
}
