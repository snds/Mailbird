//! Automatic updates for the desktop app (ADR-0076), through Sean's shared
//! update kit, `snds/app-updates` (the unified updates proposal, U1–U6).
//!
//! CI publishes every push to `main` as one rolling pre-release on
//! `snds/releases`, `vale-main`, with a signed bundle per platform and the
//! updater manifest `latest.json`. Vale follows it: it checks at launch and
//! every six hours (or when asked: Settings → About, the command menu, and
//! on macOS "Check for Updates…" in the app menu), downloads a newer build in
//! the background, checks its signature against the key built in from
//! `updater.pub`, and offers "Restart to update". An update not taken
//! installs when Vale quits.
//!
//! The kit drives Tauri's updater plugin from Rust, so no updater
//! permission reaches the webview. What's Vale's own is here: where its
//! builds are published ([`FEED`]), its key ([`built_in_key`]), and
//! [`ValeHost`], which keeps "Check for updates automatically" in the
//! core's device settings (`updates.autoCheck`, next to the menu bar's).
//! Vale Demo (ADR-0072) never updates: it isn't a build of `vale-main`.

use std::sync::Arc;

use app_updates::shell::{self as kit, Config, Host};
use app_updates::{Feed, GITHUB_HOSTS};
use pim_app::Shared;
use pim_app::commands::with_store;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// The "main" channel's manifest: the `latest.json` asset of the rolling
/// `vale-main` pre-release. No part of the URL depends on this device, this
/// person or this build.
pub const MAIN_ENDPOINT: &str = "https://github.com/snds/releases/releases/download/vale-main/latest.json";

/// Where people are sent when Vale can't replace itself (a Linux package, a
/// Windows install for every user, a Mac folder they can't write to).
pub const MAIN_PAGE: &str = "https://github.com/snds/releases/releases/tag/vale-main";

/// Vale's feed: the main channel on `snds/releases`, GitHub's hosts, and no
/// stable channel yet.
pub const FEED: Feed = Feed {
    app: "Vale",
    main_endpoint: MAIN_ENDPOINT,
    main_page: MAIN_PAGE,
    stable_endpoint: None,
    stable_page: None,
    hosts: &GITHUB_HOSTS,
};

/// The event every change of the update status is sent on.
pub const EVENT: &str = "vale://update";

/// The macOS app menu's "Check for Updates…" item.
pub const MENU_ID: &str = "vale-check-for-updates";

/// Vale Demo's app id (tauri.demo.conf.json): it never checks for updates.
const DEMO_ID: &str = "design.snds.vale.demo";

/// Where the switch is kept: a device setting in the core's store.
const AUTO_CHECK: &str = "updates.autoCheck";

/// The ID of the key Sean made for Vale (2026-11-08), whose public half is
/// `updater.pub`. A test holds the committed file to it.
#[cfg(test)]
const RELEASE_KEY_ID: &str = "98E8E6D6FFEA0C53";

/// The public key built in from `updater.pub` (build.rs), if the file was
/// there when this build was made. Without it, updates are off in the build
/// and Settings says so.
pub fn built_in_key() -> Option<&'static str> {
    Some(env!("VALE_UPDATER_PUBKEY")).filter(|k| !k.is_empty())
}

/// Tauri's updater plugin, configured from Rust: `plugins.updater` in
/// tauri.conf.json holds only what it can't take from code (the signed
/// version required, and the passive Windows installer).
pub use kit::plugin;

/// What the kit asks of Vale: where "Check for updates automatically" is
/// kept. Nothing needs doing before a restart: the core saves as it goes,
/// and the outbox's undo-send waits survive a relaunch (ADR-0007).
pub struct ValeHost {
    state: Shared,
}

impl Host for ValeHost {
    fn auto_check(&self) -> bool {
        auto_check(&self.state)
    }

    fn set_auto_check(&self, on: bool) -> Result<(), String> {
        with_store(&self.state, |s| s.set_setting(AUTO_CHECK, Some(if on { "true" } else { "false" })))
    }
}

/// The switch as saved; on when it never was.
fn auto_check(state: &Shared) -> bool {
    with_store(state, |s| s.setting(AUTO_CHECK)).ok().flatten().is_none_or(|v| v != "false")
}

/// Sets up the updater: the plan, the status, the macOS menu item, and the
/// automatic check at launch and every six hours. Not in Vale Demo, whose
/// commands then answer that there's no updater.
pub fn start(handle: &AppHandle, state: Shared) {
    if handle.config().identifier == DEMO_ID {
        return;
    }
    let config = Config { feed: FEED, key: built_in_key(), test: None, event: EVENT, menu_id: MENU_ID, local: None };
    kit::start(handle, config, Arc::new(ValeHost { state }));
}

/// "Get it from GitHub", where Vale can't replace itself: opens the release
/// page the kit named, and nothing else, so the page can't open an address
/// of its own choosing.
#[tauri::command]
pub async fn update_open_page(handle: AppHandle) -> Result<(), String> {
    let link = kit::status(&handle)?.link.ok_or("there's no download page to open")?;
    handle.opener().open_url(link, None::<&str>).map_err(|e| e.to_string())
}

/// Vale is quitting: a downloaded update not yet taken installs now,
/// without relaunching.
pub fn on_exit(handle: &AppHandle) {
    kit::on_exit(handle);
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_updates::{Channel, Off, allowed, key_id, key_is_valid, plan};
    use semver::Version;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn the_feed_is_vales_main_channel_on_github() {
        assert_eq!(Channel::Main.endpoint(&FEED), Some(MAIN_ENDPOINT));
        assert_eq!(Channel::Stable.endpoint(&FEED), None);
        let hosts: Vec<String> = GITHUB_HOSTS.iter().map(|h| h.to_string()).collect();
        assert!(allowed(MAIN_ENDPOINT, &hosts).is_ok());
        assert!(allowed(MAIN_PAGE, &hosts).is_ok());
        assert_eq!(EVENT, "vale://update");
        assert_eq!(MENU_ID, "vale-check-for-updates");
    }

    #[test]
    fn main_builds_check_and_unstamped_builds_say_why_not() {
        let key = built_in_key().expect("updater.pub is committed");
        let main = v("0.1.0-main.20261108093000");
        let source = plan(&FEED, &main, Some(key), None).unwrap();
        assert_eq!(source.endpoint, MAIN_ENDPOINT);
        assert_eq!(source.page, MAIN_PAGE);
        assert_eq!(plan(&FEED, &main, None, None), Err(Off::NoKey));
        assert_eq!(plan(&FEED, &v("0.1.0"), Some(key), None), Err(Off::StableNotBuilt));
        assert_eq!(Off::NoKey.words(), "Updates are off in this build: it was made without the update key.");
    }

    #[test]
    fn the_switch_is_on_until_turned_off_and_kept_in_the_core() {
        let dir = std::env::temp_dir().join(format!("vale-updater-{}", std::process::id()));
        let state = pim_app::AppState::open(&dir).unwrap();
        let host = ValeHost { state: state.clone() };
        assert!(host.auto_check(), "on by default");
        host.set_auto_check(false).unwrap();
        assert!(!host.auto_check());
        assert_eq!(with_store(&state, |s| s.setting(AUTO_CHECK)).unwrap().as_deref(), Some("false"));
        host.set_auto_check(true).unwrap();
        assert!(host.auto_check());
        drop((host, state));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The committed `updater.pub` is Sean's release key, whole: a file
    /// changed, cut short or swapped fails here before any build ships it.
    #[test]
    fn the_committed_key_is_the_release_key() {
        let file = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("updater.pub"))
            .expect("apps/web/src-tauri/updater.pub is committed");
        assert!(key_is_valid(&file), "updater.pub doesn't parse as a minisign public key");
        assert_eq!(key_id(&file).as_deref(), Some(RELEASE_KEY_ID));
        assert_eq!(built_in_key(), Some(file.trim()));
        assert_eq!(built_in_key().and_then(key_id).as_deref(), Some(RELEASE_KEY_ID));
    }
}
