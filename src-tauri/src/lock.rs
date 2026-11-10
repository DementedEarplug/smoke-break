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
// frontend is built with, and the build record says) as one marker string,
// `sb-lock:v1:<on|off>:<hub> :end`. It stays in the binary as is and is read
// from there at run time, so `npm run desktop:build:enterprise -- --check`,
// which reads the same marker in a built app, sees the lock the commands obey.

use std::sync::OnceLock;
use tauri::Url;

/// The frontend's default hub (`DEFAULT_SERVER` in src/platform.ts), used when
/// a build is locked without `VITE_SERVER_URL`.
const DEFAULT_SERVER: &str = "ws://localhost:8787/ws";

/// The lock as `build.rs` compiled it in.
#[used]
static LOCK_MARKER: &str = env!("SMOKE_BREAK_LOCK_MARKER");

/// The hub this build is locked to, in the form the webview files per-hub data
/// under (`hubKey` in src/serverUrl.ts), or None for an unlocked build. A
/// locked build whose address can't be parsed is locked to "" (no hub at all).
pub fn locked_hub() -> Option<&'static str> {
    static HUB: OnceLock<Option<String>> = OnceLock::new();
    // Read through `black_box` so the compiler can't fold the marker away:
    // what is in the binary is what decides.
    HUB.get_or_init(|| from_marker(std::hint::black_box(LOCK_MARKER))).as_deref()
}

/// The built-in hub from a lock marker. Anything but a well-formed marker
/// locks the build to no hub at all.
fn from_marker(marker: &str) -> Option<String> {
    // Split rather than matched against a "sb-lock:v1:" prefix, so that text
    // is in the binary only as part of the marker itself.
    let fields = marker.strip_suffix(" :end").map(|m| m.splitn(4, ':').collect::<Vec<_>>());
    match fields.as_deref() {
        Some(["sb-lock", "v1", "off", _]) => None,
        Some(["sb-lock", "v1", "on", server]) => built_in_hub(true, server),
        _ => Some(String::new()),
    }
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
    fn the_marker_decides_the_lock() {
        assert_eq!(from_marker("sb-lock:v1:off: :end"), None);
        assert_eq!(from_marker("sb-lock:v1:off:wss://breaks.acme.example/ws :end"), None);
        assert_eq!(from_marker("sb-lock:v1:on:wss://breaks.acme.example/ws :end").as_deref(), Some(HUB));
        assert_eq!(from_marker("sb-lock:v1:on:wss://breaks.acme.example:8443/ws :end").as_deref(), Some("wss://breaks.acme.example:8443/ws"));
        assert_eq!(from_marker("sb-lock:v1:on: :end").as_deref(), Some(DEFAULT_SERVER));
        // Anything else: locked to no hub at all.
        for bad in ["", "sb-lock:v1:on:wss://breaks.acme.example/ws", "sb-lock:v2:off: :end", "sb-lock:v1:maybe:x :end"] {
            assert_eq!(from_marker(bad).as_deref(), Some(""), "{bad:?}");
        }
    }

    #[test]
    fn this_build_carries_its_marker() {
        assert!(LOCK_MARKER.starts_with("sb-lock:v1:") && LOCK_MARKER.ends_with(" :end"), "{LOCK_MARKER}");
        assert_eq!(locked_hub().map(str::to_owned), from_marker(LOCK_MARKER));
    }

    #[test]
    fn this_build_follows_its_build_record() {
        // `cargo test` runs unlocked unless VITE_LOCK_SERVER was set for it.
        let record = env!("SMOKE_BREAK_BUILD_INFO");
        assert_eq!(locked_hub().is_some(), record.contains(" lock=on "), "{record}");
    }
}
