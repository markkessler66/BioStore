//! Start the repo's Python server, or attach to one already on port 8765.
//!
//! The repo root is compiled in from this crate's path. That is correct for
//! `tauri dev` from a checkout. A packaged sidecar is a later step.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const SERVER_ORIGIN: &str = "http://127.0.0.1:8765";
const READY_TIMEOUT: Duration = Duration::from_secs(40);
const POLL_INTERVAL: Duration = Duration::from_millis(400);

pub struct ServerState {
    child: Mutex<Option<Child>>,
    stop: AtomicBool,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            stop: AtomicBool::new(false),
        }
    }
}

impl ServerState {
    /// Kill the Python process this app spawned. An attached server is left running.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.stop_child();
    }

    fn stop_child(&self) {
        let Ok(mut slot) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn boot(app: AppHandle) {
    let state = app.state::<ServerState>();
    let log_path = log_file_path();
    match ensure_server(&state, &log_path) {
        Ok(()) => {
            if state.stop.load(Ordering::SeqCst) {
                state.shutdown();
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = url::Url::parse(SERVER_ORIGIN) {
                    let _ = window.navigate(url);
                }
            }
        }
        Err(message) => {
            if let Some(window) = app.get_webview_window("main") {
                show_error(&window, &message);
            }
        }
    }
}

fn ensure_server(state: &ServerState, log_path: &Path) -> Result<(), String> {
    if health_ok() {
        append_log(log_path, "BioStore is already running; attaching without spawning.");
        return Ok(());
    }
    if state.stop.load(Ordering::SeqCst) {
        return Err("BioStore closed before the server was ready.".into());
    }

    let repo = repo_root();
    let python = resolve_python()?;
    let run_py = repo.join("run.py");
    if !run_py.is_file() {
        return Err(format!(
            "Could not find {}.\nThe desktop shell must be run from a BioStore checkout.",
            run_py.display()
        ));
    }

    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create {}: {err}", parent.display()))?;
    }
    append_log(
        log_path,
        &format!(
            "--- starting {} -u {} --desktop (cwd {}) ---",
            python.display(),
            run_py.display(),
            repo.display()
        ),
    );

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|err| format!("Could not open {}: {err}", log_path.display()))?;
    let stderr = log_file
        .try_clone()
        .map_err(|err| format!("Could not write {}: {err}", log_path.display()))?;

    let mut cmd = quiet_command(&python);
    cmd.arg("-u")
        .arg(&run_py)
        .arg("--desktop")
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr))
        .env("PYTHONUNBUFFERED", "1");

    let child = cmd.spawn().map_err(|err| {
        format!(
            "Could not start {} ({err}).\n\n{}",
            python.display(),
            tail(log_path, 40)
        )
    })?;
    {
        let mut slot = state.child.lock().map_err(|_| "Server lock was poisoned.".to_string())?;
        *slot = Some(child);
    }
    if state.stop.load(Ordering::SeqCst) {
        state.stop_child();
        return Err("BioStore closed before the server was ready.".into());
    }

    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if state.stop.load(Ordering::SeqCst) {
            state.stop_child();
            return Err("BioStore closed before the server was ready.".into());
        }
        if health_ok() {
            return Ok(());
        }
        let exited = {
            let mut slot = state
                .child
                .lock()
                .map_err(|_| "Server lock was poisoned.".to_string())?;
            match slot.as_mut() {
                Some(child) => child
                    .try_wait()
                    .map_err(|err| format!("Could not check the Python process: {err}"))?
                    .is_some(),
                None => true,
            }
        };
        if exited {
            state.stop_child();
            return Err(format!(
                "Python exited before BioStore was ready.\n\n{}",
                tail(log_path, 40)
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    state.stop_child();
    Err(format!(
        "BioStore did not respond at {SERVER_ORIGIN}.\n\n{}",
        tail(log_path, 40)
    ))
}

fn health_ok() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], 8765).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(
            b"GET /api/auth/status HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while buf.len() < 8192 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    is_biostore_response(&buf)
}

fn is_biostore_response(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let Some(status) = text.lines().next() else {
        return false;
    };
    let ok = status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200");
    ok && text.contains("\"auth_required\"")
}

fn resolve_python() -> Result<PathBuf, String> {
    let output = python_probe()
        .output()
        .map_err(|err| {
            format!(
                "Could not find Python ({err}). Install Python and make sure the {launcher} launcher is on PATH.",
                launcher = python_launcher_name()
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{launcher} failed while looking up the Python executable.\n{stderr}",
            launcher = python_launcher_name()
        ));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err(format!(
            "{launcher} did not report a Python executable.",
            launcher = python_launcher_name()
        ));
    }
    Ok(PathBuf::from(path))
}

fn python_launcher_name() -> &'static str {
    if cfg!(windows) {
        "py -3"
    } else {
        "python3"
    }
}

fn python_probe() -> Command {
    #[cfg(windows)]
    {
        let mut cmd = quiet_command("py");
        cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("python3");
        cmd.args(["-c", "import sys; print(sys.executable)"]);
        cmd
    }
}

fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn repo_root() -> PathBuf {
    let adjacent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    adjacent.canonicalize().unwrap_or(adjacent)
}

fn log_file_path() -> PathBuf {
    log_dir().join("desktop.log")
}

fn log_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("BioStore")
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("Logs")
            .join("BioStore")
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".local").join("state"))
            })
            .unwrap_or_else(|| PathBuf::from("."))
            .join("biostore")
    }
}

fn append_log(path: &Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn tail(path: &Path, lines: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return "(no Python output yet)".into();
    };
    let kept: Vec<&str> = text.lines().rev().take(lines).collect();
    if kept.is_empty() {
        return "(no Python output yet)".into();
    }
    kept.into_iter().rev().collect::<Vec<_>>().join("\n")
}

fn show_error(window: &tauri::WebviewWindow, message: &str) {
    let payload = serde_json::to_string(message).unwrap_or_else(|_| "\"unknown error\"".into());
    let js = format!(
        "(function(message) {{
            function attempt(left) {{
                if (window.biostoreShowError) window.biostoreShowError(message);
                else if (left > 0) setTimeout(function() {{ attempt(left - 1); }}, 50);
            }}
            attempt(40);
        }})({payload})"
    );
    let _ = window.eval(js);
}

#[cfg(test)]
mod tests {
    use super::is_biostore_response;

    #[test]
    fn recognizes_auth_status() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"auth_required\":false}";
        assert!(is_biostore_response(raw));
    }

    #[test]
    fn rejects_other_servers() {
        let html = b"HTTP/1.1 200 OK\r\n\r\n<html>nope</html>";
        assert!(!is_biostore_response(html));
        let missing = b"HTTP/1.1 404 NOT FOUND\r\n\r\n{\"auth_required\":false}";
        assert!(!is_biostore_response(missing));
    }
}
