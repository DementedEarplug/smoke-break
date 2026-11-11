// Smoke Break desktop shell: a transparent always-on-top overlay window (the
// pack), a "Team & settings" window, and a tray menu. All app logic lives in
// the web frontend; this file only wires up windows, the tray, autostart,
// opening meeting links, one running app per user, and keeping hub access
// tokens and the device identity in the login Keychain.

mod identity;
mod lock;
mod meeting;
#[cfg(unix)]
mod single_instance;
mod token;
#[cfg(unix)]
mod user;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, Window, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// The two windows (`tauri.conf.json`). Each has its own capability file in
/// `capabilities/` naming the commands it may call; the commands check the
/// caller's label again.
const OVERLAY: &str = "overlay";
const PANEL: &str = "panel";

/// Refuses a command called from a window it isn't meant for.
fn only_from(label: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&label) {
        Ok(())
    } else {
        Err(format!("not available to the {label} window"))
    }
}

fn caller<R: Runtime>(window: &Window<R>, allowed: &[&str]) -> Result<(), String> {
    only_from(window.label(), allowed)
}

/// A hub address from the webview: one the app could connect to
/// (`token::check_hub`, which also bounds its size), and in a build locked to
/// one hub, that hub (`lock.rs`).
fn checked_hub(hub: &str) -> Result<(), String> {
    token::check_hub(hub)?;
    lock::check(hub, lock::locked_hub())
}

/// The tray's "Do not disturb" checkbox, kept so the overlay can update it.
struct DndItem(CheckMenuItem<Wry>);

/// Called by the overlay when do-not-disturb changes (e.g. right-clicking the pack).
#[tauri::command]
fn set_dnd<R: Runtime>(app: AppHandle<R>, window: Window<R>, on: bool) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    if let Some(item) = app.try_state::<DndItem>() {
        let _ = item.0.set_checked(on);
    }
    Ok(())
}

fn open_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(panel) = app.get_webview_window(PANEL) {
        let _ = panel.show();
        let _ = panel.unminimize();
        let _ = panel.set_focus();
    }
}

/// The overlay hands over to the settings window (onboarding, a refused token, ...).
#[tauri::command]
fn show_panel<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    open_panel(&app);
    Ok(())
}

/// Opens a team's meeting link in the browser / Zoom app. The link comes from
/// the hub, so it is checked here again (see `meeting::check`, which also
/// bounds its length) and only the re-serialized URL is handed to the OS; the
/// webview has no general way to open URLs.
#[tauri::command]
fn open_meeting<R: Runtime>(window: Window<R>, url: String) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    let url = meeting::check(&url, meeting::PINNED_HOST)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// The overlay's own window. Tauri's `core:window:*` commands act on whichever
// window their `label` argument names, and a capability can't confine them to
// the caller; these act on the calling window only, and only the overlay may
// call them. Async, like Tauri's own window commands.

fn win_err(e: tauri::Error) -> String {
    e.to_string()
}

#[tauri::command]
async fn window_show<R: Runtime>(window: Window<R>) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    window.show().map_err(win_err)
}

#[tauri::command]
async fn window_hide<R: Runtime>(window: Window<R>) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    window.hide().map_err(win_err)
}

/// Largest window side the pack asks for, in logical pixels (it needs a few hundred).
const MAX_WINDOW_SIDE: f64 = 4096.0;

/// Sets the calling window's size in logical pixels.
#[tauri::command]
async fn window_set_size<R: Runtime>(window: Window<R>, width: f64, height: f64) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    let ok = |v: f64| v.is_finite() && v >= 1.0 && v <= MAX_WINDOW_SIDE;
    if !ok(width) || !ok(height) {
        return Err("not a window size".into());
    }
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(win_err)
}

/// Moves the calling window to a point in physical pixels.
#[tauri::command]
async fn window_set_position<R: Runtime>(window: Window<R>, x: i32, y: i32) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(win_err)
}

#[tauri::command]
async fn window_start_dragging<R: Runtime>(window: Window<R>) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    window.start_dragging().map_err(win_err)
}

#[tauri::command]
async fn window_set_ignore_cursor_events<R: Runtime>(window: Window<R>, ignore: bool) -> Result<(), String> {
    caller(&window, &[OVERLAY])?;
    window.set_ignore_cursor_events(ignore).map_err(win_err)
}

#[tauri::command]
async fn window_outer_position<R: Runtime>(window: Window<R>) -> Result<tauri::PhysicalPosition<i32>, String> {
    caller(&window, &[OVERLAY])?;
    window.outer_position().map_err(win_err)
}

#[tauri::command]
async fn window_outer_size<R: Runtime>(window: Window<R>) -> Result<tauri::PhysicalSize<u32>, String> {
    caller(&window, &[OVERLAY])?;
    window.outer_size().map_err(win_err)
}

#[tauri::command]
async fn window_scale_factor<R: Runtime>(window: Window<R>) -> Result<f64, String> {
    caller(&window, &[OVERLAY])?;
    window.scale_factor().map_err(win_err)
}

/// The screen the calling window is on, if any.
#[tauri::command]
async fn window_current_monitor<R: Runtime>(window: Window<R>) -> Result<Option<tauri::Monitor>, String> {
    caller(&window, &[OVERLAY])?;
    window.current_monitor().map_err(win_err)
}

/// Every screen, to tell whether a saved position is still on one.
#[tauri::command]
async fn window_available_monitors<R: Runtime>(window: Window<R>) -> Result<Vec<tauri::Monitor>, String> {
    caller(&window, &[OVERLAY])?;
    window.available_monitors().map_err(win_err)
}

/// Where the mouse pointer is on the screen, in physical pixels: while the
/// overlay lets clicks through it gets no mouse events.
#[tauri::command]
async fn window_cursor_position<R: Runtime>(window: Window<R>) -> Result<tauri::PhysicalPosition<f64>, String> {
    caller(&window, &[OVERLAY])?;
    window.cursor_position().map_err(win_err)
}

/// What this build was configured with (see `build.rs`), kept in the binary
/// so `scripts/enterprise-build.ts --check` can read it from a built app.
#[used]
static BUILD_INFO: &str = concat!("smoke-break-build-info:v1 ", env!("SMOKE_BREAK_BUILD_INFO"), " :end");

/// Whether tokens and the identity go to the Keychain (macOS). Elsewhere the
/// webview keeps them in web storage, and says so.
#[tauri::command]
fn keychain_available<R: Runtime>(window: Window<R>) -> Result<bool, String> {
    caller(&window, &[OVERLAY, PANEL])?;
    Ok(cfg!(target_os = "macos"))
}

/// Keychain calls can wait on a system prompt: keep them off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The hub access token saved for `hub` (see `token.rs`), or None. Both
/// windows connect to the hub, so both read it.
#[tauri::command]
async fn token_get<R: Runtime>(app: AppHandle<R>, window: Window<R>, hub: String) -> Result<Option<String>, String> {
    caller(&window, &[OVERLAY, PANEL])?;
    checked_hub(&hub)?;
    let service = app.config().identifier.clone();
    blocking(move || token::get(&service, &hub)).await
}

/// Saves the token for `hub`; an empty token deletes it. Returns None once the
/// Keychain has it, or why it couldn't: the token is then kept in memory until
/// the app quits, never anywhere else. Only the settings window, where tokens
/// are typed in, saves them.
#[tauri::command]
async fn token_set<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    hub: String,
    token: String,
) -> Result<Option<String>, String> {
    caller(&window, &[PANEL])?;
    checked_hub(&hub)?;
    token::check_token(&token)?;
    let service = app.config().identifier.clone();
    blocking(move || token::set(&service, &hub, &token)).await
}

/// Loads the device secret from the Keychain, or stores one there (see
/// `identity::init`), once per run. `legacy_secret` is a secret still in web
/// storage from before the Keychain; `stored_before` says the webview has
/// seen it stored in the Keychain. The secret itself never comes back out.
/// Whichever window starts first does this, so both may.
#[tauri::command]
async fn identity_init<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    legacy_secret: Option<String>,
    stored_before: bool,
) -> Result<(), String> {
    caller(&window, &[OVERLAY, PANEL])?;
    if let Some(s) = &legacy_secret {
        token::check_secret(s)?;
    }
    let service = app.config().identifier.clone();
    blocking(move || {
        let start = match (&legacy_secret, stored_before) {
            (Some(s), _) => identity::Start::Import(s),
            (None, true) => identity::Start::Stored,
            (None, false) => identity::Start::Fresh,
        };
        identity::init(&service, start)
    })
    .await
}

/// Moves an id pinned to `hub` (from before per-hub ids) into the Keychain.
/// Part of the same once-only move as `identity_init`, so both windows may.
#[tauri::command]
async fn client_id_pin<R: Runtime>(app: AppHandle<R>, window: Window<R>, hub: String, id: String) -> Result<(), String> {
    caller(&window, &[OVERLAY, PANEL])?;
    checked_hub(&hub)?;
    token::check_client_id(&id)?;
    let service = app.config().identifier.clone();
    blocking(move || identity::pin(&service, &hub, &id)).await
}

/// This device's client id for `hub`: only the derived (or pinned) id, never
/// the secret behind it. Both windows connect to the hub.
#[tauri::command]
async fn client_id<R: Runtime>(app: AppHandle<R>, window: Window<R>, hub: String, pinned: bool) -> Result<String, String> {
    caller(&window, &[OVERLAY, PANEL])?;
    checked_hub(&hub)?;
    let service = app.config().identifier.clone();
    blocking(move || identity::client_id(&service, &hub, pinned)).await
}

/// The commands the webviews can call (each one also needs a permission in
/// the calling window's capability file).
fn commands<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        set_dnd,
        show_panel,
        open_meeting,
        keychain_available,
        token_get,
        token_set,
        identity_init,
        client_id_pin,
        client_id,
        window_show,
        window_hide,
        window_set_size,
        window_set_position,
        window_start_dragging,
        window_set_ignore_cursor_events,
        window_outer_position,
        window_outer_size,
        window_scale_factor,
        window_current_monitor,
        window_available_monitors,
        window_cursor_position
    ]
}

/// Keeps the single-instance lock for as long as the app runs.
#[cfg(unix)]
struct InstanceGuard {
    _guard: single_instance::Guard,
}

/// Takes the per-user single-instance lock. Returns false when another
/// instance of this user's is running (it has been asked to show its settings
/// window): this one should quit. If the lock can't be set up at all, runs
/// without it rather than not at all.
#[cfg(unix)]
fn first_instance(identifier: &str) -> (bool, Option<single_instance::Guard>) {
    let dir = match single_instance::app_dir(identifier) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Smoke Break: no single-instance check ({e})");
            return (true, None);
        }
    };
    match single_instance::acquire(&dir) {
        Ok(single_instance::Instance::First(guard)) => (true, Some(guard)),
        Ok(single_instance::Instance::Running) => {
            if let Err(e) = single_instance::ask_running_to_show(&dir) {
                eprintln!("Smoke Break is already running; couldn't ask it to show its window ({e})");
            }
            (false, None)
        }
        Err(e) => {
            eprintln!("Smoke Break: no single-instance check ({e})");
            (true, None)
        }
    }
}

/// Whether a window may navigate to `url`: the bundled pages (`tauri://localhost` on macOS and
/// Linux; `http(s)://tauri.localhost` on Windows only, since elsewhere that name is just this
/// machine's loopback address, where anyone can listen), plus the Vite dev server in dev builds.
fn own_page(url: &tauri::Url, dev: bool) -> bool {
    let host = url.host_str().unwrap_or("");
    let no_login = url.username().is_empty() && url.password().is_none();
    match url.scheme() {
        "tauri" => no_login && host == "localhost",
        "http" | "https" if cfg!(windows) && host == "tauri.localhost" => no_login && url.port().is_none(),
        "http" => dev && no_login && host == "localhost" && url.port() == Some(5173),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // A second launch just opens the settings window of the running one.
    #[cfg(unix)]
    let guard = match first_instance(&context.config().identifier) {
        (false, _) => return,
        (true, guard) => guard,
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // The windows only ever show the app's own pages. Without this, script that got into a
        // window could send it to another site and take what it had read along in the address.
        .plugin(
            tauri::plugin::Builder::<Wry>::new("own-pages")
                .on_navigation(|_webview, url| own_page(url, cfg!(dev)))
                .build(),
        )
        .invoke_handler(commands())
        .setup(move |app| {
            #[cfg(unix)]
            if let Some(guard) = guard {
                let handle = app.handle().clone();
                if let Err(e) = guard.listen(move || open_panel(&handle)) {
                    eprintln!("Smoke Break: later launches can't reach this one ({e})");
                }
                app.manage(InstanceGuard { _guard: guard });
            }

            // Menu-bar app: no Dock icon or app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let panel_item = MenuItem::with_id(app, "panel", "Settings…", true, None::<&str>)?;
            let dnd_item = CheckMenuItem::with_id(app, "dnd", "Do not disturb", true, false, None::<&str>)?;
            let login_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let login_item =
                CheckMenuItem::with_id(app, "login", "Launch at login", true, login_enabled, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Smoke Break", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &panel_item,
                    &dnd_item,
                    &login_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;
            app.manage(DndItem(dnd_item.clone()));

            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("Smoke Break")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "panel" => open_panel(app),
                    "dnd" => {
                        // The checkbox has already toggled itself; tell the pack.
                        let on = dnd_item.is_checked().unwrap_or(false);
                        let _ = app.emit_to(OVERLAY, "dnd", on);
                    }
                    "login" => {
                        let autolaunch = app.autolaunch();
                        let want = login_item.is_checked().unwrap_or(false);
                        let result = if want { autolaunch.enable() } else { autolaunch.disable() };
                        if result.is_err() {
                            let _ = login_item.set_checked(!want);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the settings window just hides it; the app lives in the tray.
            if window.label() == PANEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(context)
        .expect("error while running Smoke Break");
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_only_navigate_to_the_apps_own_pages() {
        let ok = |u: &str, dev: bool| own_page(&tauri::Url::parse(u).unwrap(), dev);
        assert!(ok("tauri://localhost/panel.html", false));
        assert!(ok("tauri://localhost/overlay.html?x=1", false));
        // Windows serves the app's pages from this name; elsewhere it's only the loopback address.
        assert_eq!(ok("http://tauri.localhost/panel.html", false), cfg!(windows));
        assert_eq!(ok("https://tauri.localhost/panel.html", true), cfg!(windows));
        assert!(ok("http://localhost:5173/panel.html", true));
        // The dev server only counts in dev builds.
        assert!(!ok("http://localhost:5173/panel.html", false));
        for bad in [
            "https://evil.example/?stolen=1",
            "https://tauri.localhost.evil.example/",
            "https://tauri.localhost:8443/",
            "https://user@tauri.localhost/",
            "tauri://evil.example/panel.html",
            "http://localhost:8787/",
            "http://localhost/",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "about:blank",
        ] {
            assert!(!ok(bad, true), "{bad}");
        }
    }

    use super::*;
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    #[test]
    fn commands_check_the_calling_window() {
        assert!(only_from(OVERLAY, &[OVERLAY]).is_ok());
        assert!(only_from(PANEL, &[OVERLAY, PANEL]).is_ok());
        assert!(only_from(PANEL, &[OVERLAY]).is_err());
        assert!(only_from("other", &[OVERLAY, PANEL]).is_err());
    }

    #[test]
    fn hub_commands_follow_the_lock_this_build_was_made_with() {
        assert!(checked_hub("not a hub").is_err());
        match lock::locked_hub() {
            // `VITE_LOCK_SERVER=1 VITE_SERVER_URL=wss://… cargo test`
            Some(hub) => {
                assert!(checked_hub(hub).is_ok());
                assert!(checked_hub("wss://elsewhere.example/ws").is_err());
            }
            None => assert!(checked_hub("wss://elsewhere.example/ws").is_ok()),
        }
    }

    /// The app with its real config and capabilities on Tauri's mock runtime,
    /// and both windows. Only calls that are refused before they reach the
    /// Keychain or the OS are made: nothing here touches either.
    fn app() -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>, WebviewWindow<MockRuntime>) {
        let app = mock_builder().invoke_handler(commands()).build(tauri::generate_context!(test = true)).expect("app builds");
        let window = |label: &str, page: &str| {
            app.get_webview_window(label).unwrap_or_else(|| {
                WebviewWindowBuilder::new(&app, label, WebviewUrl::App(page.into())).build().expect("window")
            })
        };
        let (overlay, panel) = (window(OVERLAY, "overlay.html"), window(PANEL, "panel.html"));
        (app, overlay, panel)
    }

    /// The page's own origin: the dev server in a debug build (what `cargo
    /// test` builds), the app's own scheme in a release build.
    fn page_url() -> tauri::Url {
        let url = if cfg!(debug_assertions) { "http://localhost:5173/" } else { "tauri://localhost/" };
        url.parse().unwrap()
    }

    fn call(window: &WebviewWindow<MockRuntime>, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: page_url(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<serde_json::Value>().unwrap())
        .map_err(|e| e.to_string())
    }

    fn refused_by_capability(r: Result<serde_json::Value, String>) {
        let e = r.expect_err("should be refused");
        assert!(e.contains("not allowed"), "refused for another reason: {e}");
    }

    /// Reached the command itself (it refused the argument, not the caller).
    fn reached(r: Result<serde_json::Value, String>, why: &str) {
        let e = r.expect_err("bad input should be refused");
        assert!(!e.contains("not allowed"), "refused by the capability: {e}");
        assert!(e.contains(why), "{e}");
    }

    #[test]
    fn each_window_may_call_only_what_it_needs() {
        let (_app, overlay, panel) = app();

        // Both windows connect to the hub.
        assert_eq!(call(&overlay, "keychain_available", json!({})), Ok(json!(cfg!(target_os = "macos"))));
        assert_eq!(call(&panel, "keychain_available", json!({})), Ok(json!(cfg!(target_os = "macos"))));
        for w in [&overlay, &panel] {
            reached(call(w, "token_get", json!({ "hub": "device-secret" })), "not a hub address");
            reached(call(w, "client_id", json!({ "hub": "x", "pinned": false })), "not a hub address");
            reached(call(w, "client_id_pin", json!({ "hub": "x", "id": "short" })), "not a hub address");
            reached(call(w, "identity_init", json!({ "legacySecret": "short", "storedBefore": false })), "not a device secret");
        }

        // Only the settings window saves tokens.
        reached(call(&panel, "token_set", json!({ "hub": "x", "token": "t" })), "not a hub address");
        refused_by_capability(call(&overlay, "token_set", json!({ "hub": "x", "token": "t" })));

        // Only the overlay opens meetings, sets the tray's do-not-disturb and asks for the settings window.
        reached(call(&overlay, "open_meeting", json!({ "url": "https://evil.example/j/1" })), "not a Zoom host");
        refused_by_capability(call(&panel, "open_meeting", json!({ "url": "https://zoom.us/j/1" })));
        refused_by_capability(call(&panel, "set_dnd", json!({ "on": true })));
        refused_by_capability(call(&panel, "show_panel", json!({})));
        assert_eq!(call(&overlay, "set_dnd", json!({ "on": true })), Ok(json!(null)));

        // Only the overlay handles its window, and only its own: the app's
        // window_* commands take no label and act on the caller.
        let own_window = [
            ("window_show", json!({})),
            ("window_hide", json!({})),
            ("window_set_size", json!({ "width": 240.0, "height": 360.0 })),
            ("window_set_position", json!({ "x": 10, "y": 20 })),
            ("window_start_dragging", json!({})),
            ("window_set_ignore_cursor_events", json!({ "ignore": true })),
            ("window_outer_position", json!({})),
            ("window_outer_size", json!({})),
            ("window_scale_factor", json!({})),
            ("window_current_monitor", json!({})),
            ("window_available_monitors", json!({})),
            ("window_cursor_position", json!({})),
        ];
        for (cmd, args) in &own_window {
            refused_by_capability(call(&panel, cmd, args.clone()));
            assert!(call(&overlay, cmd, args.clone()).is_ok(), "{cmd}");
        }
        assert_eq!(call(&overlay, "window_outer_position", json!({})), Ok(json!({ "x": 0, "y": 0 })));
        reached(call(&overlay, "window_set_size", json!({ "width": 0.0, "height": 360.0 })), "not a window size");
        reached(call(&overlay, "window_set_size", json!({ "width": 240.0, "height": 1e9 })), "not a window size");
        // Tauri's own window commands, which act on whatever window `label`
        // names, are granted to neither window.
        for cmd in [
            "show",
            "hide",
            "set_size",
            "set_position",
            "start_dragging",
            "set_ignore_cursor_events",
            "outer_position",
            "outer_size",
            "scale_factor",
            "current_monitor",
            "available_monitors",
            "cursor_position",
            "set_focus",
            "minimize",
            "close",
        ] {
            for w in [&overlay, &panel] {
                for label in [OVERLAY, PANEL] {
                    refused_by_capability(call(w, &format!("plugin:window|{cmd}"), json!({ "label": label })));
                }
            }
        }

        // Nothing else of Tauri's: no menus, tray icons, paths, opening URLs, creating webviews.
        for w in [&overlay, &panel] {
            refused_by_capability(call(w, "plugin:menu|new", json!({ "kind": "Menu", "options": {} })));
            refused_by_capability(call(w, "plugin:path|resolve_directory", json!({ "directory": 1 })));
            refused_by_capability(call(w, "plugin:opener|open_url", json!({ "url": "https://zoom.us/j/1" })));
            refused_by_capability(call(w, "plugin:app|name", json!({})));
            refused_by_capability(call(w, "plugin:window|close", json!({ "label": OVERLAY })));
            refused_by_capability(call(w, "plugin:webview|create_webview_window", json!({ "options": { "label": "x", "url": "https://evil.example/" } })));
        }

        // A locked build answers for its built-in hub only, before the Keychain is asked anything.
        if lock::locked_hub().is_some() {
            let other = "wss://elsewhere.example/ws";
            for w in [&overlay, &panel] {
                reached(call(w, "token_get", json!({ "hub": other })), "built-in hub");
                reached(call(w, "client_id", json!({ "hub": other, "pinned": true })), "built-in hub");
                reached(call(w, "client_id_pin", json!({ "hub": other, "id": "abcdef0123456789" })), "built-in hub");
            }
            reached(call(&panel, "token_set", json!({ "hub": other, "token": "planted" })), "built-in hub");
        }
    }
}
