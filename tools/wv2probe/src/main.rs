//! Does building a WebView2 child webview INSIDE the IPC callback hang?
//!
//!   wv2probe.exe sync    - build the child from inside the ipc handler (2.2.281)
//!   wv2probe.exe queued  - post to the event loop and build there (the fix)
//!
//! Writes wv2probe-<arm>.log next to itself and exits by itself: 0 = the child
//! was built, 3 = nothing after the watchdog window.
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{Rect, WebContext, WebViewBuilder};

#[derive(Debug, Clone, Copy)]
enum Ev {
    OpenChild,
}

static mut START: Option<Instant> = None;

fn log_path(arm: &str) -> PathBuf {
    let mut p = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    p.pop();
    p.join(format!("wv2probe-{arm}.log"))
}

fn log(arm: &str, line: &str) {
    let ms = unsafe {
        #[allow(static_mut_refs)]
        START.map(|s| s.elapsed().as_millis()).unwrap_or(0)
    };
    let text = format!("{ms:>6} ms  {line}\n");
    print!("{text}");
    let _ = std::io::stdout().flush();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path(arm)) {
        let _ = f.write_all(text.as_bytes());
    }
}

fn child_store(arm: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("wv2probe-child-store-{arm}"));
    let _ = std::fs::create_dir_all(&p);
    p
}

fn main() {
    let arm = std::env::args().nth(1).unwrap_or_else(|| "sync".to_string());
    unsafe { START = Some(Instant::now()) };
    let _ = std::fs::remove_file(log_path(&arm));
    log(&arm, &format!("arm={arm}"));

    // The watchdog is the whole point: a deadlock does not report itself.
    {
        let arm = arm.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(25));
            log(&arm, "WATCHDOG: no child webview after 25s");
            std::process::exit(3);
        });
    }

    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("wv2probe")
        .with_inner_size(LogicalSize::new(900.0, 600.0))
        .build(&event_loop)
        .expect("window");

    let arm_for_ipc = arm.clone();
    let window_ptr = &window as *const tao::window::Window;
    let main_view = WebViewBuilder::new()
        .with_html("<body style='background:#123'><script>window.ipc.postMessage('go')</script></body>")
        .with_ipc_handler(move |_req| {
            let arm = arm_for_ipc.clone();
            log(&arm, "ipc handler: entered (inside the WebView2 callback)");
            if arm == "sync" {
                // Exactly the shape 2.2.281 shipped: the child is built while the
                // outer COM call is still on the stack.
                let w: &tao::window::Window = unsafe { &*window_ptr };
                let v = build_child(&arm, w);
                std::mem::forget(v);
                log(&arm, "RESULT: built inside the callback");
                std::process::exit(0);
            } else {
                let _ = proxy.send_event(Ev::OpenChild);
                log(&arm, "ipc handler: queued to the event loop");
            }
            log(&arm, "ipc handler: returned");
        })
        .build(&window)
        .expect("main webview");

    let arm_loop = arm.clone();
    let mut kept: Vec<wry::WebView> = Vec::new();
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => log(&arm_loop, "event loop: started"),
            Event::UserEvent(Ev::OpenChild) => {
                log(&arm_loop, "event loop: building the child");
                kept.push(build_child(&arm_loop, &window));
                log(&arm_loop, "RESULT: built on the event loop");
                std::process::exit(0);
            }
            _ => {}
        }
        let _ = &main_view;
    });
}

fn build_child(arm: &str, window: &tao::window::Window) -> wry::WebView {
    // A user data folder of its own, like a Topics pane with `isolate: true`:
    // that is what forces a brand new WebView2 environment.
    let mut ctx = WebContext::new(Some(child_store(arm)));
    WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url("about:blank")
        .with_bounds(Rect {
            position: LogicalPosition::new(20.0, 20.0).into(),
            size: LogicalSize::new(400.0, 300.0).into(),
        })
        .build_as_child(window)
        .expect("child webview")
}
