// Secrets kept in the user's macOS login Keychain instead of the webview's
// localStorage (a plain file any process running as the user can read, and one
// that ends up in backups):
//
// - hub access tokens, one item per hub: service = the app identifier,
//   account = the hub address;
// - the device secret every client id is derived from (`identity.rs`), which
//   proves who you are to a hub, team ownership included: same service,
//   account `device-secret`. It never leaves this process: the webview only
//   ever gets the ids derived from it;
// - client ids pinned to one hub (an id from before per-hub ids, kept so
//   nobody loses their place): same service, account `client-id@<hub>`.
//
// Only the login keychain is used, opened by its path in the user's home
// directory (`login_keychain`): never "the default keychain" and never the
// whole search list. A process running as the same user can make a keychain
// whose password it knows the default (or add it to the search list); items
// written there, or read from there, would be its to read or plant.
//
// The webview can only reach these items through the commands in `lib.rs`:
// the service is fixed, the account is a checked hub address, `client-id@`
// plus one, or the one fixed name, and sizes are bounded, so it can't read or
// write any other item.
//
// Items are always created by this app: an existing item is deleted and a new
// one added, never updated in place. An update keeps the old item's access
// list, so a process running as the same user could otherwise pre-create the
// item with "any app may read this" and read what we store in it later.
//
// If the Keychain refuses to store a token (locked, the person clicked Deny),
// the token is kept in this process's memory until the app quits
// (`SESSION_TOKENS`) and the webview tells the person they'll have to enter it
// again; it is never written to web storage instead. On platforms without a
// Keychain the commands fail and the app keeps tokens in web storage (see
// `src/platform.ts`), which it says in the UI.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Url;

/// Longer than any real hub address or token; refuse anything bigger.
const MAX_HUB_LEN: usize = 512;
const MAX_TOKEN_LEN: usize = 512;
/// The device secret: base64url, 32-128 characters (the app makes 43).
const MIN_SECRET_LEN: usize = 32;
const MAX_SECRET_LEN: usize = 128;

/// The Keychain account of the device secret. Hub accounts start with `ws://`
/// or `wss://` (see `check_hub`) and pinned ids with `client-id@`, so they can
/// never be this.
pub const DEVICE_SECRET_ACCOUNT: &str = "device-secret";
const PINNED_ID_PREFIX: &str = "client-id@";

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

fn is_base64url(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn check_secret(secret: &str) -> Result<&str, String> {
    if (MIN_SECRET_LEN..=MAX_SECRET_LEN).contains(&secret.len()) && is_base64url(secret) {
        Ok(secret)
    } else {
        Err("not a device secret".into())
    }
}

/// What the hub accepts as a client id: `^[A-Za-z0-9_-]{16,64}$`
/// (`CLIENT_ID` in `src/identity.ts`).
pub fn check_client_id(id: &str) -> Result<&str, String> {
    if (16..=64).contains(&id.len()) && is_base64url(id) {
        Ok(id)
    } else {
        Err("not a client id".into())
    }
}

/// The Keychain account of the id pinned to `hub` (a checked hub address).
pub fn pinned_id_account(hub: &str) -> Result<String, String> {
    Ok(format!("{PINNED_ID_PREFIX}{}", check_hub(hub)?))
}

/// Tokens the Keychain wouldn't store (or delete) this run, by hub. While a hub
/// is in here, this is its token until the app quits (`""`: none), whatever
/// the Keychain holds; a later successful save takes it out again.
static SESSION_TOKENS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn session_token(hub: &str) -> Option<String> {
    SESSION_TOKENS.lock().ok()?.as_ref()?.get(hub).cloned()
}

fn set_session_token(hub: &str, token: Option<&str>) {
    if let Ok(mut map) = SESSION_TOKENS.lock() {
        let map = map.get_or_insert_with(HashMap::new);
        match token {
            Some(t) => map.insert(hub.to_string(), t.to_string()),
            None => map.remove(hub),
        };
    }
}

/// The token saved for `hub`, or None. A token kept in memory this run (the
/// Keychain refused it) comes first.
pub fn get(service: &str, hub: &str) -> Result<Option<String>, String> {
    check_hub(hub)?;
    if let Some(t) = session_token(hub) {
        return Ok(Some(t).filter(|t| !t.is_empty()));
    }
    keychain::get(service, hub)
}

/// Saves the token for `hub` in a new Keychain item; an empty token deletes it.
/// Returns None when the Keychain has it, or why it doesn't: the token is then
/// kept in memory until the app quits, and never written anywhere else.
pub fn set(service: &str, hub: &str, token: &str) -> Result<Option<String>, String> {
    check_hub(hub)?;
    check_token(token)?;
    let stored = if token.is_empty() {
        keychain::delete(service, hub)
    } else {
        keychain::replace(service, hub, token)
    };
    match stored {
        Ok(()) => {
            set_session_token(hub, None);
            Ok(None)
        }
        Err(problem) => {
            set_session_token(hub, Some(token));
            Ok(Some(problem))
        }
    }
}

#[cfg(target_os = "macos")]
pub mod keychain {
    use security_framework::base::Error;
    use security_framework::os::macos::keychain::SecKeychain;
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;
    /// errSecDuplicateItem
    const DUPLICATE: i32 = -25299;

    fn describe(e: Error) -> String {
        match e.message() {
            Some(m) => format!("Keychain error {}: {m}", e.code()),
            None => format!("Keychain error {}", e.code()),
        }
    }

    /// Where the user's login keychain lives, from the user database rather
    /// than `$HOME`, which whoever starts the app can set.
    fn login_keychain_path() -> Result<PathBuf, String> {
        let home = crate::user::home().ok_or("can't find your home folder")?;
        let dir = home.join("Library").join("Keychains");
        // Since macOS 10.12 the file is login.keychain-db; older ones kept login.keychain.
        let modern = dir.join("login.keychain-db");
        Ok(if modern.exists() { modern } else { dir.join("login.keychain") })
    }

    /// The user's login keychain, opened by its path: never the default
    /// keychain or the search list, which another process running as the
    /// user can change. Refuses unless it is a plain file the user owns.
    pub fn login_keychain() -> Result<SecKeychain, String> {
        let path = login_keychain_path()?;
        let refuse = |why: &str| Err(format!("Can't use your login keychain ({}): {why}", path.display()));
        match std::fs::symlink_metadata(&path) {
            Ok(m) if !m.file_type().is_file() => return refuse("it isn't a plain file"),
            Ok(m) if m.uid() != crate::user::uid() => return refuse("it belongs to another user"),
            Ok(_) => {}
            Err(e) => return refuse(&e.to_string()),
        }
        // SecKeychainOpen only makes a reference; the checks above made sure it
        // points at a real keychain file.
        SecKeychain::open(&path).map_err(|e| format!("Can't open your login keychain: {}", describe(e)))
    }

    pub fn get_in(kc: &SecKeychain, service: &str, account: &str) -> Result<Option<String>, String> {
        match kc.find_generic_password(service, account) {
            Ok((bytes, _item)) => {
                String::from_utf8(bytes.to_vec()).map(Some).map_err(|_| "Keychain item isn't text".into())
            }
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    pub fn delete_in(kc: &SecKeychain, service: &str, account: &str) -> Result<(), String> {
        // `delete` doesn't report failure, so look again afterwards.
        for _ in 0..2 {
            match kc.find_generic_password(service, account) {
                Ok((_, item)) => item.delete(),
                Err(e) if e.code() == NOT_FOUND => return Ok(()),
                Err(e) => return Err(describe(e)),
            }
        }
        match kc.find_generic_password(service, account) {
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(describe(e)),
            Ok(_) => Err("couldn't delete the Keychain item".into()),
        }
    }

    /// Deletes any existing item and adds a new one, so its access list is the
    /// default one for an item this app creates (only this app reads it without
    /// asking). Never updates an item in place. If one reappears between the
    /// delete and the add, try once more, then give up.
    pub fn replace_in(kc: &SecKeychain, service: &str, account: &str, value: &str) -> Result<(), String> {
        for _ in 0..2 {
            delete_in(kc, service, account)?;
            match kc.add_generic_password(service, account, value.as_bytes()) {
                Ok(()) => return Ok(()),
                Err(e) if e.code() == DUPLICATE => continue,
                Err(e) => return Err(describe(e)),
            }
        }
        Err("Keychain item keeps reappearing".into())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        get_in(&login_keychain()?, service, account)
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        delete_in(&login_keychain()?, service, account)
    }

    pub fn replace(service: &str, account: &str, value: &str) -> Result<(), String> {
        replace_in(&login_keychain()?, service, account, value)
    }
}

#[cfg(not(target_os = "macos"))]
pub mod keychain {
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
        // Never the device secret's account, a pinned id's, or any other item.
        assert!(check_hub(DEVICE_SECRET_ACCOUNT).is_err());
        assert!(check_hub("client-id@wss://breaks.example.com/ws").is_err());
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
    fn accepts_client_ids_only() {
        assert!(check_client_id("abcdef0123456789").is_ok());
        assert!(check_client_id(&"A_-".repeat(21)).is_ok());
        assert!(check_client_id(&"a".repeat(64)).is_ok());
        assert!(check_client_id(&"a".repeat(15)).is_err());
        assert!(check_client_id(&"a".repeat(65)).is_err());
        assert!(check_client_id("abcdef0123456789 ").is_err());
        assert!(check_client_id("abcdef012345678é").is_err());
    }

    #[test]
    fn pinned_id_accounts_are_derived_from_a_checked_hub() {
        assert_eq!(pinned_id_account("wss://h.example/ws").unwrap(), "client-id@wss://h.example/ws");
        assert!(pinned_id_account("WSS://h.example/ws").is_err());
        assert!(pinned_id_account(DEVICE_SECRET_ACCOUNT).is_err());
        assert_ne!(pinned_id_account("wss://h.example/ws").unwrap(), DEVICE_SECRET_ACCOUNT);
    }

    #[test]
    fn refuses_bad_input_before_touching_the_keychain() {
        let service = "com.smokebreak.desktop.test";
        assert!(set(service, "https://not-a-hub/", "t").is_err());
        assert!(set(service, "wss://h.example/ws", &"t".repeat(600)).is_err());
        assert!(get(service, "device-secret").is_err());
    }

    /// Against a keychain file made for the test (never the login keychain or
    /// the default). SecKeychainCreate also adds a new keychain to the user's
    /// search list, so this only runs on request, and removes it from the list
    /// again (`security delete-keychain`) before deleting the folder:
    /// `cargo test -- --ignored temp_keychain_round_trip`
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn temp_keychain_round_trip() {
        use security_framework::os::macos::keychain::CreateOptions;
        let dir = std::env::temp_dir().join(format!("sb-kc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.keychain");
        let kc = CreateOptions::new().password("test-only").create(&path).unwrap();
        let (service, hub) = ("com.smokebreak.desktop.test", "wss://round-trip.example/ws");
        let result = std::panic::catch_unwind(|| {
            keychain::replace_in(&kc, service, hub, "t0ken").unwrap();
            assert_eq!(keychain::get_in(&kc, service, hub).unwrap().as_deref(), Some("t0ken"));
            keychain::replace_in(&kc, service, hub, "changed").unwrap();
            assert_eq!(keychain::get_in(&kc, service, hub).unwrap().as_deref(), Some("changed"));
            keychain::delete_in(&kc, service, hub).unwrap();
            assert_eq!(keychain::get_in(&kc, service, hub).unwrap(), None);
            // Deleting what isn't there is fine.
            keychain::delete_in(&kc, service, hub).unwrap();
        });
        drop(kc);
        let _ = std::process::Command::new("/usr/bin/security").arg("delete-keychain").arg(&path).status();
        let _ = std::fs::remove_dir_all(&dir);
        result.unwrap();
    }
}
