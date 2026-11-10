// Smoke Break desktop shell: a transparent always-on-top overlay window (the
// pack), a "Team & settings" window, and a tray menu. All app logic lives in
// the web frontend; this file only wires up windows, the tray, autostart, and
// opening meeting links.

mod meeting;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch just opens the settings window of the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_panel(app.clone())))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![set_dnd, show_panel, open_meeting])
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running Smoke Break");
}
