//! Two child WKWebViews in one window: who is on top, and can a live drag move
//! one of them by IPC without falling behind the cursor?
//!
//!   wkzprobe z      - z order: creation order, set_bounds, raise, page state
//!   wkzprobe drag   - round trip of one set_bounds per animation frame
//!
//! The probe uses wry directly, so its numbers are the FLOOR of what the Tauri
//! shell can do: a `#[tauri::command]` adds serde plus a hop through the event
//! loop on top of the same path.
//!
//! Both arms print a verdict and exit by themselves (0 = measured, 2 = wrong
//! platform, 3 = watchdog).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{Rect, WebView, WebViewBuilder};

#[cfg(target_os = "macos")]
mod views;

const PANE: Rect = rect(80.0, 80.0, 420.0, 300.0);
const FLOATER: Rect = rect(300.0, 220.0, 360.0, 240.0);

const fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: wry::dpi::Position::Logical(LogicalPosition::new(x, y)),
        size: wry::dpi::Size::Logical(LogicalSize::new(w, h)),
    }
}

fn html(color: &str, label: &str) -> String {
    format!(
        "<body style='margin:0;background:{color};color:#fff;font:14px -apple-system'>\
         <script>window.__probeState=Math.floor(Math.random()*1e9);\
         window.ipc.postMessage('born:{label}:'+window.__probeState);</script>\
         <h3 style='padding:8px'>{label}</h3></body>"
    )
}

/// The page of the floating view in the `drag` arm: one IPC per animation
/// frame, an ack back from the host, and a summary once the run is over.
const DRAG_PAGE: &str = r#"<body style='margin:0;background:#c0392b'>
<script>
const N = 240;
const post = new Array(N), ack = new Array(N);
let seq = 0;
window.__ack = (s) => { ack[s] = performance.now(); };
function frame() {
  if (seq >= N) { report(); return; }
  post[seq] = performance.now();
  window.ipc.postMessage('m:' + seq);
  seq += 1;
  requestAnimationFrame(frame);
}
function quantile(xs, q) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function report() {
  const rtt = [], gap = [];
  for (let i = 0; i < N; i++) if (ack[i] !== undefined) rtt.push(ack[i] - post[i]);
  for (let i = 1; i < N; i++) gap.push(post[i] - post[i - 1]);
  const out = {
    frames: N, acked: rtt.length,
    rttP50: quantile(rtt, 0.5), rttP95: quantile(rtt, 0.95), rttMax: Math.max(...rtt),
    frameP50: quantile(gap, 0.5), frameP95: quantile(gap, 0.95), frameMax: Math.max(...gap),
  };
  window.ipc.postMessage('done:' + JSON.stringify(out));
}
requestAnimationFrame(frame);
</script></body>"#;

fn main() {
    let arm = std::env::args().nth(1).unwrap_or_else(|| "z".to_string());
    #[cfg(not(target_os = "macos"))]
    {
        println!("wkzprobe measures WKWebView child views: macOS only (arm={arm})");
        std::process::exit(2);
    }
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(40));
            println!("WATCHDOG: no verdict after 40s");
            std::process::exit(3);
        });
        match arm.as_str() {
            "z" => run_z(),
            "drag" => run_drag(),
            other => {
                println!("unknown arm {other}: use z or drag");
                std::process::exit(2);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn run_z() {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("wkzprobe z")
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
    // Both stay alive for the run: a dropped WebView takes its view with it.
    let floater = child(&window, "#c0392b", "floater", born.clone(), FLOATER);
    let _ = (&host, &floater);

    // The overlap of the two rects, in window coordinates: whoever answers a
    // hit test there is the one the user would click (and see).
    let probe_point = (360.0, 260.0);
    let mut step = 0usize;
    let mut late: Vec<WebView> = Vec::new();
    let mut verdicts: Vec<String> = Vec::new();

    event_loop.run(move |event, _target, control| {
        *control = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(400));
        let tick = matches!(
            event,
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) | Event::NewEvents(StartCause::Init)
        );
        if !tick {
            return;
        }
        step += 1;
        match step {
            1 => {}
            2 => {
                println!("== 1. after creation (pane first, floater second)");
                views::report(&window, probe_point);
                verdicts.push(format!("created-last-on-top={}", views::top_at(&window, probe_point) == "floater"));
            }
            3 => {
                println!("== 2. after a set_bounds on the FIRST view (the pane moves)");
                let _ = pane.set_bounds(rect(90.0, 90.0, 420.0, 300.0));
                views::report(&window, probe_point);
                verdicts.push(format!(
                    "set_bounds-does-not-reorder={}",
                    views::top_at(&window, probe_point) == "floater"
                ));
            }
            4 => {
                println!("== 3. after raising the pane (removeFromSuperview + addSubview above)");
                views::raise_role(&window, "pane");
                views::report(&window, probe_point);
                verdicts.push(format!("raise-wins={}", views::top_at(&window, probe_point) == "pane"));
                let _ = pane.evaluate_script("window.ipc.postMessage('after-raise:pane:'+window.__probeState)");
            }
            5 => {
                println!("== 4. after creating a THIRD child view, last of all");
                late.push(child(&window, "#27ae60", "late", born.clone(), rect(320.0, 240.0, 300.0, 200.0)));
            }
            6 => {
                views::report(&window, probe_point);
                verdicts.push(format!("newcomer-covers-raised={}", views::top_at(&window, probe_point) == "late"));
                let msgs = born.borrow().clone();
                let state_at_birth = msgs.iter().find(|m| m.starts_with("born:pane:")).cloned();
                let state_after = msgs.iter().find(|m| m.starts_with("after-raise:pane:")).cloned();
                let kept = match (&state_at_birth, &state_after) {
                    (Some(a), Some(b)) => a.trim_start_matches("born:pane:") == b.trim_start_matches("after-raise:pane:"),
                    _ => false,
                };
                verdicts.push(format!("page-survives-the-raise={kept}"));
                println!("== verdict");
                for v in &verdicts {
                    println!("   {v}");
                }
                let ok = verdicts.iter().all(|v| v.ends_with("=true"));
                println!("{}", if ok { "all expectations met" } else { "AT LEAST ONE EXPECTATION MISSED" });
                std::process::exit(if ok { 0 } else { 1 });
            }
            _ => {}
        }
    });
}

#[cfg(target_os = "macos")]
fn run_drag() {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("wkzprobe drag")
        .with_inner_size(LogicalSize::new(900.0, 600.0))
        .build(&event_loop)
        .expect("window");

    let moved: Rc<RefCell<Option<WebView>>> = Rc::new(RefCell::new(None));
    // Host-side cost of the set_bounds call itself, frame by frame.
    let native_us: Rc<RefCell<Vec<u128>>> = Rc::new(RefCell::new(Vec::new()));
    let host = WebViewBuilder::new()
        .with_html(html("#222", "host"))
        .build(&window)
        .expect("host webview");
    let _ = &host;

    let view = {
        let moved = moved.clone();
        let native_us = native_us.clone();
        WebViewBuilder::new()
            .with_html(DRAG_PAGE)
            .with_ipc_handler(move |req| {
                let body = req.body().to_string();
                if let Some(seq) = body.strip_prefix("m:") {
                    let i: f64 = seq.parse().unwrap_or(0.0);
                    // 8 logical px per frame = ~480 px/s, an ordinary drag speed.
                    let x = 120.0 + (i % 60.0) * 8.0;
                    if let Some(v) = moved.borrow().as_ref() {
                        let t = Instant::now();
                        let _ = v.set_bounds(rect(x, 200.0, 320.0, 220.0));
                        native_us.borrow_mut().push(t.elapsed().as_micros());
                        let _ = v.evaluate_script(&format!("window.__ack({seq})"));
                    }
                } else if let Some(json) = body.strip_prefix("done:") {
                    let us = native_us.borrow();
                    let mut sorted = us.clone();
                    sorted.sort_unstable();
                    let p50 = sorted.get(sorted.len() / 2).copied().unwrap_or(0);
                    let p95 = sorted.get(sorted.len() * 95 / 100).copied().unwrap_or(0);
                    println!("page: {json}");
                    println!("native set_bounds: p50={p50}us p95={p95}us calls={}", sorted.len());
                    std::process::exit(0);
                }
            })
            .with_bounds(rect(120.0, 200.0, 320.0, 220.0))
            .build_as_child(&window)
            .expect("moved webview")
    };
    *moved.borrow_mut() = Some(view);

    event_loop.run(move |_event, _target, control| {
        *control = ControlFlow::Wait;
    });
}

#[cfg(target_os = "macos")]
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
