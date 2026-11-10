// Smoke Break desktop shell: a transparent always-on-top overlay window (the
// pack), a "Team & settings" window, and a tray menu. All app logic lives in
// the web frontend; this file only wires up windows, the tray, autostart,
// opening meeting links, one running app per user, and keeping hub access
// tokens and the device identity in the login Keychain.

mod identity;
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
    AppHandle, Emitter, Manager, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// The tray's "Do not disturb" checkbox, kept so the overlay can update it.
struct DndItem(CheckMenuItem<Wry>);

/// Called by the overlay when do-not-disturb changes (e.g. right-clicking the pack).
#[tauri::command]
fn set_dnd(app: AppHandle, on: bool) {
    if let Some(item) = app.try_state::<DndItem>() {
        let _ = item.0.set_checked(on);
    }
}

#[tauri::command]
fn show_panel(app: AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.unminimize();
        let _ = panel.set_focus();
    }
}

/// Opens a team's meeting link in the browser / Zoom app. The link comes from
/// the hub, so it is checked here again (see `meeting::check`) and only the
/// re-serialized URL is handed to the OS; the webview has no general way to
/// open URLs.
#[tauri::command]
fn open_meeting(url: String) -> Result<(), String> {
    let url = meeting::check(&url, meeting::PINNED_HOST)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/// What this build was configured with (see `build.rs`), kept in the binary
/// so `scripts/enterprise-build.ts --check` can read it from a built app.
#[used]
static BUILD_INFO: &str = concat!("smoke-break-build-info:v1 ", env!("SMOKE_BREAK_BUILD_INFO"), " :end");

/// Whether tokens and the identity go to the Keychain (macOS). Elsewhere the
/// webview keeps them in web storage, and says so.
#[tauri::command]
fn keychain_available() -> bool {
    cfg!(target_os = "macos")
}

/// Keychain calls can wait on a system prompt: keep them off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The hub access token saved for `hub` (see `token.rs`), or None.
#[tauri::command]
async fn token_get(app: AppHandle, hub: String) -> Result<Option<String>, String> {
    token::check_hub(&hub)?;
    let service = app.config().identifier.clone();
    blocking(move || token::get(&service, &hub)).await
}

/// Saves the token for `hub`; an empty token deletes it. Returns None once the
/// Keychain has it, or why it couldn't: the token is then kept in memory until
/// the app quits, never anywhere else.
#[tauri::command]
async fn token_set(app: AppHandle, hub: String, token: String) -> Result<Option<String>, String> {
    token::check_hub(&hub)?;
    token::check_token(&token)?;
    let service = app.config().identifier.clone();
    blocking(move || token::set(&service, &hub, &token)).await
}

/// Loads the device secret from the Keychain, or stores one there (see
/// `identity::init`), once per run. `legacy_secret` is a secret still in web
/// storage from before the Keychain; `stored_before` says the webview has
/// seen it stored in the Keychain. The secret itself never comes back out.
#[tauri::command]
async fn identity_init(app: AppHandle, legacy_secret: Option<String>, stored_before: bool) -> Result<(), String> {
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
#[tauri::command]
async fn client_id_pin(app: AppHandle, hub: String, id: String) -> Result<(), String> {
    token::check_hub(&hub)?;
    token::check_client_id(&id)?;
    let service = app.config().identifier.clone();
    blocking(move || identity::pin(&service, &hub, &id)).await
}

/// This device's client id for `hub`: only the derived (or pinned) id, never
/// the secret behind it.
#[tauri::command]
async fn client_id(app: AppHandle, hub: String, pinned: bool) -> Result<String, String> {
    token::check_hub(&hub)?;
    let service = app.config().identifier.clone();
    blocking(move || identity::client_id(&service, &hub, pinned)).await
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
        .invoke_handler(tauri::generate_handler![
            set_dnd,
            show_panel,
            open_meeting,
            keychain_available,
            token_get,
            token_set,
            identity_init,
            client_id_pin,
            client_id
        ])
        .setup(move |app| {
            #[cfg(unix)]
            if let Some(guard) = guard {
                let handle = app.handle().clone();
                if let Err(e) = guard.listen(move || show_panel(handle.clone())) {
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
                    "panel" => show_panel(app.clone()),
                    "dnd" => {
                        // The checkbox has already toggled itself; tell the pack.
                        let on = dnd_item.is_checked().unwrap_or(false);
                        let _ = app.emit_to("overlay", "dnd", on);
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
            if window.label() == "panel" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(context)
        .expect("error while running Smoke Break");
}
