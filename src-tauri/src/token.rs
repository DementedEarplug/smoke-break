// Hub access tokens, kept in the macOS login Keychain instead of the webview's
// localStorage (a plain file any process running as the user can read, and one
// that ends up in backups). One item per hub: service = the app identifier,
// account = the hub address. Other apps that ask for an item get a Keychain
// prompt; the webview itself can still read the token through these commands,
// which is what it needs it for.
//
// On other platforms the commands fail and the app keeps the token in web
// storage instead (see `src/platform.ts`).

/// Longer than any real hub address or token; refuse anything bigger.
const MAX_HUB_LEN: usize = 512;
const MAX_TOKEN_LEN: usize = 512;

/// The Keychain account for a hub: only hub addresses the app could connect to.
pub fn check_hub(hub: &str) -> Result<&str, String> {
    let ok = !hub.is_empty()
        && hub.len() <= MAX_HUB_LEN
        && (hub.starts_with("wss://") || hub.starts_with("ws://"))
        && !hub.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok {
        Ok(hub)
    } else {
        Err("not a hub address".into())
    }
}

pub fn check_token(token: &str) -> Result<&str, String> {
    if token.len() > MAX_TOKEN_LEN || token.chars().any(char::is_control) {
        return Err("not an access token".into());
    }
    Ok(token)
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::base::Error;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    fn describe(e: Error) -> String {
        format!("Keychain error {}", e.code())
    }

    pub fn get(service: &str, hub: &str) -> Result<Option<String>, String> {
        match get_generic_password(service, hub) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "token isn't text".into()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    pub fn set(service: &str, hub: &str, token: &str) -> Result<(), String> {
        if token.is_empty() {
            return match delete_generic_password(service, hub) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == NOT_FOUND => Ok(()),
                Err(e) => Err(describe(e)),
            };
        }
        set_generic_password(service, hub, token.as_bytes()).map_err(describe)
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    const UNSUPPORTED: &str = "no Keychain on this platform";

    pub fn get(_service: &str, _hub: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn set(_service: &str, _hub: &str, _token: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

pub use keychain::{get, set};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_hub_addresses_only() {
        assert!(check_hub("wss://breaks.example.com/ws").is_ok());
        assert!(check_hub("ws://localhost:8787/ws").is_ok());
        assert!(check_hub("").is_err());
        assert!(check_hub("https://example.com").is_err());
        assert!(check_hub("wss://a b/ws").is_err());
        assert!(check_hub("wss://a/\n").is_err());
        assert!(check_hub(&format!("wss://{}", "a".repeat(600))).is_err());
    }

    #[test]
    fn accepts_tokens_up_to_the_limit() {
        assert!(check_token("").is_ok());
        assert!(check_token(&"t".repeat(512)).is_ok());
        assert!(check_token(&"t".repeat(513)).is_err());
        assert!(check_token("a\u{0}b").is_err());
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
    }
}
