//! What one native browser pane costs on Windows, and the suspend WebView2 offers.
//!
//! ATTRIBUTION IS EXACT HERE. Every pane opens with `isolate: true`, which gives
//! it its own user-data folder and therefore its own WebView2 environment: its
//! own browser process and every renderer, GPU and utility process under it. So
//! the pane's cost is the sum over the processes of its environment, and none of
//! them is shared with another pane. Two labels that report the same
//! `browser_pid` (a shared environment) are left to the client to discard as not
//! attributable.
//!
//! THE ONE-READ RULE. Inside one `perf_metrics` call each process's CPU counter
//! is read exactly once, and the per-label figure is summed from that read. A
//! second read of the same process in the same call measures microseconds, which
//! is the defect this change fixes on macOS (`collect_webview_usage` in lib.rs).
//!
//! The delta rules below are plain functions so all three CI runners test them;
//! everything that talks to WebView2 or to kernel32 is `cfg(windows)`.

use std::time::Instant;

/// FILETIME is two halves of a count of 100 ns intervals.
pub(crate) fn filetime_to_ns(high: u32, low: u32) -> u64 {
    ((u64::from(high) << 32) | u64::from(low)).saturating_mul(100)
}

/// Percent of one core between two readings of a cumulative CPU counter.
///
/// `None` without a previous reading (a first read has no window to divide by),
/// with a zero or negative window, and when the counter went backwards (the pid
/// now belongs to a different process). Same rules as `proc_cpu_percent` on
/// macOS, so "not measured" means the same thing on both platforms.
pub(crate) fn cpu_delta_percent(prev: Option<(u64, Instant)>, now_ns: u64, now: Instant) -> Option<f32> {
    let (prev_ns, prev_at) = prev?;
    let dt = now.checked_duration_since(prev_at)?.as_secs_f64();
    if dt <= 0.0 || now_ns < prev_ns {
        return None;
    }
    Some(((now_ns - prev_ns) as f64 / 1e9 / dt * 100.0) as f32)
}

/// The figure of one pane: `None` unless EVERY process of it produced a delta.
/// A partial sum would read low exactly when a renderer is new, which is when a
/// page is loading, and a low reading there is not "quiet".
pub(crate) fn label_cpu(per_pid: &[Option<f32>]) -> Option<f32> {
    if per_pid.is_empty() {
        return None;
    }
    per_pid.iter().copied().try_fold(0.0f32, |acc, v| v.map(|x| acc + x))
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{cpu_delta_percent, filetime_to_ns, label_cpu};
    use std::collections::{HashMap, HashSet};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment8, ICoreWebView2_2, ICoreWebView2_3,
    };
    use webview2_com::TrySuspendCompletedHandler;
    use windows::core::Interface;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    /// label -> (browser process id, every process id of its environment).
    type PidMap = HashMap<String, (u32, Vec<u32>)>;

    static PANE_PIDS: std::sync::OnceLock<std::sync::Mutex<PidMap>> = std::sync::OnceLock::new();
    static CPU_PREV: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, (u64, Instant)>>> =
        std::sync::OnceLock::new();

    fn pane_pids() -> &'static std::sync::Mutex<PidMap> {
        PANE_PIDS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
    }

    /// Ask every webview for the processes of its environment. Asynchronous like
    /// `refresh_webview_content_pids` on macOS: `with_webview` runs on the UI
    /// thread, so this writes for the NEXT sample and never blocks the caller.
    pub(crate) fn refresh_webview_process_ids(app: &tauri::AppHandle) {
        use tauri::Manager;
        let live: HashSet<String> = app.webviews().keys().cloned().collect();
        if let Ok(mut m) = pane_pids().lock() {
            m.retain(|label, _| live.contains(label));
        }
        for (label, wv) in app.webviews() {
            let _ = wv.with_webview(move |platform| {
                let Some(entry) = (unsafe { environment_pids(&platform) }) else { return };
                if let Ok(mut m) = pane_pids().lock() {
                    m.insert(label, entry);
                }
            });
        }
    }

    /// # Safety
    /// Must run on the UI thread, inside `with_webview`.
    unsafe fn environment_pids(platform: &tauri::webview::PlatformWebview) -> Option<(u32, Vec<u32>)> {
        let core = unsafe { platform.controller().CoreWebView2() }.ok()?;
        let mut browser_pid = 0u32;
        unsafe { core.BrowserProcessId(&mut browser_pid) }.ok()?;
        let mut pids = vec![browser_pid];
        let env8 = core
            .cast::<ICoreWebView2_2>()
            .ok()
            .and_then(|c| unsafe { c.Environment() }.ok())
            .and_then(|e| e.cast::<ICoreWebView2Environment8>().ok());
        if let Some(env8) = env8 {
            if let Ok(infos) = unsafe { env8.GetProcessInfos() } {
                let mut count = 0u32;
                if unsafe { infos.Count(&mut count) }.is_ok() {
                    for i in 0..count {
                        let Ok(info) = (unsafe { infos.GetValueAtIndex(i) }) else { continue };
                        let mut pid = 0i32;
                        if unsafe { info.ProcessId(&mut pid) }.is_ok() && pid > 0 && pid as u32 != browser_pid {
                            pids.push(pid as u32);
                        }
                    }
                }
            }
        }
        (browser_pid > 0).then_some((browser_pid, pids))
    }

    struct ProcessHandle(HANDLE);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// Cumulative CPU (user + kernel) in ns and private bytes of one process.
    pub(super) fn read_process(pid: u32) -> Option<(u64, u64)> {
        let handle = ProcessHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
        let (mut created, mut exited, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
        let cpu = filetime_to_ns(kernel.dwHighDateTime, kernel.dwLowDateTime)
            .saturating_add(filetime_to_ns(user.dwHighDateTime, user.dwLowDateTime));
        let mut counters = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        let ok = unsafe {
            K32GetProcessMemoryInfo(
                handle.0,
                &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
                counters.cb,
            )
        };
        let private = if ok.as_bool() { counters.PrivateUsage as u64 } else { 0 };
        Some((cpu, private))
    }

    /// Percent of one core for each pid, one read each, against the previous call.
    pub(super) fn sample(pids: &HashSet<u32>) -> HashMap<u32, (Option<f32>, u64)> {
        let now = Instant::now();
        let cell = CPU_PREV.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
        let mut prev = cell.lock().unwrap_or_else(|e| e.into_inner());
        prev.retain(|pid, _| pids.contains(pid));
        let mut out = HashMap::new();
        for &pid in pids {
            let Some((cpu_ns, private)) = read_process(pid) else {
                prev.remove(&pid);
                continue;
            };
            let pct = cpu_delta_percent(prev.get(&pid).copied(), cpu_ns, now);
            prev.insert(pid, (cpu_ns, now));
            out.insert(pid, (pct, private));
        }
        out
    }

    pub(crate) fn collect_webview_usage() -> Vec<crate::WebviewUsage> {
        const MB: f64 = 1_048_576.0;
        let map: PidMap = match pane_pids().lock() {
            Ok(m) => m.clone(),
            Err(_) => return Vec::new(),
        };
        let all: HashSet<u32> = map.values().flat_map(|(_, pids)| pids.iter().copied()).collect();
        let read = sample(&all);
        let mut out: Vec<crate::WebviewUsage> = map
            .into_iter()
            .map(|(label, (browser_pid, pids))| {
                let per_pid: Vec<Option<f32>> = pids.iter().map(|p| read.get(p).and_then(|r| r.0)).collect();
                let private: u64 = pids.iter().filter_map(|p| read.get(p).map(|r| r.1)).sum();
                crate::WebviewUsage {
                    label,
                    pid: browser_pid as i32,
                    memory_mb: private as f64 / MB,
                    cpu_percent: label_cpu(&per_pid),
                }
            })
            .collect();
        out.sort_by(|a, b| a.label.cmp(&b.label));
        out
    }

    /// `ICoreWebView2_3::TrySuspend` on a pane that is already hidden. `Ok(false)`
    /// when WebView2 declined (audio playing, capture in progress): the hide is
    /// still in place, only the timers keep ticking.
    ///
    /// Blocks until the completion handler answers, so it must not run on the UI
    /// thread (same rule as every `*_blocking` of `browser_win`).
    pub(crate) fn try_suspend_blocking(wv: &tauri::Webview) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel::<Result<bool, String>>();
        wv.with_webview(move |platform| {
            let core3 = match unsafe { platform.controller().CoreWebView2() }
                .map_err(|e| format!("CoreWebView2: {e}"))
                .and_then(|c| c.cast::<ICoreWebView2_3>().map_err(|e| format!("ICoreWebView2_3: {e}")))
            {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(e));
                    return;
                }
            };
            let tx_cb = tx.clone();
            let handler = TrySuspendCompletedHandler::create(Box::new(move |hr, suspended| {
                let _ = tx_cb.send(hr.map(|()| suspended).map_err(|e| format!("TrySuspend: {e}")));
                Ok(())
            }));
            if let Err(e) = unsafe { core3.TrySuspend(&handler) } {
                let _ = tx.send(Err(format!("TrySuspend: {e}")));
            }
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(8))
            .map_err(|_| "suspend timeout".to_string())?
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::{collect_webview_usage, refresh_webview_process_ids, try_suspend_blocking};

#[cfg(test)]
mod tests {
    use super::{cpu_delta_percent, filetime_to_ns, label_cpu};
    use std::time::{Duration, Instant};

    #[test]
    fn filetime_counts_hundreds_of_nanoseconds_across_both_halves() {
        assert_eq!(filetime_to_ns(0, 1), 100);
        assert_eq!(filetime_to_ns(1, 0), (1u64 << 32) * 100);
        assert_eq!(filetime_to_ns(0, 10_000_000), 1_000_000_000);
    }

    #[test]
    fn a_delta_needs_a_previous_reading_a_window_and_a_counter_that_grew() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_secs(2);
        assert_eq!(cpu_delta_percent(None, 5, t1), None);
        assert_eq!(cpu_delta_percent(Some((0, t1)), 5, t1), None);
        assert_eq!(cpu_delta_percent(Some((10, t0)), 5, t1), None);
        let half_core = cpu_delta_percent(Some((0, t0)), 1_000_000_000, t1).unwrap();
        assert!((half_core - 50.0).abs() < 0.01, "{half_core}");
    }

    #[test]
    fn a_pane_is_measured_only_when_every_process_of_it_is() {
        assert_eq!(label_cpu(&[]), None);
        assert_eq!(label_cpu(&[Some(3.0), None]), None);
        assert_eq!(label_cpu(&[Some(3.0), Some(4.5)]), Some(7.5));
    }

    /// The Windows twin of `webview_cpu_comes_from_the_sample`: one read of a busy
    /// child per sample gives the share of a core the child really used over the
    /// window, not the gap between two syscalls.
    ///
    /// The reference is the child's own CPU time read independently around the two
    /// samples, so the bar follows whatever share a shared CI VM grants the loop.
    /// CI run 34996028402 read 12.5% for a `powershell` child sampled right after
    /// spawn: four 15.6 ms ticks, a process still starting .NET rather than looping.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_busy_process_reads_the_cpu_time_it_used_over_the_window() {
        struct BusyChild(std::process::Child);
        impl Drop for BusyChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = BusyChild(
            std::process::Command::new("cmd")
                .args(["/d", "/c", "for /l %i in (0,0,1) do @rem"])
                .spawn()
                .expect("spawn a busy child"),
        );
        let pid = child.0.id();
        let cpu_of = |pid: u32| super::imp::read_process(pid).expect("the child is readable").0;

        // In the loop before measuring: 50 ms of CPU already spent.
        let deadline = Instant::now() + Duration::from_secs(15);
        while cpu_of(pid) < 50_000_000 {
            assert!(Instant::now() < deadline, "the busy child never started spending CPU");
            std::thread::sleep(Duration::from_millis(20));
        }

        let pids: std::collections::HashSet<u32> = [pid].into_iter().collect();
        let (outer_cpu0, outer_t0) = (cpu_of(pid), Instant::now());
        let first = super::imp::sample(&pids);
        assert_eq!(first.get(&pid).and_then(|r| r.0), None, "a first read has no window");
        std::thread::sleep(Duration::from_millis(1_000));
        let second = super::imp::sample(&pids);
        let (outer_cpu1, outer_t1) = (cpu_of(pid), Instant::now());
        let pct = second.get(&pid).and_then(|r| r.0).expect("the second read has a delta");
        let reference = cpu_delta_percent(Some((outer_cpu0, outer_t0)), outer_cpu1, outer_t1).unwrap();

        // The CPU clock advances in 15.6 ms ticks: four of them over one second.
        assert!(reference >= 10.0, "the child got {reference}% of a core: nothing to compare against");
        assert!(
            (pct - reference).abs() <= 7.0,
            "sample read {pct}% of a core, the child's own CPU time says {reference}%"
        );
        drop(child);
    }
}
