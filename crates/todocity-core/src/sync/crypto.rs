//! The cryptography sync uses, all from `ring`:
//!
//! * **Boxes** — every batch of changes is sealed with ChaCha20-Poly1305
//!   under a fresh key derived (HKDF-SHA256) from the group key and a random
//!   salt, so the relay sees only random bytes.
//! * **Mailbox name and pass** — derived from the group key, so only Macs
//!   that hold it can find or use the mailbox.
//! * **Pairing** — an X25519 exchange through a short-lived room, with a
//!   commitment so neither side can pick its key after seeing the other's,
//!   and a 6-digit code both people compare (a short authentication string).

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};

use super::b64;

pub const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const TAG_LEN: usize = 16;
const BOX_VERSION: u8 = 1;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("this box can't be opened with this group's key")]
    Open,
    #[error("the system random generator failed")]
    Random,
    #[error("the other Mac's key isn't valid")]
    BadKey,
}

/// A group's shared secret: every paired Mac has the same one.
#[derive(Clone, PartialEq, Eq)]
pub struct GroupKey(pub [u8; KEY_LEN]);

impl std::fmt::Debug for GroupKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GroupKey(…)")
    }
}

impl GroupKey {
    pub fn generate() -> Result<Self, CryptoError> {
        let mut k = [0u8; KEY_LEN];
        fill(&mut k)?;
        Ok(Self(k))
    }

    pub fn to_text(&self) -> String {
        b64::encode_url(&self.0)
    }

    pub fn from_text(s: &str) -> Option<Self> {
        let v = b64::decode(s.trim())?;
        Some(Self(v.try_into().ok()?))
    }

    /// The mailbox's name on the relay (not secret, but unguessable).
    pub fn mailbox_id(&self) -> String {
        b64::encode_url(&derive::<18>(&self.0, b"", b"todocity mailbox id v1"))
    }

    /// The pass the relay checks before letting anyone use the mailbox.
    pub fn mailbox_token(&self) -> String {
        b64::encode_url(&derive::<32>(&self.0, b"", b"todocity mailbox token v1"))
    }

    /// Seal `plain` into a box only this group can open.
    pub fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let mut salt = [0u8; SALT_LEN];
        fill(&mut salt)?;
        let key = derive::<KEY_LEN>(&self.0, &salt, b"todocity box v1");
        let mut out = Vec::with_capacity(1 + SALT_LEN + plain.len() + TAG_LEN);
        out.push(BOX_VERSION);
        out.extend_from_slice(&salt);
        out.extend_from_slice(&seal_with(&key, plain)?);
        Ok(out)
    }

    pub fn open(&self, boxed: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if boxed.len() < 1 + SALT_LEN + TAG_LEN || boxed[0] != BOX_VERSION {
            return Err(CryptoError::Open);
        }
        let salt = &boxed[1..1 + SALT_LEN];
        let key = derive::<KEY_LEN>(&self.0, salt, b"todocity box v1");
        open_with(&key, &boxed[1 + SALT_LEN..])
    }
}

/// Seal with a key used for exactly one message (so a zero nonce is safe).
fn seal_with(key: &[u8; KEY_LEN], plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let k = LessSafeKey::new(
        UnboundKey::new(&CHACHA20_POLY1305, key).map_err(|_| CryptoError::BadKey)?,
    );
    let mut buf = plain.to_vec();
    k.seal_in_place_append_tag(
        Nonce::assume_unique_for_key([0; 12]),
        Aad::empty(),
        &mut buf,
    )
    .map_err(|_| CryptoError::Open)?;
    Ok(buf)
}

fn open_with(key: &[u8; KEY_LEN], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let k = LessSafeKey::new(
        UnboundKey::new(&CHACHA20_POLY1305, key).map_err(|_| CryptoError::BadKey)?,
    );
    let mut buf = sealed.to_vec();
    let plain = k
        .open_in_place(
            Nonce::assume_unique_for_key([0; 12]),
            Aad::empty(),
            &mut buf,
        )
        .map_err(|_| CryptoError::Open)?;
    Ok(plain.to_vec())
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// HKDF-SHA256 of `ikm` into `N` bytes.
pub fn derive<const N: usize>(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    let info = [info];
    hkdf::Salt::new(hkdf::HKDF_SHA256, salt)
        .extract(ikm)
        .expand(&info, Len(N))
        .and_then(|okm| okm.fill(&mut out))
        .expect("HKDF output length is within limits");
    out
}

pub fn fill(buf: &mut [u8]) -> Result<(), CryptoError> {
    SystemRandom::new()
        .fill(buf)
        .map_err(|_| CryptoError::Random)
}

/// A random id made of URL-safe letters, `bytes` of randomness long.
pub fn random_id(bytes: usize) -> Result<String, CryptoError> {
    let mut b = vec![0u8; bytes];
    fill(&mut b)?;
    Ok(b64::encode_url(&b))
}

// ── Pairing ────────────────────────────────────────────────────────────────

/// Letters for room codes: no 0/O or 1/I to mix up.
const CODE_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// An 8-letter room code, e.g. `K7MX4QRB` (shown as `K7MX-4QRB`).
pub fn room_code() -> Result<String, CryptoError> {
    let mut b = [0u8; 8];
    fill(&mut b)?;
    Ok(b.iter()
        .map(|x| CODE_ALPHABET[(*x & 31) as usize] as char)
        .collect())
}

/// What someone typed, as a room code: case, spaces and dashes don't matter.
pub fn clean_code(typed: &str) -> Option<String> {
    let s: String = typed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (s.len() == 8 && s.bytes().all(|b| CODE_ALPHABET.contains(&b))).then_some(s)
}

/// One side of a pairing exchange: a key pair used for this pairing only.
pub struct PairKey {
    secret: EphemeralPrivateKey,
    pub public: [u8; 32],
}

impl PairKey {
    pub fn generate() -> Result<Self, CryptoError> {
        let rng = SystemRandom::new();
        let secret =
            EphemeralPrivateKey::generate(&X25519, &rng).map_err(|_| CryptoError::Random)?;
        let public: [u8; 32] = secret
            .compute_public_key()
            .map_err(|_| CryptoError::Random)?
            .as_ref()
            .try_into()
            .map_err(|_| CryptoError::Random)?;
        Ok(Self { secret, public })
    }

    /// The shared pairing secret, given the other side's public key. `host`
    /// and `join` are the two public keys, in that order.
    pub fn agree(
        self,
        peer: &[u8],
        code: &str,
        host: &[u8],
        join: &[u8],
    ) -> Result<Paired, CryptoError> {
        let shared = agree_ephemeral(self.secret, &UnparsedPublicKey::new(&X25519, peer), |s| {
            s.to_vec()
        })
        .map_err(|_| CryptoError::BadKey)?;
        let mut ctx = Vec::with_capacity(64);
        ctx.extend_from_slice(host);
        ctx.extend_from_slice(join);
        let ikm = [shared.as_slice(), &ctx].concat();
        Ok(Paired {
            key: derive::<KEY_LEN>(&ikm, code.as_bytes(), b"todocity pair key v1"),
            sas: sas(&derive::<4>(&ikm, code.as_bytes(), b"todocity pair sas v1")),
        })
    }
}

/// The result of a pairing exchange.
pub struct Paired {
    key: [u8; KEY_LEN],
    /// Six digits both people compare, e.g. `482 913`.
    pub sas: String,
}

impl Paired {
    pub fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
        seal_with(&self.key, plain)
    }
    pub fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
        open_with(&self.key, sealed)
    }
}

fn sas(b: &[u8; 4]) -> String {
    let n = u32::from_be_bytes(*b) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

/// The host's commitment to its key: sent before it sees the other key.
pub fn commitment(public: &[u8]) -> String {
    b64::encode_url(&Sha256::digest(public))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_round_trip_and_reject_other_keys() {
        let k = GroupKey::generate().unwrap();
        let sealed = k.seal(b"hello").unwrap();
        assert_ne!(&sealed[17..22], b"hello");
        assert_eq!(k.open(&sealed).unwrap(), b"hello");
        // Same plaintext, different box.
        assert_ne!(k.seal(b"hello").unwrap(), sealed);
        let other = GroupKey::generate().unwrap();
        assert_eq!(other.open(&sealed), Err(CryptoError::Open));
        let mut bent = sealed.clone();
        *bent.last_mut().unwrap() ^= 1;
        assert_eq!(k.open(&bent), Err(CryptoError::Open));
        assert_eq!(k.open(&[1, 2, 3]), Err(CryptoError::Open));
    }

    #[test]
    fn mailbox_names_come_from_the_key() {
        let k = GroupKey::generate().unwrap();
        let again = GroupKey::from_text(&k.to_text()).unwrap();
        assert_eq!(k.mailbox_id(), again.mailbox_id());
        assert_eq!(k.mailbox_id().len(), 24);
        assert_ne!(k.mailbox_id(), GroupKey::generate().unwrap().mailbox_id());
        assert_ne!(k.mailbox_token(), k.mailbox_id());
    }

    #[test]
    fn both_sides_of_a_pairing_agree() {
        let code = room_code().unwrap();
        let host = PairKey::generate().unwrap();
        let join = PairKey::generate().unwrap();
        let (hp, jp) = (host.public, join.public);
        let a = host.agree(&jp, &code, &hp, &jp).unwrap();
        let b = join.agree(&hp, &code, &hp, &jp).unwrap();
        assert_eq!(a.sas, b.sas);
        assert_eq!(a.sas.len(), 7);
        assert_eq!(b.open(&a.seal(b"invite").unwrap()).unwrap(), b"invite");

        // Someone in the middle with their own key ends up with other digits.
        let host2 = PairKey::generate().unwrap();
        let eve = PairKey::generate().unwrap();
        let (h2, ev) = (host2.public, eve.public);
        let c = host2.agree(&ev, &code, &h2, &ev).unwrap();
        let d = PairKey::generate().unwrap();
        let dp = d.public;
        let e = d.agree(&ev, &code, &ev, &dp).unwrap();
        assert_ne!(c.sas, e.sas);
    }

    #[test]
    fn codes_are_forgiving_to_type() {
        let c = room_code().unwrap();
        assert_eq!(c.len(), 8);
        assert_eq!(clean_code(&c), Some(c.clone()));
        let typed = format!("{}-{}", &c[..4], &c[4..]).to_lowercase();
        assert_eq!(clean_code(&typed), Some(c));
        assert_eq!(clean_code("k7mx 4qrb"), Some("K7MX4QRB".into()));
        assert_eq!(clean_code("short"), None);
    }
}
