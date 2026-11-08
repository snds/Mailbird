fn main() {
  updater_key();
  tauri_build::build()
}

/// The update key's public half, `updater.pub` (ADR-0076), built in as
/// `VALE_UPDATER_PUBKEY`. No file: an empty key, and updates are off in
/// this build.
fn updater_key() {
  const FILE: &str = "updater.pub";
  // Cargo reruns a build script whose watched file is missing on every
  // build, so the folder is watched while the file is absent: adding the
  // key then rebuilds, and a build without it stays cached.
  let path = std::path::Path::new(FILE);
  if path.exists() {
    println!("cargo:rerun-if-changed={FILE}");
  } else {
    println!("cargo:rerun-if-changed=.");
  }
  let key = std::fs::read_to_string(path).unwrap_or_default();
  let key = key.trim();
  assert!(
    key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')),
    "{FILE} must hold one line of base64, as `tauri signer generate` writes the public key"
  );
  println!("cargo:rustc-env=VALE_UPDATER_PUBKEY={key}");
}
