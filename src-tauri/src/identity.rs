// Who this device is to a hub, on the desktop app with a Keychain (macOS).
//
// The client id is the only proof of who you are (and of team ownership), so a
// hub must not be able to learn an id that works on another hub. Each device
// keeps one random secret and derives a different id for every hub from it:
// HMAC-SHA256(secret, label + hub address), base64url. The same derivation
// runs in `src/identity.ts` for the browser version; both are checked against
// `shared/client-id-vectors.json`, so existing installs keep their ids.
//
// Here the device secret lives in the login Keychain (`token.rs`) and never
// leaves this process: the webview asks for "my client id for hub X" and gets
// only that id. An id pinned to one hub (from before per-hub ids) is kept in
// the Keychain too and returned as it is.

use crate::token::{self, keychain, DEVICE_SECRET_ACCOUNT};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

/// Must match `DERIVE_LABEL` in `src/identity.ts`.
const DERIVE_LABEL: &str = "smoke-break client id v1\n";

const BLOCK: usize = 64;

/// HMAC-SHA256 (RFC 2104) over `sha2`, which the build already has; checked
/// against RFC 4231 below.
fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    for p in parts {
        inner.update(p);
    }
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// base64url without padding (`base64url` in `src/identity.ts`).
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (u32::from(b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char);
        }
    }
    out
}

/// This device's id for `hub`: 43 base64url characters.
pub fn derive(secret: &str, hub: &str) -> String {
    base64url(&hmac_sha256(secret.as_bytes(), &[DERIVE_LABEL.as_bytes(), hub.as_bytes()]))
}

/// A new device secret: 32 random bytes, base64url (43 characters).
#[cfg(target_os = "macos")]
fn new_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    // SAFETY: writes exactly `bytes.len()` bytes into `bytes`; can't fail.
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    Ok(base64url(&bytes))
}

#[cfg(not(target_os = "macos"))]
fn new_secret() -> Result<String, String> {
    Err("no Keychain on this platform".into())
}

/// The device secret for this run, once `init` has found or stored it.
static SECRET: Mutex<Option<String>> = Mutex::new(None);

/// How the webview found the device secret's state (see `moveToKeychain` in
/// `src/identity.ts`).
pub enum Start<'a> {
    /// A secret from web storage (an install from before the Keychain): it
    /// replaces any Keychain item, so ids stay the same.
    Import(&'a str),
    /// The secret was stored in the Keychain earlier: read it. If it is gone
    /// (deleted by hand), a new one is made.
    Stored,
    /// No secret yet: make one, replacing any item someone else put there.
    Fresh,
}

/// Loads (or stores) the device secret, once per run of the app: later calls
/// (the other window) change nothing. Fails, and can be called again, if the
/// Keychain refuses; nothing is made up in the meantime.
pub fn init(service: &str, start: Start) -> Result<(), String> {
    let mut secret = SECRET.lock().map_err(|_| "busy".to_string())?;
    if secret.is_some() {
        return Ok(());
    }
    let value = match start {
        Start::Import(s) => {
            token::check_secret(s)?;
            keychain::replace(service, DEVICE_SECRET_ACCOUNT, s)?;
            s.to_string()
        }
        Start::Stored => match keychain::get(service, DEVICE_SECRET_ACCOUNT)? {
            Some(s) if token::check_secret(&s).is_ok() => s,
            _ => store_new(service)?,
        },
        Start::Fresh => store_new(service)?,
    };
    *secret = Some(value);
    Ok(())
}

fn store_new(service: &str) -> Result<String, String> {
    let s = new_secret()?;
    keychain::replace(service, DEVICE_SECRET_ACCOUNT, &s)?;
    Ok(s)
}

/// Keeps `id` as this device's id for `hub` (an id from before per-hub ids).
pub fn pin(service: &str, hub: &str, id: &str) -> Result<(), String> {
    let account = token::pinned_id_account(hub)?;
    token::check_client_id(id)?;
    keychain::replace(service, &account, id)
}

/// This device's client id for `hub`: the pinned one if the webview says there
/// is one, else derived from the device secret. Fails rather than make up an
/// id, which would lose the person's place and ownership.
pub fn client_id(service: &str, hub: &str, pinned: bool) -> Result<String, String> {
    let account = token::pinned_id_account(hub)?;
    if pinned {
        if let Some(id) = keychain::get(service, &account)?.filter(|id| token::check_client_id(id).is_ok()) {
            return Ok(id);
        }
    }
    let secret = SECRET.lock().map_err(|_| "busy".to_string())?;
    let secret = secret.as_deref().ok_or("the device secret isn't loaded yet")?;
    Ok(derive(secret, hub))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 1.
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], &[b"Hi There"])),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // Test case 2, the message in two parts.
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"])),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test case 6: a key longer than the block is hashed first.
        assert_eq!(
            hex(&hmac_sha256(&[0xaa; 131], &[b"Test Using Larger Than Block-Size Key - Hash Key First"])),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn base64url_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff, 0xbf]), "-_-_");
    }

    /// The same cases `src/identity.test.ts` checks the WebCrypto derivation
    /// against: existing installs must keep their ids byte for byte.
    #[test]
    fn derives_the_same_ids_as_the_webview() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/client-id-vectors.json")).expect("valid JSON");
        assert_eq!(v["label"].as_str(), Some(DERIVE_LABEL));
        let cases = v["cases"].as_array().expect("cases");
        assert!(cases.len() >= 5, "the shared cases went missing");
        for c in cases {
            let (secret, hub, id) = (c["secret"].as_str().unwrap(), c["hub"].as_str().unwrap(), c["id"].as_str().unwrap());
            assert_eq!(derive(secret, hub), id, "secret {secret:?}, hub {hub:?}");
        }
    }

    #[test]
    fn derived_ids_are_client_ids() {
        let id = derive(&"S".repeat(43), "wss://h.example/ws");
        assert_eq!(id.len(), 43);
        assert!(token::check_client_id(&id).is_ok());
        assert_ne!(id, derive(&"S".repeat(43), "wss://other.example/ws"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn new_secrets_are_device_secrets_and_differ() {
        let (a, b) = (new_secret().unwrap(), new_secret().unwrap());
        assert_eq!(a.len(), 43);
        assert!(token::check_secret(&a).is_ok());
        assert_ne!(a, b);
    }

    #[test]
    fn refuses_bad_input_and_never_makes_up_an_id() {
        let service = "com.smokebreak.desktop.test";
        assert!(pin(service, "wss://h.example/ws", "short").is_err());
        assert!(pin(service, "WSS://h.example/ws", "abcdef0123456789").is_err());
        assert!(client_id(service, "not a hub", false).is_err());
        assert!(init(service, Start::Import("short")).is_err());
        // Nothing loaded: no id rather than one from a made-up secret.
        assert!(SECRET.lock().unwrap().is_none());
        assert!(client_id(service, "wss://h.example/ws", false).is_err());
    }
}
