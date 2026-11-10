// Which meeting links the app is willing to open.
//
// Links come from the hub, which a team owner (or anyone who can pose as the
// hub) controls. Different URL parsers disagree about odd input: for
// `https://zoom.us\@evil.example/` a browser-style parser sees host `zoom.us`
// while macOS's own parser sees `evil.example`. So this refuses anything a
// parser could read two ways, parses with the `url` crate (WHATWG rules),
// compares the host exactly, and only the re-serialized URL is ever opened.

use tauri::Url;

/// Meeting services we open links for (the host itself or any subdomain).
pub const MEETING_HOSTS: [&str; 3] = ["zoom.us", "zoom.com", "zoomgov.com"];

/// A company can build the app to open only its own Zoom host, e.g.
/// `SMOKE_BREAK_MEETING_HOST=acme.zoom.us npm run desktop:build`.
pub const PINNED_HOST: Option<&str> = option_env!("SMOKE_BREAK_MEETING_HOST");

const MAX_LEN: usize = 2000;

fn is_meeting_host(host: &str) -> bool {
    MEETING_HOSTS
        .iter()
        .any(|h| host == *h || host.strip_suffix(h).is_some_and(|rest| rest.ends_with('.') && rest.len() > 1))
}

/// Returns the canonical URL to open, or why the link was refused.
pub fn check(raw: &str, pinned: Option<&str>) -> Result<Url, String> {
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

    fn ok(raw: &str) -> String {
        check(raw, None).unwrap_or_else(|e| panic!("{raw:?} refused: {e}")).to_string()
    }

    fn refused(raw: &str) {
        assert!(check(raw, None).is_err(), "{raw:?} should be refused");
    }

    #[test]
    fn accepts_zoom_links() {
        assert_eq!(ok("https://zoom.us/j/123?pwd=abc"), "https://zoom.us/j/123?pwd=abc");
        assert_eq!(ok("https://acme.zoom.us/j/123"), "https://acme.zoom.us/j/123");
        assert_eq!(ok("https://zoom.com/j/1"), "https://zoom.com/j/1");
        assert_eq!(ok("https://us02web.zoomgov.com/j/1"), "https://us02web.zoomgov.com/j/1");
    }

    #[test]
    fn opens_the_canonical_form() {
        assert_eq!(ok("https://ZOOM.us"), "https://zoom.us/");
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
    fn refuses_whitespace_and_control_characters() {
        refused("https://zoom.us/j/1\t");
        refused("https://zoom.us/j/1\n");
        refused("https://zoom.us/j/1\r");
        refused("https://zoom.\tus/j/1");
        refused("https://zoom.us/j/ 1");
        refused(" https://zoom.us/j/1");
        refused("https://zoom.us/j/1\u{0}");
        refused("https://zoom.us/j/1\u{7f}");
        refused("https://zoom.us/j/1\u{85}");
        refused("https://zoom.us/j/1\u{a0}");
        refused("https://zoom.us/j/1\u{2028}");
    }

    #[test]
    fn refuses_userinfo() {
        refused("https://user@zoom.us/j/1");
        refused("https://user:pw@zoom.us/j/1");
        refused("https://:pw@zoom.us/j/1");
        refused("https://zoom.us@evil.example/j/1");
    }

    #[test]
    fn refuses_ports() {
        refused("https://zoom.us:8443/j/1");
        refused("https://zoom.us:80/j/1");
        refused("https://zoom.us:0/j/1");
    }

    #[test]
    fn refuses_other_schemes() {
        refused("http://zoom.us/j/1");
        refused("zoommtg://zoom.us/join?confno=1");
        refused("javascript:alert(1)//zoom.us");
        refused("file:///zoom.us/x");
        refused("zoom.us/j/1");
    }

    #[test]
    fn refuses_lookalike_hosts() {
        refused("https://zoom.us.evil.example/j/1");
        refused("https://evilzoom.us/j/1");
        refused("https://zoom.us./j/1");
        refused("https://.zoom.us/j/1");
        refused("https://zооm.us/j/1"); // Cyrillic o's
        refused("https://1.2.3.4/j/1");
        refused("https://[::1]/j/1");
    }

    #[test]
    fn refuses_empty_and_huge() {
        refused("");
        refused(&format!("https://zoom.us/{}", "a".repeat(2000)));
    }

    #[test]
    fn pinned_host_allows_only_that_host() {
        let pin = Some("acme.zoom.us");
        assert!(check("https://acme.zoom.us/j/1", pin).is_ok());
        assert!(check("https://ACME.zoom.us/j/1", pin).is_ok());
        assert!(check("https://zoom.us/j/1", pin).is_err());
        assert!(check("https://other.zoom.us/j/1", pin).is_err());
        assert!(check("https://x.acme.zoom.us/j/1", pin).is_err());
        // A pin outside the Zoom domains can't widen what's allowed.
        assert!(check("https://evil.example/", Some("evil.example")).is_err());
        // Empty means no pin.
        assert!(check("https://zoom.us/j/1", Some("")).is_ok());
    }
}
