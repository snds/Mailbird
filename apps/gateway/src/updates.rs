//! Update checks for the gateway (ADR-0077; the unified updates proposal, U5).
//!
//! A server can't swap its own image while it runs, so the gateway only
//! checks and says. Every push to `main` publishes the image
//! `ghcr.io/snds/vale-gateway`, tagged with the build's version
//! (`x.y.z-main.<commit time, UTC>`) and the rolling `main`, and only then
//! writes the same version into `latest.json` on the rolling `gateway-main`
//! pre-release of snds/Vale (`.github/workflows/gateway-image.yml`). The
//! manifest is written after the image is in the registry, so it never names
//! an image that isn't there. The gateway reads it:
//!
//! - at start and every six hours while "Check for updates automatically"
//!   is on (on by default; the core's device setting `updates.autoCheck`,
//!   the same key the desktop app keeps, ADR-0076), and whenever the owner
//!   presses Check for updates (Settings → Gateway updates);
//! - with the shared kit's rules (`snds-app-updates`, no `tauri` feature):
//!   the channel comes from the running version, the manifest and every
//!   redirect must be https on GitHub's hosts ([`app_updates::allowed`]),
//!   and only a strictly newer version counts ([`app_updates::is_newer`]);
//! - sending nothing about the gateway: one `GET` with `accept` and the user
//!   agent `vale-gateway` (no version, no address, no account).
//!
//! When a newer build is out, Settings shows its version and the command
//! that updates a compose setup by hand. Pulling the image and restarting
//! the container is left to the person, or later to a helper on the host:
//! the gateway has no Docker socket and no way to restart itself.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_updates::{Channel, Feed, GITHUB_HOSTS, UpdateState};
use futures::future::BoxFuture;
use pim_app::Shared;
use pim_app::commands::with_store;
use semver::Version;
use serde::{Deserialize, Serialize};

/// The rolling pre-release whose `latest.json` names the newest image.
pub const MAIN_ENDPOINT: &str =
    "https://github.com/snds/Vale/releases/download/gateway-main/latest.json";

/// The release page for the newest image.
pub const MAIN_PAGE: &str = "https://github.com/snds/Vale/releases/tag/gateway-main";

/// Where the gateway's builds are announced: its own main channel, GitHub's
/// hosts, no stable channel yet.
pub const FEED: Feed = Feed {
    app: "Vale gateway",
    main_endpoint: MAIN_ENDPOINT,
    main_page: MAIN_PAGE,
    stable_endpoint: None,
    stable_page: None,
    hosts: &GITHUB_HOSTS,
};

/// The published image (`gateway-image.yml`).
pub const IMAGE: &str = "ghcr.io/snds/vale-gateway";

/// The command that updates a compose setup by hand, run beside its
/// `compose.yaml`.
pub const UPDATE_COMMAND: &str = "docker compose pull && docker compose up -d";

/// How long one check may take.
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// The largest manifest read (the real one is under 1 KB).
pub const MANIFEST_LIMIT: usize = 64 * 1024;

/// The most redirects one check follows.
const MAX_REDIRECTS: usize = 5;

/// The core's device setting that holds the switch (as on the desktop).
pub const AUTO_CHECK: &str = "updates.autoCheck";

/// The version this binary was built as: `VALE_GATEWAY_VERSION`, stamped by
/// the image workflow at build time, else the crate's own (a build from
/// source, which doesn't check).
pub fn running() -> Version {
    let stamped = option_env!("VALE_GATEWAY_VERSION").filter(|v| !v.trim().is_empty());
    stamped
        .and_then(|v| Version::parse(v.trim()).ok())
        .unwrap_or_else(|| {
            Version::parse(env!("CARGO_PKG_VERSION")).unwrap_or_else(|_| Version::new(0, 0, 0))
        })
}

/// Reads a channel's manifest. The real one is [`GitHub`]; tests give
/// their own.
pub trait ManifestSource: Send + Sync {
    /// The manifest's bytes, or what went wrong in plain words.
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

/// Whether one hop of a check (the manifest's address, or a redirect) may
/// be followed: the kit's rule, and at most [`MAX_REDIRECTS`] hops.
pub fn hop_allowed(url: &str, hops_before: usize) -> Result<(), String> {
    if hops_before > MAX_REDIRECTS {
        return Err("too many redirects".into());
    }
    let hosts: Vec<String> = FEED.hosts.iter().map(|h| h.to_string()).collect();
    app_updates::allowed(url, &hosts)
}

/// The manifest over https from GitHub, every redirect checked by
/// [`hop_allowed`], with the core's TLS setup (ring, the built-in roots).
pub struct GitHub {
    client: reqwest::Client,
}

impl GitHub {
    /// A client with the check's timeout, redirect rule and plain headers.
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(pim_core::net::tls_config())
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::custom(
                |attempt| match hop_allowed(attempt.url().as_str(), attempt.previous().len()) {
                    Ok(()) => attempt.follow(),
                    Err(why) => attempt.error(why),
                },
            ))
            .user_agent("vale-gateway")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client })
    }
}

impl ManifestSource for GitHub {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            hop_allowed(url, 0).map_err(|e| refused(&e))?;
            let mut res = self
                .client
                .get(url)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await
                .map_err(|e| {
                    // A refused redirect carries the kit's words.
                    let mut source: Option<&dyn std::error::Error> = Some(&e);
                    while let Some(s) = source {
                        let text = s.to_string();
                        if text.starts_with("updates ")
                            || text.starts_with("the update address")
                            || text == "too many redirects"
                        {
                            return refused(&text);
                        }
                        source = s.source();
                    }
                    UNREACHABLE.to_string()
                })?;
            if !res.status().is_success() {
                return Err(if res.status() == reqwest::StatusCode::NOT_FOUND {
                    NOTHING_PUBLISHED.to_string()
                } else {
                    UNREACHABLE.to_string()
                });
            }
            let mut body = Vec::new();
            while let Some(chunk) = res.chunk().await.map_err(|_| UNREACHABLE.to_string())? {
                body.extend_from_slice(&chunk);
                if body.len() > MANIFEST_LIMIT {
                    return Err(UNREADABLE.to_string());
                }
            }
            Ok(body)
        })
    }
}

/// A refused address in the desktop app's words.
fn refused(why: &str) -> String {
    if why == "updates come only over https" {
        "Updates come only over https.".into()
    } else {
        format!("The update was refused: {why}.")
    }
}

/// The check couldn't reach GitHub.
pub const UNREACHABLE: &str =
    "The gateway couldn't reach GitHub. Check its connection and try again.";
/// No image has been published yet.
pub const NOTHING_PUBLISHED: &str = "No gateway image is published yet.";
/// The manifest isn't one the gateway can read.
pub const UNREADABLE: &str = "The update's description couldn't be read.";

/// What a manifest says about the running build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The manifest's version is this one or older.
    UpToDate,
    /// A strictly newer version is out.
    Newer(Version),
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
}

/// Reads a manifest (`latest.json` beside the image: only its `version` is
/// used) against the running version.
pub fn judge(current: &Version, body: &[u8]) -> Result<Outcome, String> {
    if body.len() > MANIFEST_LIMIT {
        return Err(UNREADABLE.into());
    }
    let manifest: Manifest = serde_json::from_slice(body).map_err(|_| UNREADABLE.to_string())?;
    let offered = Version::parse(manifest.version.trim().trim_start_matches('v'))
        .map_err(|_| UNREADABLE.to_string())?;
    Ok(if app_updates::is_newer(current, &offered) {
        Outcome::Newer(offered)
    } else {
        Outcome::UpToDate
    })
}

/// Why a build that isn't on the main channel doesn't check.
pub const OFF_NOT_MAIN: &str = "Update checks are off for this build: it was built from source, and only the published image (the main channel) checks for now.";

/// Where the gateway's update check stands, as Settings shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The running version.
    pub version: String,
    /// The channel it follows.
    pub channel: Channel,
    /// Why this build doesn't check, when it doesn't.
    pub off: Option<&'static str>,
    /// `idle`, `checking`, `up_to_date`, `available` or `failed`.
    pub state: UpdateState,
    /// The newer version (`available`).
    pub offered: Option<String>,
    /// What went wrong (`failed`).
    pub error: Option<String>,
    /// When the last check finished (Unix seconds).
    pub checked_at: Option<i64>,
}

/// The status line, in the desktop app's words.
pub fn status_line(status: &Status, auto: bool) -> String {
    if let Some(off) = status.off {
        return off.to_string();
    }
    match status.state {
        UpdateState::Checking => "Checking for updates…".into(),
        UpdateState::UpToDate => "Vale gateway is up to date.".into(),
        UpdateState::Available => {
            format!(
                "Version {} is out.",
                status.offered.as_deref().unwrap_or("?")
            )
        }
        UpdateState::Failed => status
            .error
            .clone()
            .unwrap_or_else(|| "The update check didn't work.".into()),
        _ if auto => "Vale gateway checks for updates when it starts and every six hours.".into(),
        _ => "Automatic checks are off. Check whenever you like.".into(),
    }
}

/// What `GET /api/updates` answers: the status, the switch, the line to
/// show, and, when a newer build is out, how to take it.
pub fn report(status: &Status, auto: bool) -> serde_json::Value {
    let mut out = serde_json::to_value(status).expect("the status serializes");
    out["enabled"] = status.off.is_none().into();
    out["autoCheck"] = auto.into();
    out["line"] = status_line(status, auto).into();
    out["image"] = IMAGE.into();
    out["page"] = MAIN_PAGE.into();
    if status.state == UpdateState::Available {
        out["command"] = UPDATE_COMMAND.into();
    }
    out
}

/// The gateway's update check: its status and where it reads the manifest.
pub struct Updates {
    version: Version,
    status: Mutex<Status>,
    source: Mutex<Option<Arc<dyn ManifestSource>>>,
}

impl std::fmt::Debug for Updates {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Updates({})", self.version)
    }
}

impl Default for Updates {
    fn default() -> Self {
        Self::new(running(), None)
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Updates {
    /// Checks for `version`, reading through `source` ([`GitHub`] when
    /// `None`, made at the first check).
    pub fn new(version: Version, source: Option<Arc<dyn ManifestSource>>) -> Self {
        let channel = Channel::of(&version);
        let status = Status {
            version: version.to_string(),
            channel,
            off: channel.endpoint(&FEED).is_none().then_some(OFF_NOT_MAIN),
            state: UpdateState::Idle,
            offered: None,
            error: None,
            checked_at: None,
        };
        Self {
            version,
            status: Mutex::new(status),
            source: Mutex::new(source),
        }
    }

    /// The status now.
    pub fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    /// Whether this build checks at all.
    pub fn enabled(&self) -> bool {
        lock(&self.status).off.is_none()
    }

    /// One check now. A build that doesn't check, or a check already
    /// running, returns the status as it is.
    pub async fn check(&self) -> Status {
        let Some(endpoint) = Channel::of(&self.version).endpoint(&FEED) else {
            return self.status();
        };
        {
            let mut s = lock(&self.status);
            if s.state == UpdateState::Checking {
                return s.clone();
            }
            s.state = UpdateState::Checking;
            s.error = None;
        }
        let source = {
            let mut source = lock(&self.source);
            if source.is_none() {
                match GitHub::new() {
                    Ok(g) => *source = Some(Arc::new(g)),
                    Err(e) => eprintln!("gateway: the update check couldn't start: {e}"),
                }
            }
            source.clone()
        };
        let result = match source {
            Some(source) => source
                .fetch(endpoint)
                .await
                .and_then(|body| judge(&self.version, &body)),
            None => Err(UNREACHABLE.to_string()),
        };
        let mut s = lock(&self.status);
        s.checked_at = Some(now());
        match result {
            Ok(Outcome::UpToDate) => {
                s.state = UpdateState::UpToDate;
                s.offered = None;
                eprintln!("gateway: update check: up to date");
            }
            Ok(Outcome::Newer(v)) => {
                s.state = UpdateState::Available;
                eprintln!("gateway: update check: version {v} is out ({IMAGE}:main)");
                s.offered = Some(v.to_string());
            }
            Err(e) => {
                s.state = UpdateState::Failed;
                s.offered = None;
                eprintln!("gateway: update check failed: {e}");
                s.error = Some(e);
            }
        }
        s.clone()
    }
}

/// The switch as saved; on when it never was.
pub fn auto_check(state: &Shared) -> bool {
    with_store(state, |s| s.setting(AUTO_CHECK))
        .ok()
        .flatten()
        .is_none_or(|v| v != "false")
}

/// Saves the switch.
pub fn set_auto_check(state: &Shared, on: bool) -> Result<(), String> {
    with_store(state, |s| {
        s.set_setting(AUTO_CHECK, Some(if on { "true" } else { "false" }))
    })
}

/// Checks at start and then every six hours while the switch is on, for as
/// long as the process lives. A build that doesn't check starts nothing.
pub fn spawn(updates: Arc<Updates>, state: Shared) -> bool {
    if !updates.enabled() {
        return false;
    }
    tokio::spawn(async move {
        loop {
            if auto_check(&state) {
                updates.check().await;
            }
            tokio::time::sleep(app_updates::CHECK_EVERY).await;
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn only_a_strictly_newer_manifest_is_an_update() {
        let at = v("0.1.0-main.20261108090000");
        let newer =
            br#"{"version":"0.1.0-main.20261108120000","image":"ghcr.io/snds/vale-gateway"}"#;
        assert_eq!(
            judge(&at, newer),
            Ok(Outcome::Newer(v("0.1.0-main.20261108120000")))
        );
        let same = br#"{"version":"0.1.0-main.20261108090000"}"#;
        assert_eq!(judge(&at, same), Ok(Outcome::UpToDate));
        let older = br#"{"version":"0.1.0-main.20261107090000"}"#;
        assert_eq!(judge(&at, older), Ok(Outcome::UpToDate));
        // A release sorts after its own main builds.
        assert_eq!(
            judge(&at, br#"{"version":"0.1.0"}"#),
            Ok(Outcome::Newer(v("0.1.0")))
        );
        for bad in [
            &b"not json"[..],
            br#"{"version":"soon"}"#,
            br#"{"notes":"no version"}"#,
        ] {
            assert_eq!(judge(&at, bad), Err(UNREADABLE.into()));
        }
        let huge = vec![b' '; MANIFEST_LIMIT + 1];
        assert_eq!(judge(&at, &huge), Err(UNREADABLE.into()));
    }

    #[test]
    fn checks_go_only_to_githubs_hosts_over_https() {
        assert!(hop_allowed(MAIN_ENDPOINT, 0).is_ok());
        assert!(hop_allowed(MAIN_PAGE, 0).is_ok());
        assert!(
            hop_allowed(
                "https://release-assets.githubusercontent.com/github-production-release-asset/1/2",
                1
            )
            .is_ok()
        );
        assert_eq!(
            hop_allowed("https://evil.example/latest.json", 1),
            Err("updates don't come from evil.example".into())
        );
        // The registry isn't read: the manifest beside the image is.
        assert!(hop_allowed("https://ghcr.io/v2/snds/vale-gateway/tags/list", 0).is_err());
        assert!(hop_allowed("http://github.com/snds/Vale", 0).is_err());
        assert!(hop_allowed("https://user@github.com/x", 0).is_err());
        assert!(hop_allowed("https://github.com:8443/x", 0).is_err());
        assert_eq!(
            hop_allowed(MAIN_ENDPOINT, MAX_REDIRECTS + 1),
            Err("too many redirects".into())
        );
        assert_eq!(
            refused("updates don't come from evil.example"),
            "The update was refused: updates don't come from evil.example."
        );
        assert_eq!(
            refused("updates come only over https"),
            "Updates come only over https."
        );
    }

    struct Fixed(Result<Vec<u8>, String>, Mutex<Vec<String>>);

    impl ManifestSource for Fixed {
        fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
            lock(&self.1).push(url.to_string());
            let out = self.0.clone();
            Box::pin(async move { out })
        }
    }

    #[tokio::test]
    async fn a_main_build_checks_the_manifest_beside_the_image_and_says_what_it_found() {
        let source = Arc::new(Fixed(
            Ok(br#"{"version":"0.1.0-main.20261109000000"}"#.to_vec()),
            Mutex::default(),
        ));
        let u = Updates::new(v("0.1.0-main.20261108000000"), Some(source.clone()));
        assert!(u.enabled());
        assert_eq!(u.status().channel, Channel::Main);
        assert_eq!(
            status_line(&u.status(), true),
            "Vale gateway checks for updates when it starts and every six hours."
        );
        assert_eq!(
            status_line(&u.status(), false),
            "Automatic checks are off. Check whenever you like."
        );
        let s = u.check().await;
        assert_eq!(s.state, UpdateState::Available);
        assert_eq!(s.offered.as_deref(), Some("0.1.0-main.20261109000000"));
        assert!(s.checked_at.is_some());
        assert_eq!(
            status_line(&s, true),
            "Version 0.1.0-main.20261109000000 is out."
        );
        assert_eq!(*lock(&source.1), vec![MAIN_ENDPOINT.to_string()]);
        let r = report(&s, true);
        assert_eq!(r["state"], "available");
        assert_eq!(r["channel"], "main");
        assert_eq!(r["command"], UPDATE_COMMAND);
        assert_eq!(r["image"], IMAGE);

        let failing = Arc::new(Fixed(Err(UNREACHABLE.into()), Mutex::default()));
        let u = Updates::new(v("0.1.0-main.20261108000000"), Some(failing));
        let s = u.check().await;
        assert_eq!(s.state, UpdateState::Failed);
        assert_eq!(status_line(&s, true), UNREACHABLE);
        assert!(report(&s, true).get("command").is_none());
    }

    #[tokio::test]
    async fn a_build_from_source_never_checks() {
        let source = Arc::new(Fixed(Ok(b"{}".to_vec()), Mutex::default()));
        let u = Updates::new(v("0.1.0"), Some(source.clone()));
        assert!(!u.enabled());
        let s = u.check().await;
        assert_eq!(s.state, UpdateState::Idle);
        assert_eq!(status_line(&s, true), OFF_NOT_MAIN);
        assert!(lock(&source.1).is_empty());
        assert_eq!(report(&s, true)["enabled"], false);
    }

    /// The version the image workflow stamps is a main-channel version.
    #[test]
    fn the_stamped_version_is_on_the_main_channel() {
        let stamped = format!("{}-main.20261108093000", env!("CARGO_PKG_VERSION"));
        assert_eq!(Channel::of(&v(&stamped)), Channel::Main);
        // Unstamped (tests, a build from source): the crate's version, which doesn't check.
        if option_env!("VALE_GATEWAY_VERSION").is_none() {
            assert_eq!(running(), v(env!("CARGO_PKG_VERSION")));
        }
    }

    #[test]
    fn the_switch_is_on_until_turned_off() {
        let dir = std::env::temp_dir().join(format!("vale-gateway-updates-{}", std::process::id()));
        let state = pim_app::AppState::open(&dir).unwrap();
        assert!(auto_check(&state), "on by default");
        set_auto_check(&state, false).unwrap();
        assert!(!auto_check(&state));
        set_auto_check(&state, true).unwrap();
        assert!(auto_check(&state));
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
