// Secrets kept in the macOS login Keychain instead of the webview's
// localStorage (a plain file any process running as the user can read, and one
// that ends up in backups):
//
// - hub access tokens, one item per hub: service = the app identifier,
//   account = the hub address;
// - the device secret every client id is derived from (`src/identity.ts`),
//   which proves who you are to a hub, team ownership included: same service,
//   account `device-secret`.
//
// The webview can only reach these items through the commands in `lib.rs`:
// the service is fixed, the account is a checked hub address or the one fixed
// name, and sizes are bounded, so it can't read or write any other item.
//
// Items are always created by this app: an existing item is deleted and a new
// one added, never updated in place. An update keeps the old item's access
// list, so a process running as the same user could otherwise pre-create the
// item with "any app may read this" and read what we store in it later.
//
// On other platforms the commands fail and the app keeps both in web storage
// instead (see `src/platform.ts`).

use std::sync::Mutex;
use tauri::Url;

/// Longer than any real hub address or token; refuse anything bigger.
const MAX_HUB_LEN: usize = 512;
const MAX_TOKEN_LEN: usize = 512;
/// The device secret: base64url, 32-128 characters (the app makes 43).
const MIN_SECRET_LEN: usize = 32;
const MAX_SECRET_LEN: usize = 128;

/// The Keychain account of the device secret. Hub accounts start with `ws://`
/// or `wss://` (see `check_hub`), so they can never be this.
pub const DEVICE_SECRET_ACCOUNT: &str = "device-secret";

/// The Keychain account for a hub: only a hub address the app could connect to,
/// in the canonical form the app files per-hub data under (`hubKey` in
/// `src/serverUrl.ts`: parsed and re-serialized, no fragment).
pub fn check_hub(hub: &str) -> Result<&str, String> {
    let bad = || Err("not a hub address".to_string());
    if hub.is_empty() || hub.len() > MAX_HUB_LEN || hub.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad();
    }
    let Ok(url) = Url::parse(hub) else { return bad() };
    let ok = matches!(url.scheme(), "ws" | "wss")
        && url.host_str().is_some_and(|h| !h.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        // Already canonical, so one hub can't hide behind several spellings.
        && url.as_str() == hub;
    if ok {
        Ok(hub)
    } else {
        bad()
    }
}

pub fn check_token(token: &str) -> Result<&str, String> {
    if token.len() > MAX_TOKEN_LEN || token.chars().any(char::is_control) {
        return Err("not an access token".into());
    }
    Ok(token)
}

pub fn check_secret(secret: &str) -> Result<&str, String> {
    let ok = (MIN_SECRET_LEN..=MAX_SECRET_LEN).contains(&secret.len())
        && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(secret)
    } else {
        Err("not a device secret".into())
    }
}

/// The token saved for `hub`, or None.
pub fn get(service: &str, hub: &str) -> Result<Option<String>, String> {
    keychain::get(service, hub)
}

/// Saves the token for `hub` in a new item; an empty token deletes it.
pub fn set(service: &str, hub: &str, token: &str) -> Result<(), String> {
    if token.is_empty() {
        keychain::delete(service, hub)
    } else {
        keychain::replace(service, hub, token)
    }
}

/// The device secret, or None if there is none (or it isn't one).
pub fn secret_get(service: &str) -> Result<Option<String>, String> {
    Ok(keychain::get(service, DEVICE_SECRET_ACCOUNT)?.filter(|s| check_secret(s).is_ok()))
}

/// The secret this run of the app created, so the second window gets the
/// first one's instead of replacing it.
static CREATED: Mutex<Option<String>> = Mutex::new(None);

/// Replaces any device-secret item with a new one holding `secret`, once per
/// run of the app, and returns the secret now stored. Later calls in the same
/// run return the first one's secret and change nothing.
pub fn secret_create(service: &str, secret: &str) -> Result<String, String> {
    check_secret(secret)?;
    let mut created = CREATED.lock().map_err(|_| "busy".to_string())?;
    if let Some(s) = created.as_ref() {
        return Ok(s.clone());
    }
    keychain::replace(service, DEVICE_SECRET_ACCOUNT, secret)?;
    *created = Some(secret.to_string());
    Ok(secret.to_string())
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::base::Error;
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::passwords::{delete_generic_password, get_generic_password};

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;
    /// errSecDuplicateItem
    const DUPLICATE: i32 = -25299;

    fn describe(e: Error) -> String {
        format!("Keychain error {}", e.code())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        match get_generic_password(service, account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "item isn't text".into()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        match delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(describe(e)),
        }
    }

    /// Deletes any existing item and adds a new one, so its access list is the
    /// default one for an item this app creates (only this app reads it without
    /// asking). Never updates an item in place. If one reappears between the
    /// delete and the add, try once more, then give up.
    pub fn replace(service: &str, account: &str, value: &str) -> Result<(), String> {
        let keychain = SecKeychain::default().map_err(describe)?;
        for _ in 0..2 {
            delete(service, account)?;
            match keychain.add_generic_password(service, account, value.as_bytes()) {
                Ok(()) => return Ok(()),
                Err(e) if e.code() == DUPLICATE => continue,
                Err(e) => return Err(describe(e)),
            }
        }
        Err("Keychain item keeps reappearing".into())
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    const UNSUPPORTED: &str = "no Keychain on this platform";

    pub fn get(_service: &str, _account: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete(_service: &str, _account: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn replace(_service: &str, _account: &str, _value: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_hub_addresses_only() {
        assert!(check_hub("wss://breaks.example.com/ws").is_ok());
        assert!(check_hub("wss://breaks.example.com:8443/ws").is_ok());
        assert!(check_hub("ws://localhost:8787/ws").is_ok());
        assert!(check_hub("ws://[::1]:8787/ws").is_ok());
        assert!(check_hub("wss://breaks.example.com/").is_ok());
        assert!(check_hub("").is_err());
        assert!(check_hub("https://example.com/").is_err());
        assert!(check_hub("wss://a b/ws").is_err());
        assert!(check_hub("wss://a/\n").is_err());
        assert!(check_hub(&format!("wss://{}.example/", "a".repeat(600))).is_err());
        // Never the device secret's account, or any other item.
        assert!(check_hub(DEVICE_SECRET_ACCOUNT).is_err());
        // Not canonical: the app files per-hub data under the canonical form only.
        assert!(check_hub("WSS://Breaks.Example.com/ws").is_err());
        assert!(check_hub("wss://breaks.example.com:443/ws").is_err());
        assert!(check_hub("wss://breaks.example.com").is_err());
        assert!(check_hub("wss://breaks.example.com/ws#x").is_err());
        assert!(check_hub("wss://user:pw@breaks.example.com/ws").is_err());
        assert!(check_hub("wss:///ws").is_err());
    }

    #[test]
    fn accepts_tokens_up_to_the_limit() {
        assert!(check_token("").is_ok());
        assert!(check_token(&"t".repeat(512)).is_ok());
        assert!(check_token(&"t".repeat(513)).is_err());
        assert!(check_token("a\u{0}b").is_err());
    }

    #[test]
    fn accepts_device_secrets_only() {
        assert!(check_secret(&"S".repeat(43)).is_ok());
        assert!(check_secret("Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab").is_ok());
        assert!(check_secret(&"S".repeat(128)).is_ok());
        assert!(check_secret(&"S".repeat(31)).is_err());
        assert!(check_secret(&"S".repeat(129)).is_err());
        assert!(check_secret(&format!("{}+/", "S".repeat(40))).is_err());
        assert!(check_secret(&format!("{}é", "S".repeat(40))).is_err());
        assert!(check_secret("").is_err());
    }

    #[test]
    fn refuses_a_bad_secret_before_touching_the_keychain() {
        assert!(secret_create("com.smokebreak.desktop.test", "short").is_err());
        assert!(CREATED.lock().unwrap().is_none());
    }

    /// Writes to the real login Keychain, so it only runs on request:
    /// `cargo test -- --ignored keychain_round_trip`
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn keychain_round_trip() {
        let (service, hub) = ("com.smokebreak.desktop.test", "wss://round-trip.example/ws");
        set(service, hub, "t0ken").unwrap();
        assert_eq!(get(service, hub).unwrap().as_deref(), Some("t0ken"));
        set(service, hub, "changed").unwrap();
        assert_eq!(get(service, hub).unwrap().as_deref(), Some("changed"));
        set(service, hub, "").unwrap();
        assert_eq!(get(service, hub).unwrap(), None);
        // Deleting what isn't there is fine.
        set(service, hub, "").unwrap();

        let secret = "S".repeat(43);
        assert_eq!(secret_create(service, &secret).unwrap(), secret);
        // The second window gets the first one's secret; nothing is replaced.
        assert_eq!(secret_create(service, &"T".repeat(43)).unwrap(), secret);
        assert_eq!(secret_get(service).unwrap().as_deref(), Some(secret.as_str()));
        keychain::delete(service, DEVICE_SECRET_ACCOUNT).unwrap();
        assert_eq!(secret_get(service).unwrap(), None);
    }
}
