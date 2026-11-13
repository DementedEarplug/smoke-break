// Which meeting links the app is willing to open.
//
// Links come from the hub, which a team owner (or anyone who can pose as the
// hub) controls. Different URL parsers disagree about odd input: for
// `https://zoom.us\@evil.example/` a browser-style parser sees host `zoom.us`
// while macOS's own parser sees `evil.example`. So this refuses anything a
// parser could read two ways, parses with the `url` crate (WHATWG rules),
// compares the host exactly, and only the re-serialized URL is ever opened.
// Zoom also hosts pages people write themselves, so only meeting paths pass.
//
// `normalizeMeetingLink` in shared/protocol.ts applies the same rules; both run
// the cases in shared/meeting-links.json, so keep them in step.

use tauri::Url;

/// Meeting services we open links for (the host itself or any subdomain).
pub const MEETING_HOSTS: [&str; 3] = ["zoom.us", "zoom.com", "zoomgov.com"];

/// A company can build the app to open only its own Zoom host, e.g.
/// `SMOKE_BREAK_MEETING_HOST=acme.zoom.us npm run desktop:build`.
pub const PINNED_HOST: Option<&str> = option_env!("SMOKE_BREAK_MEETING_HOST");

const MAX_LEN: usize = 2000;

fn is_meeting_host(host: &str) -> bool {
    // No empty labels (".zoom.us", "a..zoom.us"), so "a subdomain" means a real one.
    !host.split('.').any(str::is_empty)
        && MEETING_HOSTS
            .iter()
            .any(|h| host == *h || host.strip_suffix(h).is_some_and(|rest| rest.ends_with('.') && rest.len() > 1))
}

/// `/j/<digits>`, `/w/<digits>`, `/s/<digits>`, `/wc/join/<digits>` or
/// `/my/<name>`, and nothing else (same as `MEETING_PATH` in shared/protocol.ts).
fn is_meeting_path(path: &str) -> bool {
    let number = |s: &str| (1..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    let name = |s: &str| {
        (1..=64).contains(&s.len())
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    if let Some(rest) = path.strip_prefix("/wc/join/") {
        return number(rest);
    }
    if let Some(rest) = path.strip_prefix("/my/") {
        return name(rest);
    }
    ["/j/", "/w/", "/s/"].iter().any(|p| path.strip_prefix(p).is_some_and(number))
}

/// Returns the canonical URL to open, or why the link was refused.
pub fn check(raw: &str, pinned: Option<&str>) -> Result<Url, String> {
    let mut url = check_host(raw, pinned)?;
    if !is_meeting_path(url.path()) {
        return Err("meeting link must be a Zoom meeting link (https://…zoom.us/j/<number>)".into());
    }
    // The query carries the passcode; the fragment is never needed.
    url.set_fragment(None);
    Ok(url)
}

fn check_host(raw: &str, pinned: Option<&str>) -> Result<Url, String> {
    if raw.is_empty() || raw.len() > MAX_LEN {
        return Err("meeting link is empty or too long".into());
    }
    // Backslashes, whitespace and control characters are where parsers disagree.
    if raw.chars().any(|c| c == '\\' || c.is_whitespace() || c.is_control()) {
        return Err("meeting link contains characters that aren't allowed".into());
    }
    let url = Url::parse(raw).map_err(|e| format!("meeting link isn't a URL: {e}"))?;
    if url.scheme() != "https" {
        return Err("meeting link must use https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("meeting link must not contain a user name or password".into());
    }
    // `port()` is None for the scheme's default port (443), which is fine.
    if url.port().is_some() {
        return Err("meeting link must not name a port".into());
    }
    // `domain()` is None for IP addresses, which no meeting service uses.
    let host = url.domain().ok_or("meeting link must name a host")?;
    if !is_meeting_host(host) {
        return Err(format!("{host} is not a Zoom host"));
    }
    if let Some(pin) = pinned.map(str::trim).filter(|p| !p.is_empty()) {
        if !host.eq_ignore_ascii_case(pin) {
            return Err(format!("this build only opens {pin} links"));
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases shared with the TypeScript validator (shared/protocol.test.ts).
    const VECTORS: &str = include_str!("../../shared/meeting-links.json");

    fn ok(raw: &str) -> String {
        check(raw, None).unwrap_or_else(|e| panic!("{raw:?} refused: {e}")).to_string()
    }

    fn refused(raw: &str) {
        assert!(check(raw, None).is_err(), "{raw:?} should be refused");
    }

    #[test]
    fn agrees_with_the_shared_cases() {
        let v: serde_json::Value = serde_json::from_str(VECTORS).expect("meeting-links.json is valid JSON");
        let accept = v["accept"].as_array().expect("accept list");
        let reject = v["reject"].as_array().expect("reject list");
        assert!(accept.len() > 5 && reject.len() > 20, "the shared cases went missing");
        for pair in accept {
            let (raw, canonical) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
            assert_eq!(ok(raw), canonical, "for {raw:?}");
        }
        for raw in reject {
            refused(raw.as_str().unwrap());
        }
    }

    #[test]
    fn accepts_meeting_paths() {
        assert_eq!(ok("https://zoom.us/j/123?pwd=abc"), "https://zoom.us/j/123?pwd=abc");
        assert_eq!(ok("https://acme.zoom.us/w/123?tk=x"), "https://acme.zoom.us/w/123?tk=x");
        assert_eq!(ok("https://acme.zoom.us/s/123"), "https://acme.zoom.us/s/123");
        assert_eq!(ok("https://acme.zoom.us/my/sam.smith"), "https://acme.zoom.us/my/sam.smith");
        assert_eq!(ok("https://app.zoom.us/wc/join/123"), "https://app.zoom.us/wc/join/123");
        assert_eq!(ok(&format!("https://zoom.us/j/{}", "9".repeat(20))), format!("https://zoom.us/j/{}", "9".repeat(20)));
        assert_eq!(ok(&format!("https://zoom.us/my/a{}", "b".repeat(63))), format!("https://zoom.us/my/a{}", "b".repeat(63)));
    }

    #[test]
    fn refuses_other_paths() {
        refused("https://zoom.us/");
        refused("https://zoom.us/signin");
        refused("https://zoom.us/rec/share/abc");
        refused("https://zoom.us/j/");
        refused("https://zoom.us/j/12a");
        refused("https://zoom.us/j/1/");
        refused("https://zoom.us/J/1");
        refused(&format!("https://zoom.us/j/{}", "9".repeat(21)));
        refused(&format!("https://zoom.us/my/a{}", "b".repeat(64)));
        refused("https://zoom.us/my/-x");
        refused("https://zoom.us/my/a/b");
        refused("https://zoom.us/wc/123/join");
        refused("https://zoom.us/j/1/../../signin");
    }

    #[test]
    fn keeps_the_query_and_drops_the_fragment() {
        assert_eq!(ok("https://zoom.us/j/1?pwd=a&omn=2#frag"), "https://zoom.us/j/1?pwd=a&omn=2");
        assert_eq!(ok("https://zoom.us/j/1#"), "https://zoom.us/j/1");
    }

    #[test]
    fn opens_the_canonical_form() {
        assert_eq!(ok("https://ZOOM.us/j/1"), "https://zoom.us/j/1");
        assert_eq!(ok("https://zoom.us:443/j/1"), "https://zoom.us/j/1");
        assert_eq!(ok("https://zo%6Fm.us/j/1"), "https://zoom.us/j/1");
    }

    #[test]
    fn refuses_parser_confusion() {
        // The audit's bypass: macOS reads the host as evil.example.
        refused(r"https://zoom.us\@evil.example/.zoom.us/x");
        refused(r"https://zoom.us\.evil.example/");
        refused("https://evil.example/.zoom.us/x");
        refused("https://evil.example/?u=https://zoom.us/");
        refused("https://evil.example#.zoom.us");
    }

    #[test]
    fn refuses_lookalike_hosts() {
        refused("https://zoom.us.evil.example/j/1");
        refused("https://evilzoom.us/j/1");
        refused("https://zoom.us./j/1");
        refused("https://.zoom.us/j/1");
        refused("https://a..zoom.us/j/1");
        refused("https://zооm.us/j/1"); // Cyrillic o's
        refused("https://1.2.3.4/j/1");
        refused("https://[::1]/j/1");
    }

    #[test]
    fn refuses_empty_and_huge() {
        refused("");
        refused(&format!("https://zoom.us/j/1?pwd={}", "a".repeat(2000)));
    }

    #[test]
    fn pinned_host_allows_only_that_host() {
        let pin = Some("acme.zoom.us");
        assert!(check("https://acme.zoom.us/j/1", pin).is_ok());
        assert!(check("https://ACME.zoom.us/j/1", pin).is_ok());
        assert!(check("https://zoom.us/j/1", pin).is_err());
        assert!(check("https://other.zoom.us/j/1", pin).is_err());
        assert!(check("https://x.acme.zoom.us/j/1", pin).is_err());
        // A pin doesn't loosen the path rule.
        assert!(check("https://acme.zoom.us/signin", pin).is_err());
        // A pin outside the Zoom domains can't widen what's allowed.
        assert!(check("https://evil.example/j/1", Some("evil.example")).is_err());
        // Empty means no pin.
        assert!(check("https://zoom.us/j/1", Some("")).is_ok());
    }
}
