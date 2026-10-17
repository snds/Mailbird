//! `mailbird-gateway`: configuration comes from the environment (see README.md).

use std::path::PathBuf;

use mailbird_gateway::{Config, Gateway, Members, SealedFile, router};

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("gateway: {msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    // `--health`: the container's health check asks the running gateway.
    if std::env::args().nth(1).as_deref() == Some("--health") {
        let address = env("GATEWAY_ADDRESS").unwrap_or_else(|| "127.0.0.1:8080".into()).replace("0.0.0.0", "127.0.0.1");
        let ok = tokio::net::TcpStream::connect(&address).await.is_ok();
        std::process::exit(if ok { 0 } else { 1 });
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let password = env("GATEWAY_PASSWORD").unwrap_or_else(|| fail("set GATEWAY_PASSWORD (16+ characters; openssl rand -base64 24)"));
    if password.len() < 16 {
        fail("GATEWAY_PASSWORD must be at least 16 characters");
    }
    let key = env("GATEWAY_KEY").unwrap_or_else(|| fail("set GATEWAY_KEY to seal stored passwords (openssl rand -base64 32)"));
    let data = PathBuf::from(env("GATEWAY_DATA").unwrap_or_else(|| "./data".into()));
    let web_dir = PathBuf::from(env("GATEWAY_WEB").unwrap_or_else(|| "./web".into()));
    if !web_dir.join("index.html").exists() {
        fail(format!("no web app at {} (build it with `pnpm build`, or set GATEWAY_WEB)", web_dir.display()));
    }
    let address = env("GATEWAY_ADDRESS").unwrap_or_else(|| "127.0.0.1:8080".into());
    // Plain http is only for this machine; behind https, cookies are Secure.
    let secure_cookies = env("GATEWAY_INSECURE_COOKIES").is_none();
    // Where people reach the gateway; booking invitations then link to their manage page.
    let public_url = env("GATEWAY_PUBLIC_URL").map(|u| {
        if !(u.starts_with("https://") || u.starts_with("http://localhost") || u.starts_with("http://127.0.0.1")) {
            fail("GATEWAY_PUBLIC_URL must start with https:// (or http://localhost for this machine)");
        }
        u.trim_end_matches('/').to_string()
    });

    let state = pim_app::AppState::open(&data).unwrap_or_else(|e| fail(e));
    // The mail database is readable by its owner only, like the sealed secrets.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap_or_else(|e| fail(format!("can't lock down {}: {e}", data.display())));
    }
    let secrets = SealedFile::open(data.join("secrets.json"), &key).unwrap_or_else(|e| fail(e));
    pim_app::secrets::install(Box::new(secrets));
    // The owner's team, if they add one (ADR-0063).
    let members = Members::open(data.join("members.json")).unwrap_or_else(|e| fail(e));
    let gw = Gateway::new(state, Config { password, members, web_dir, secure_cookies, public_url });

    eprintln!("gateway {} on {address}, data in {}", env!("CARGO_PKG_VERSION"), data.display());
    let listener = tokio::net::TcpListener::bind(&address).await.unwrap_or_else(|e| fail(format!("can't listen on {address}: {e}")));
    axum::serve(listener, router(gw))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap_or_else(|e| fail(e));
}
