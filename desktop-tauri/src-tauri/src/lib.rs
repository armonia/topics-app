// Topics — low-footprint desktop shell (Tauri).
//
// PORTING-PLAN.md Tier 1. This replaces the Electron main process. The React UI
// is loaded from the live server origin (http://localhost:3333) exactly like the
// Electron shell did; native capabilities the web app needs (perf metrics, and —
// later — pty terminals + the CEF browser pane) are exposed as Tauri commands and
// reached from the client via client/src/lib/shell. Window lifecycle, theme,
// open-external and relaunch are covered by the official plugins below, whose JS
// APIs the shell bridge calls directly.

use serde::Serialize;

/// Per-process footprint, mirroring (a subset of) the Electron `perf.getMetrics`
/// shape so the status-bar dropdown can show the real desktop RAM/CPU. NOTE: on
/// macOS the WKWebView content/GPU/network processes are XPC services reparented
/// to launchd, so attributing them to this app from sysinfo is unreliable; we
/// report the shell process here and refine attribution later.
#[derive(Serialize)]
struct PerfMetrics {
    version: String,
    /// Resident memory of the shell process, in MB.
    total_mb: f64,
    /// CPU usage percent of the shell process (single-sample; approximate).
    cpu_percent: f32,
    /// Whether the figure is the full app footprint or just the shell process.
    partial: bool,
}

#[tauri::command]
fn perf_metrics(app: tauri::AppHandle) -> PerfMetrics {
    use sysinfo::System;
    let version = app.package_info().version.to_string();
    let mut sys = System::new();
    let (total_mb, cpu_percent) = match sysinfo::get_current_pid() {
        Ok(pid) => {
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            match sys.process(pid) {
                Some(p) => ((p.memory() as f64) / 1_048_576.0, p.cpu_usage()),
                None => (0.0, 0.0),
            }
        }
        Err(_) => (0.0, 0.0),
    };
    PerfMetrics { version, total_mb, cpu_percent, partial: true }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![perf_metrics])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
