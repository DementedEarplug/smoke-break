// Besides Tauri's own build steps:
//
// - records what this build was configured with (`SMOKE_BREAK_BUILD_INFO`,
//   embedded by `lib.rs`), so `npm run desktop:build:enterprise -- --check
//   <app>` can verify a built app without rebuilding it. The token itself is
//   never recorded, only whether one was set;
// - hands the server lock to the native side (`lock.rs`) as a marker string
//   (`sb-lock:v1:<on|off>:<hub> :end`) that stays in the binary, so a locked
//   build's commands answer for the built-in hub only, and `--check` reads
//   the very lock they obey;
// - declares the app's own commands, so each one needs a permission in
//   `capabilities/` (see `overlay.json` and `panel.json`): a window can call
//   only the commands its capability file lists.

const VARS: [&str; 4] = ["VITE_SERVER_URL", "VITE_LOCK_SERVER", "VITE_HUB_TOKEN", "SMOKE_BREAK_MEETING_HOST"];

/// Every `#[tauri::command]` in `lib.rs`; Tauri makes `allow-<command>` (with
/// dashes) permissions for them.
const COMMANDS: &[&str] = &[
    "set_dnd",
    "show_panel",
    "open_meeting",
    "keychain_available",
    "token_get",
    "token_set",
    "identity_init",
    "client_id_pin",
    "client_id",
    "window_show",
    "window_hide",
    "window_set_size",
    "window_set_position",
    "window_start_dragging",
    "window_set_ignore_cursor_events",
    "window_outer_position",
    "window_outer_size",
    "window_scale_factor",
    "window_current_monitor",
    "window_available_monitors",
    "window_cursor_position",
];

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
    // For `lock.rs`: the same lock and hub the frontend is built with, as the
    // marker it reads at run time and `--check` reads in the built app.
    // `hubKey` (src/serverUrl.ts) trims the address too; one with whitespace
    // inside can't be a hub, and its escaped form matches none.
    println!(
        "cargo:rustc-env=SMOKE_BREAK_LOCK_MARKER=sb-lock:v1:{}:{} :end",
        if locked { "on" } else { "off" },
        field(env("VITE_SERVER_URL").trim()),
    );
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}
