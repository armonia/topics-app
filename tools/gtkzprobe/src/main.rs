//! Two child WebKitGTK views in one window: who is on top, and which call puts
//! the lower one back over the other without reloading its page?
//!
//!   gtkzprobe z   - z order: creation order, set_bounds, raise, page state, keyboard
//!
//! The Linux twin of `tools/wkzprobe z`, which measured the same five questions
//! on WKWebView, and the instrument for the two `ENGINES-GAP` lines
//! `browser_raise` carries in the shell (card e0821533). wry is used directly,
//! so the answers are about the engine, not about Tauri: a `#[tauri::command]`
//! only adds serde and a hop through the event loop on the same path.
//!
//! The arm prints one verdict per line and exits by itself: 0 = every
//! expectation met, 1 = at least one missed, 2 = wrong platform or no X11
//! display, 3 = watchdog.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{Rect, WebView, WebViewBuilder};

#[cfg(target_os = "linux")]
mod views;

const PANE: Rect = rect(80.0, 80.0, 420.0, 300.0);
const FLOATER: Rect = rect(300.0, 220.0, 360.0, 240.0);

/// The step clock of the arm: one of these per 600 ms, posted from a thread.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Tick;

const fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: wry::dpi::Position::Logical(LogicalPosition::new(x, y)),
        size: wry::dpi::Size::Logical(LogicalSize::new(w, h)),
    }
}

fn html(color: &str, label: &str) -> String {
    format!(
        "<body style='margin:0;background:{color};color:#fff;font:14px system-ui'>\
         <script>window.__probeState=Math.floor(Math.random()*1e9);\
         window.ipc.postMessage('born:{label}:'+window.__probeState);</script>\
         <h3 style='padding:8px'>{label}</h3></body>"
    )
}

fn main() {
    let arm = std::env::args().nth(1).unwrap_or_else(|| "z".to_string());
    #[cfg(not(target_os = "linux"))]
    {
        println!("gtkzprobe measures WebKitGTK child windows: Linux only (arm={arm})");
        std::process::exit(2);
    }
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(40));
            println!("WATCHDOG: no verdict after 40s");
            std::process::exit(3);
        });
        match arm.as_str() {
            "z" => run_z(),
            other => {
                println!("unknown arm {other}: use z");
                std::process::exit(2);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn run_z() {
    let event_loop = EventLoopBuilder::<Tick>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(600));
        if proxy.send_event(Tick).is_err() {
            return;
        }
    });
    let window = WindowBuilder::new()
        .with_title("gtkzprobe z")
        .with_inner_size(LogicalSize::new(760.0, 520.0))
        .build(&event_loop)
        .expect("window");

    let born: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let host = {
        let born = born.clone();
        WebViewBuilder::new()
            .with_html(html("#222", "host"))
            .with_ipc_handler(move |req| born.borrow_mut().push(req.body().to_string()))
            .build(&window)
            .expect("host webview")
    };
    let pane = child(&window, "#2d6cdf", "pane", born.clone(), PANE);
    // Both stay alive for the run: a dropped WebView takes its window with it.
    let floater = child(&window, "#c0392b", "floater", born.clone(), FLOATER);
    let _ = (&host, &floater);

    let Some(x) = views::X::open(&window) else {
        println!("no X11 display: this probe needs X11 (Xvfb is enough), not Wayland");
        std::process::exit(2);
    };

    // The overlap of the two rects, in window coordinates: whoever owns that
    // point is the one the user would click (and see).
    let probe_point = (360.0, 260.0);
    let mut step = 0usize;
    let mut late: Vec<WebView> = Vec::new();
    let mut verdicts: Vec<String> = Vec::new();

    // The steps are driven by a thread that posts a user event every 600 ms,
    // not by `ControlFlow::WaitUntil`. Two shapes were tried first on the
    // Windows machine and neither ran a single step: re-arming `WaitUntil` on
    // every event pushes the deadline forever, because WebView2 wakes the loop
    // constantly and each wake arrives as `WaitCancelled`; and a deadline held
    // outside the closure never fired at all. A proxy wake is the one thing
    // both backends owe the caller.
    event_loop.run(move |event, _target, control| {
        *control = ControlFlow::Wait;
        if !matches!(event, Event::UserEvent(Tick)) {
            return;
        }
        step += 1;
        match step {
            1 => {}
            2 => {
                println!("== 1. after creation (pane first, floater second)");
                x.report(probe_point);
                verdicts.push(format!("created-last-on-top={}", x.top_at(probe_point) == "floater"));
            }
            3 => {
                println!("== 2. after a set_bounds on the FIRST view (the pane moves)");
                let _ = pane.set_bounds(rect(90.0, 90.0, 420.0, 300.0));
                x.report(probe_point);
                verdicts.push(format!(
                    "set_bounds-does-not-reorder={}",
                    x.top_at(probe_point) == "floater"
                ));
            }
            4 => {
                // The pane holds the keyboard before it is raised, as it would
                // for someone typing in the floating window when a new view is
                // born and the shell raises the window back up.
                let focused = x.focus_role("pane");
                println!("== 3. after raising the pane (XRaiseWindow, nothing else)");
                println!("   keyboard was inside the pane before the raise: {focused}");
                x.raise_role("pane");
                x.report(probe_point);
                verdicts.push(format!("raise-wins={}", x.top_at(probe_point) == "pane"));
                // Read right after the raise, before step 5 creates a view.
                verdicts.push(format!(
                    "keyboard-survives-the-raise={}",
                    focused && x.focus_is("pane")
                ));
                let _ = pane
                    .evaluate_script("window.ipc.postMessage('after-raise:pane:'+window.__probeState)");
            }
            5 => {
                println!("== 4. after creating a THIRD child view, last of all");
                late.push(child(
                    &window,
                    "#27ae60",
                    "late",
                    born.clone(),
                    rect(320.0, 240.0, 300.0, 200.0),
                ));
            }
            6 => {
                x.report(probe_point);
                verdicts.push(format!("newcomer-covers-raised={}", x.top_at(probe_point) == "late"));
                let msgs = born.borrow().clone();
                let state_at_birth = msgs.iter().find(|m| m.starts_with("born:pane:")).cloned();
                let state_after = msgs.iter().find(|m| m.starts_with("after-raise:pane:")).cloned();
                let kept = match (&state_at_birth, &state_after) {
                    (Some(a), Some(b)) => {
                        a.trim_start_matches("born:pane:") == b.trim_start_matches("after-raise:pane:")
                    }
                    _ => false,
                };
                verdicts.push(format!("page-survives-the-raise={kept}"));
                println!("== verdict");
                for v in &verdicts {
                    println!("   {v}");
                }
                let ok = verdicts.iter().all(|v| v.ends_with("=true"));
                println!(
                    "{}",
                    if ok {
                        "all expectations met"
                    } else {
                        "AT LEAST ONE EXPECTATION MISSED"
                    }
                );
                std::process::exit(if ok { 0 } else { 1 });
            }
            _ => {}
        }
    });
}

#[cfg(target_os = "linux")]
fn child(
    window: &tao::window::Window,
    color: &str,
    label: &str,
    born: Rc<RefCell<Vec<String>>>,
    bounds: Rect,
) -> WebView {
    WebViewBuilder::new()
        .with_html(html(color, label))
        .with_ipc_handler(move |req| born.borrow_mut().push(req.body().to_string()))
        .with_bounds(bounds)
        .build_as_child(window)
        .expect("child webview")
}
