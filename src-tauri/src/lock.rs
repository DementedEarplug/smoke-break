// A build locked to one hub (`VITE_LOCK_SERVER=1`, which
// `desktop:build:enterprise` always sets) talks to the built-in hub only. The
// frontend hides the Server field and ignores a saved address; this is the
// native side of the same lock: every command that takes a hub address
// (`token_get`, `token_set`, `client_id_pin`, `client_id`) refuses any hub but
// the built-in one. So even script running in a webview can't ask for this
// device's id on another hub, read a token filed under one, or plant tokens or
// ids for one.
//
// `build.rs` passes the lock and the hub address in (the same environment the
// frontend is built with, and the build record says).

use std::sync::OnceLock;
use tauri::Url;

/// The frontend's default hub (`DEFAULT_SERVER` in src/platform.ts), used when
/// a build is locked without `VITE_SERVER_URL`.
const DEFAULT_SERVER: &str = "ws://localhost:8787/ws";

/// The hub this build is locked to, in the form the webview files per-hub data
/// under (`hubKey` in src/serverUrl.ts), or None for an unlocked build. A
/// locked build whose address can't be parsed is locked to "" (no hub at all).
pub fn locked_hub() -> Option<&'static str> {
    static HUB: OnceLock<Option<String>> = OnceLock::new();
    HUB.get_or_init(|| built_in_hub(env!("SMOKE_BREAK_LOCK") == "on", env!("SMOKE_BREAK_SERVER"))).as_deref()
}

fn built_in_hub(locked: bool, server: &str) -> Option<String> {
    if !locked {
        return None;
    }
    let raw = match server.trim() {
        "" => DEFAULT_SERVER,
        s => s,
    };
    Some(match Url::parse(raw) {
        Ok(mut url) => {
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => String::new(),
    })
}

/// Refuses `hub` unless the build is unlocked or it is the built-in hub.
pub fn check(hub: &str, locked_to: Option<&str>) -> Result<(), String> {
    match locked_to {
        Some(built_in) if hub != built_in => Err("this build only talks to its built-in hub".into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUB: &str = "wss://breaks.acme.example/ws";

    #[test]
    fn an_unlocked_build_allows_any_hub() {
        assert_eq!(built_in_hub(false, HUB), None);
        assert!(check("wss://elsewhere.example/ws", None).is_ok());
        assert!(check(HUB, None).is_ok());
    }

    #[test]
    fn a_locked_build_allows_only_its_built_in_hub() {
        let built_in = built_in_hub(true, HUB);
        assert_eq!(built_in.as_deref(), Some(HUB));
        assert!(check(HUB, built_in.as_deref()).is_ok());
        for other in [
            "wss://elsewhere.example/ws",
            "wss://breaks.acme.example/other",
            "wss://breaks.acme.example:8443/ws",
            "ws://breaks.acme.example/ws",
            "wss://breaks.acme.example.evil.example/ws",
            "",
        ] {
            assert!(check(other, built_in.as_deref()).is_err(), "{other:?} should be refused");
        }
    }

    #[test]
    fn the_built_in_hub_is_in_the_form_the_webview_files_it_under() {
        // Like `hubKey`: trimmed, parsed and re-serialized, no fragment.
        assert_eq!(built_in_hub(true, " WSS://Breaks.Acme.example:443/ws#x ").as_deref(), Some(HUB));
        assert_eq!(built_in_hub(true, "wss://breaks.acme.example").as_deref(), Some("wss://breaks.acme.example/"));
        // Locked without an address: the frontend's default hub.
        assert_eq!(built_in_hub(true, "").as_deref(), Some(DEFAULT_SERVER));
    }

    #[test]
    fn a_locked_build_with_an_unusable_address_allows_no_hub() {
        let built_in = built_in_hub(true, "not a url");
        assert_eq!(built_in.as_deref(), Some(""));
        assert!(check(HUB, built_in.as_deref()).is_err());
        assert!(check(DEFAULT_SERVER, built_in.as_deref()).is_err());
    }

    #[test]
    fn this_build_follows_its_build_record() {
        // `cargo test` runs unlocked unless VITE_LOCK_SERVER was set for it.
        let record = env!("SMOKE_BREAK_BUILD_INFO");
        assert_eq!(locked_hub().is_some(), record.contains(" lock=on "), "{record}");
    }
}
