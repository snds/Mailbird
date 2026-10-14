//! Sealing stored secrets, comparing tokens, and signing the JWTs that APNs
//! and FCM ask for. All on `ring`, the same library the app's TLS uses.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, RSA_PKCS1_SHA256, RsaKeyPair};

/// Seals account secrets at rest with AES-256-GCM. The key comes from
/// `RELAY_KEY`, so a copied data folder alone doesn't give the passwords away.
pub struct Sealer {
    key: LessSafeKey,
}

impl Sealer {
    /// `key` is 32 bytes, base64.
    pub fn new(key_b64: &str) -> Result<Self, String> {
        let bytes = STANDARD.decode(key_b64.trim()).map_err(|_| "RELAY_KEY isn't base64".to_string())?;
        let key = UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| "RELAY_KEY must be 32 bytes (openssl rand -base64 32)".to_string())?;
        Ok(Self { key: LessSafeKey::new(key) })
    }

    pub fn seal(&self, plain: &str) -> String {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new().fill(&mut nonce).expect("the OS random source works");
        let mut buf = plain.as_bytes().to_vec();
        self.key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf).expect("sealing can't fail for in-memory data");
        let mut out = nonce.to_vec();
        out.extend(buf);
        STANDARD.encode(out)
    }

    pub fn open(&self, sealed: &str) -> Result<String, String> {
        let bad = || "a stored secret can't be opened — was RELAY_KEY changed?".to_string();
        let bytes = STANDARD.decode(sealed).map_err(|_| bad())?;
        if bytes.len() < NONCE_LEN {
            return Err(bad());
        }
        let (nonce, ct) = bytes.split_at(NONCE_LEN);
        let mut ct = ct.to_vec();
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| bad())?;
        let plain = self.key.open_in_place(nonce, Aad::empty(), &mut ct).map_err(|_| bad())?;
        String::from_utf8(plain.to_vec()).map_err(|_| bad())
    }
}

/// A random URL-safe token.
pub fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    SystemRandom::new().fill(&mut b).expect("the OS random source works");
    URL_SAFE_NO_PAD.encode(b)
}

/// A fresh 32-byte key, base64, for `RELAY_KEY`.
pub fn new_key() -> String {
    let mut b = [0u8; 32];
    SystemRandom::new().fill(&mut b).expect("the OS random source works");
    STANDARD.encode(b)
}

/// Compares secrets without leaking where they differ through timing.
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The DER inside a PEM block (`-----BEGIN PRIVATE KEY-----` …).
pub fn pem_der(pem: &str) -> Result<Vec<u8>, String> {
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).map(str::trim).collect();
    STANDARD.decode(body).map_err(|_| "the key file isn't a PEM private key".to_string())
}

fn jwt(header: &serde_json::Value, claims: &serde_json::Value, sign: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>) -> Result<String, String> {
    let input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()));
    let sig = sign(input.as_bytes())?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig)))
}

/// An ES256 JWT, as APNs token authentication wants (the `.p8` key from Apple).
pub fn jwt_es256(pkcs8: &[u8], header: &serde_json::Value, claims: &serde_json::Value) -> Result<String, String> {
    let rng = SystemRandom::new();
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8, &rng).map_err(|e| format!("the APNs key can't be read ({e})"))?;
    jwt(header, claims, |input| key.sign(&rng, input).map(|s| s.as_ref().to_vec()).map_err(|_| "signing failed".to_string()))
}

/// An RS256 JWT, as Google's service-account token exchange wants.
pub fn jwt_rs256(pkcs8: &[u8], header: &serde_json::Value, claims: &serde_json::Value) -> Result<String, String> {
    let key = RsaKeyPair::from_pkcs8(pkcs8).map_err(|e| format!("the FCM service-account key can't be read ({e})"))?;
    jwt(header, claims, |input| {
        let mut sig = vec![0u8; key.public().modulus_len()];
        key.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), input, &mut sig).map_err(|_| "signing failed".to_string())?;
        Ok(sig)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens() {
        let s = Sealer::new(&new_key()).unwrap();
        let sealed = s.seal("app-password-123");
        assert_ne!(sealed, s.seal("app-password-123"), "a fresh nonce every time");
        assert_eq!(s.open(&sealed).unwrap(), "app-password-123");
        assert!(Sealer::new(&new_key()).unwrap().open(&sealed).is_err(), "another key can't open it");
        assert!(Sealer::new("c2hvcnQ=").is_err(), "keys must be 32 bytes");
    }

    #[test]
    fn compares_in_constant_time_shape() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd") && !same("abc", "abcd"));
    }

    #[test]
    fn es256_tokens_verify() {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let token = jwt_es256(pkcs8.as_ref(), &serde_json::json!({ "alg": "ES256", "kid": "K" }), &serde_json::json!({ "iss": "T", "iat": 1 })).unwrap();
        let (input, sig) = token.rsplit_once('.').unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
        use ring::signature::KeyPair;
        let public = ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, key.public_key().as_ref());
        public.verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(sig).unwrap()).unwrap();
    }
}
