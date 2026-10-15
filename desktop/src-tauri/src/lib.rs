mod server;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Allow the splash page and the loopback BioStore server. Nothing else.
pub fn navigation_allowed(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    match url.scheme() {
        "tauri" | "asset" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost")
        ),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("BioStore")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .background_color(tauri::window::Color(0x1c, 0x1c, 0x1e, 255))
            .on_navigation(|url| navigation_allowed(url.as_str()))
            .build()?;

            app.manage(server::ServerState::default());
            let handle = app.handle().clone();
            std::thread::spawn(move || server::boot(handle));

            // The window is shown by the builder; keep the binding so the
            // label stays "main" for the capability scope.
            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building BioStore")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<server::ServerState>() {
                    state.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::navigation_allowed;

    #[test]
    fn allows_loopback_and_shell_pages() {
        assert!(navigation_allowed("http://127.0.0.1:8765/"));
        assert!(navigation_allowed("http://127.0.0.1:8765/api/auth/status"));
        assert!(navigation_allowed("http://localhost:1420/index.html"));
        assert!(navigation_allowed("http://tauri.localhost/index.html"));
        assert!(navigation_allowed("tauri://localhost"));
    }

    #[test]
    fn blocks_the_public_web() {
        assert!(!navigation_allowed("https://d3js.org/d3.v7.min.js"));
        assert!(!navigation_allowed("http://example.com/"));
        assert!(!navigation_allowed("file:///C:/Windows/notepad.exe"));
        assert!(!navigation_allowed("not a url"));
    }
}
