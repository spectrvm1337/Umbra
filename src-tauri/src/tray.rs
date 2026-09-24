

use tauri::Manager;

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let restart_item = MenuItemBuilder::new("Restart").id("restart").build(app)?;
    let quit_item = MenuItemBuilder::new("Quit").id("quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&restart_item, &quit_item]).build()?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Umbra")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "restart" => {
                let _ = app.restart();
            }
            "quit" => {
                std::process::exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    crate::show_window(&window);
                }
            }
        })
        .build(app)?;

    Ok(())
}
