//! The menu-bar mini calendar on the desktop (ADR-0054): a tray icon that
//! opens a small calendar window under it, and keeps Mailbird running when
//! its window closes. What it says comes from `pim_app::menu_bar`; this only
//! draws it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use pim_app::menu_bar::MenuBarState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, Runtime, WebviewUrl, WebviewWindowBuilder};

const TRAY: &str = "mini-calendar";
pub const MAIN: &str = "main";
pub const MINI: &str = "mini";
/// The mini window, in logical pixels: a month and a day's agenda.
const MINI_SIZE: (f64, f64) = (360.0, 600.0);
/// Space between the menu bar or taskbar and the window.
const GAP: f64 = 6.0;

/// Whether the tray is up, so closing the main window hides it instead of
/// quitting. Only set once the tray exists: a Linux desktop without a tray
/// must never be left with no way back to a hidden window.
#[derive(Clone, Default)]
pub struct InTray(pub Arc<AtomicBool>);

impl InTray {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Draws `state`: shows, updates, or hides the tray. Must run on the main thread.
pub fn draw<R: Runtime>(app: &AppHandle<R>, in_tray: &InTray, state: &MenuBarState) {
    if !state.enabled {
        if let Some(tray) = app.tray_by_id(TRAY) {
            let _ = tray.set_visible(false);
        }
        if let Some(mini) = app.get_webview_window(MINI) {
            let _ = mini.hide();
        }
        in_tray.0.store(false, Ordering::Relaxed);
        return;
    }
    let tray = match app.tray_by_id(TRAY) {
        Some(t) => t,
        None => match build(app) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("no menu-bar calendar on this desktop: {e}");
                return;
            }
        },
    };
    let _ = tray.set_visible(true);
    let _ = tray.set_tooltip(Some(&state.tooltip));
    // Text beside the icon: the macOS menu bar, and the label on Linux
    // panels that show one. Windows trays have no room; the tooltip says it there.
    let _ = tray.set_title(state.title.as_deref());
    in_tray.0.store(true, Ordering::Relaxed);
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Mailbird", true, None::<&str>)?,
            &MenuItem::with_id(app, "new_event", "New event…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Mailbird", true, None::<&str>)?,
        ],
    )?;
    // macOS draws a template icon in the menu bar's own ink, light or dark;
    // the other trays get the app icon, which holds up on any taskbar.
    let icon = if cfg!(target_os = "macos") {
        tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?
    } else {
        tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?
    };
    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        // A click opens the calendar; the menu is a right-click away.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app, None),
            "new_event" => show_main(app, Some(serde_json::json!({ "kind": "newEvent" }))),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = e {
                toggle_mini(tray.app_handle(), rect);
            }
        })
        .build(app)
}

/// Opens the mini calendar under the icon (above it, when the taskbar is at
/// the bottom), or closes it if it's open.
fn toggle_mini<R: Runtime>(app: &AppHandle<R>, at: Rect) {
    if let Some(w) = app.get_webview_window(MINI)
        && w.is_visible().unwrap_or(false)
    {
        let _ = w.hide();
        return;
    }
    let window = match app.get_webview_window(MINI) {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(app, MINI, WebviewUrl::App("index.html?mini".into()))
            .title("Mailbird")
            .inner_size(MINI_SIZE.0, MINI_SIZE.1)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible(false)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                log::warn!("couldn't open the mini calendar: {e}");
                return;
            }
        },
    };
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) {
        let scale = monitor.scale_factor();
        let icon = at.position.to_physical::<f64>(scale);
        let icon_size = at.size.to_physical::<f64>(scale);
        let (w, h) = (MINI_SIZE.0 * scale, MINI_SIZE.1 * scale);
        let (mx, my) = (monitor.position().x as f64, monitor.position().y as f64);
        let (mw, mh) = (monitor.size().width as f64, monitor.size().height as f64);
        let below = icon.y < my + mh / 2.0;
        let x = (icon.x + icon_size.width / 2.0 - w / 2.0).clamp(mx + GAP * scale, mx + mw - w - GAP * scale);
        let y = if below { icon.y + icon_size.height + GAP * scale } else { icon.y - h - GAP * scale };
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Brings the main window forward, and opens `jump` in it.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, jump: Option<serde_json::Value>) {
    if let Some(mini) = app.get_webview_window(MINI) {
        let _ = mini.hide();
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
        if let Some(j) = jump {
            let _ = app.emit_to(MAIN, "app:jump", j);
        }
    }
}
