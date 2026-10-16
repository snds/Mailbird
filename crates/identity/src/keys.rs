//! The key tree (spec §3) as typed keys, and the symmetric wrap that turns a
//! key into a [`KeyEnvelope`] (§4).
//!
//! Every key is a 256-bit value held in a [`SecretBox`], which zeroises the
//! memory when it is dropped and never prints its contents. The types differ
//! only in name, and that is the point: an `AppDataKey` cannot be handed to a
//! function that wants a `PersonaKey`.

use std::fmt;

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use secrecy::{ExposeSecret, SecretBox};
use zeroize::Zeroizing;

use crate::records::{Aad, Id, KeyEnvelope, KeyRef, Purpose, RECORD_V, Timestamp, WrapAlg};
use crate::{Error, Result};

/// Fills `buf` from the operating system's random source.
pub fn random_bytes(buf: &mut [u8]) -> Result<()> {
    getrandom::fill(buf).map_err(|_| Error::Random)
}

/// Thirty-two fresh random bytes.
pub fn random_32() -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    random_bytes(&mut out)?;
    Ok(out)
}

/// What every 256-bit symmetric key in the tree can do.
pub trait SymmetricKey: Sized {
    /// A key from raw bytes (for keys derived or unwrapped elsewhere).
    fn from_bytes(bytes: [u8; 32]) -> Self;
    /// The raw bytes. Use them at once; never copy them out.
    fn expose(&self) -> &[u8; 32];
    /// A fresh random key.
    fn generate() -> Result<Self> {
        Ok(Self::from_bytes(random_32()?))
    }
}

macro_rules! key32 {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        pub struct $name(SecretBox<[u8; 32]>);

        impl SymmetricKey for $name {
            fn from_bytes(bytes: [u8; 32]) -> Self {
                Self(SecretBox::new(Box::new(bytes)))
            }
            fn expose(&self) -> &[u8; 32] {
                self.0.expose_secret()
            }
        }

        impl Clone for $name {
            fn clone(&self) -> Self {
                Self::from_bytes(*self.expose())
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "(…)"))
            }
        }
    };
}

key32!(
    /// The Identity Root Key. Random, 256-bit, never leaves a device unwrapped.
    /// Everything else hangs off it.
    Irk
);
key32!(
    /// A Persona Key: the wall between work, personal, and business (D13).
    PersonaKey
);
key32!(
    /// An App Data Key: what an app actually encrypts its data with, one per
    /// app per persona.
    AppDataKey
);
key32!(
    /// A Crown-Jewel Key: the high-blast-radius class, one per persona.
    CrownJewelKey
);
key32!(
    /// The key a device's keystore releases after the platform unlock. It
    /// wraps the IRK for local use so unlock never needs the kit.
    DeviceUnlockKey
);
key32!(
    /// The Account Unlock Key, derived from the password and the Secret Key
    /// (04-security §3). Opens the `account` wrap of the IRK.
    AccountUnlockKey
);
key32!(
    /// The key the recovery code alone rebuilds. Opens the `kit` wrap of the IRK.
    KitKey
);

/// Wraps `secret` under `with` and returns the envelope, not yet signed.
/// `aad` says where the envelope belongs; it is sealed into the tag, so the
/// envelope opens only where it was made for.
pub fn wrap<K: SymmetricKey>(
    secret: &[u8],
    with: &K,
    wrapped_by: KeyRef,
    aad: &Aad,
) -> Result<KeyEnvelope> {
    if aad.v != RECORD_V {
        return Err(Error::Invalid(
            "the associated data must carry the current record version".into(),
        ));
    }
    let aad_bytes = aad.to_bytes()?;
    let mut nonce = [0u8; 24];
    random_bytes(&mut nonce)?;
    let cipher = XChaCha20Poly1305::new(&chacha20poly1305::Key::from(*with.expose()));
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: secret,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| Error::Invalid("couldn't seal the key".into()))?;
    Ok(KeyEnvelope {
        v: RECORD_V,
        key_id: aad.key_id,
        wrapped_by,
        alg: WrapAlg::XChaCha20Poly1305,
        aad: aad_bytes,
        nonce: nonce.to_vec(),
        ciphertext,
        purpose: aad.purpose,
        created_at: Timestamp::now(),
        extra: Default::default(),
        sig: Vec::new(),
    })
}

/// Opens an envelope that was made for `expected`. An envelope whose
/// associated data names another place is refused before any decryption:
/// a hostile store cannot move a key to another persona or purpose.
pub fn unwrap<K: SymmetricKey>(
    envelope: &KeyEnvelope,
    with: &K,
    expected: &Aad,
) -> Result<Zeroizing<Vec<u8>>> {
    if envelope.alg != WrapAlg::XChaCha20Poly1305 {
        return Err(Error::Unsupported(
            "only symmetric envelopes open here".into(),
        ));
    }
    let expected_bytes = expected.to_bytes()?;
    if envelope.aad != expected_bytes
        || envelope.key_id != expected.key_id
        || envelope.purpose != expected.purpose
    {
        let found: Aad = crate::cbor::from_slice(&envelope.aad)
            .map_err(|_| Error::EnvelopeMoved("an unreadable place".into()))?;
        return Err(Error::EnvelopeMoved(found.to_string()));
    }
    let nonce = XNonce::try_from(envelope.nonce.as_slice()).map_err(|_| Error::WrongKey)?;
    let cipher = XChaCha20Poly1305::new(&chacha20poly1305::Key::from(*with.expose()));
    let plain = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &envelope.ciphertext,
                aad: &expected_bytes,
            },
        )
        .map_err(|_| Error::WrongKey)?;
    Ok(Zeroizing::new(plain))
}

/// Opens an envelope holding a 256-bit key and types it.
pub fn unwrap_key<K: SymmetricKey, W: SymmetricKey>(
    envelope: &KeyEnvelope,
    with: &W,
    expected: &Aad,
) -> Result<K> {
    let plain = unwrap(envelope, with, expected)?;
    let bytes: [u8; 32] = plain.as_slice().try_into().map_err(|_| Error::WrongKey)?;
    Ok(K::from_bytes(bytes))
}

/// The associated data for a key of `purpose` under `profile_id`.
pub fn aad(profile_id: Id, persona_id: Option<Id>, key_id: Id, purpose: Purpose) -> Aad {
    Aad {
        profile_id,
        persona_id,
        key_id,
        purpose,
        v: RECORD_V,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::KeyRefKind;

    #[test]
    fn wrap_binds_to_place() {
        let irk = Irk::generate().unwrap();
        let dev = DeviceUnlockKey::generate().unwrap();
        let profile = Id::new();
        let key_id = Id::new();
        let place = aad(profile, None, key_id, Purpose::Irk);
        let env = wrap(
            irk.expose(),
            &dev,
            KeyRef::new(KeyRefKind::Device, Id::new()),
            &place,
        )
        .unwrap();
        let back: Irk = unwrap_key(&env, &dev, &place).unwrap();
        assert_eq!(back.expose(), irk.expose());

        let moved = aad(profile, Some(Id::new()), key_id, Purpose::Irk);
        assert!(matches!(
            unwrap_key::<Irk, _>(&env, &dev, &moved),
            Err(Error::EnvelopeMoved(_))
        ));
        let repurposed = aad(profile, None, key_id, Purpose::AppData);
        assert!(matches!(
            unwrap_key::<Irk, _>(&env, &dev, &repurposed),
            Err(Error::EnvelopeMoved(_))
        ));
        let other = DeviceUnlockKey::generate().unwrap();
        assert!(matches!(
            unwrap_key::<Irk, _>(&env, &other, &place),
            Err(Error::WrongKey)
        ));

        // A store that rewrites the stored aad to match still fails the tag.
        let mut forged = env.clone();
        forged.aad = moved.to_bytes().unwrap();
        assert!(matches!(
            unwrap_key::<Irk, _>(&forged, &dev, &moved),
            Err(Error::WrongKey)
        ));
    }
}
