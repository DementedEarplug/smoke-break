// Besides Tauri's own build steps, records what this build was configured with
// (`SMOKE_BREAK_BUILD_INFO`, embedded by `lib.rs`), so `npm run
// desktop:build:enterprise -- --check <app>` can verify a built app without
// rebuilding it. The token itself is never recorded, only whether one was set.

const VARS: [&str; 4] = ["VITE_SERVER_URL", "VITE_LOCK_SERVER", "VITE_HUB_TOKEN", "SMOKE_BREAK_MEETING_HOST"];

/// Values are space-separated in the record; a checked hub address or host has
/// no whitespace, anything else gets it escaped.
fn field(v: &str) -> String {
    v.chars()
        .map(|c| if c.is_whitespace() || c.is_control() { format!("%{:02X}", c as u32 & 0xff) } else { c.to_string() })
        .collect()
}

fn main() {
    for var in VARS {
        println!("cargo:rerun-if-env-changed={var}");
    }
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    // Same rule as `serverLocked` in src/platform.ts.
    let locked = matches!(env("VITE_LOCK_SERVER").to_ascii_lowercase().as_str(), "1" | "true" | "yes");
    let info = format!(
        "server={} lock={} token={} meeting-host={}",
        field(&env("VITE_SERVER_URL")),
        if locked { "on" } else { "off" },
        if env("VITE_HUB_TOKEN").is_empty() { "none" } else { "set" },
        field(&env("SMOKE_BREAK_MEETING_HOST")),
    );
    println!("cargo:rustc-env=SMOKE_BREAK_BUILD_INFO={info}");
    tauri_build::build()
}
