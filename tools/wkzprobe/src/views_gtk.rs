//! Reading the GTK widget tree from outside wry: which child webviews exist, in
//! which order they sit inside the window's vertical box, and which one a point
//! lands on where two of them overlap. The Linux third of what `views_mac.rs`
//! does with AppKit and `views_win.rs` with Win32, same five functions, same
//! meaning.
//!
//! THE CONSTRAINT THAT KILLED THE PREVIOUS PROBE, and the reason this file
//! looks nothing like its two siblings. On macOS and Windows wry gives every
//! child webview a window of its own, so z order is a real thing you can ask
//! the OS about. On Linux it does not: the shell opens panes with
//! `window.add_child`, tauri-runtime-wry 2.11.3 turns that into
//! `build_gtk(window.default_vbox())`, and wry 0.55.1 `pack_start`s the webview
//! into that GtkBox (`webkitgtk/mod.rs`). There is no child X11 window, so
//! there is no z order to raise: a probe built on `build_as_child`, `new_x11`
//! or `XRaiseWindow` measures a road the shell never takes, and a verdict read
//! from `XQueryTree` right after `XRaiseWindow` is tautological - it asks the
//! same API that was just told what to answer.
//!
//! So this backend asks a different question, the only honest one under GTK:
//! inside a GtkBox, two packed widgets do not overlap at all. They are laid out
//! side by side, and "which one is on top at this point" has one answer that
//! never changes because the geometry decides it, not a stacking order.
//! `top_at` reports the widget whose ALLOCATION contains the point, read after
//! a rendering tick, which is the pixel truth the card asks for.
//!
//! What that means for the verdicts is written in the module that prints them:
//! under GTK the raise arm is expected to be a NO, and that no is a result, not
//! a failure. The card says so in as many words: "if under GTK no call reorders
//! two webviews packed in the vbox, that is a result: declare the gap with the
//! measurement instead of closing it."

use gtk::prelude::*;
use tao::platform::unix::WindowExtUnix;

/// Every webview widget packed into the window's vbox, in packing order: first
/// is the first one packed, last is the last.
///
/// `children()` on a GtkBox returns them in packing order, which is also paint
/// order, so no reversal is needed here (the Win32 backend does reverse, since
/// `EnumChildWindows` walks top-first).
fn packed(window: &tao::window::Window) -> Vec<gtk::Widget> {
    let Some(vbox) = window.default_vbox() else {
        return Vec::new();
    };
    vbox.children()
        .into_iter()
        // The vbox holds the menubar too when there is one; only the webview
        // widgets carry a WebKitWebView type name.
        .filter(|w| w.type_().name().contains("WebKitWebView"))
        .collect()
}

/// Views are named by the width the probe ASKED for, not by the width they got.
///
/// The other two backends read the allocated width, because on macOS and
/// Windows a child webview is a window and has its size from birth. Under GTK
/// it does not: until the box has run a layout pass every packed widget reads
/// `-1 x -1` at `1x1`, and the first run of this probe on CI proved it - two
/// views found, both `unknown`, every verdict `false` for a reason that had
/// nothing to do with z order. That is a measurement artefact wearing the
/// costume of a result, which is worse than no measurement.
///
/// So the role is taken from the ORDER the probe creates them in, which it
/// controls: pane first, floater second, late third. `packed()` returns them in
/// packing order, so the index IS the identity.
fn role_at(index: usize) -> &'static str {
    match index {
        0 => "pane",
        1 => "floater",
        2 => "late",
        _ => "unknown",
    }
}

/// Fa girare il main loop di GTK finche' ha eventi in coda, cosi' il layout
/// esiste prima che qualcuno legga le allocazioni. Bounded: `events_pending`
/// puo' restare vero per sempre se qualcosa continua a produrre eventi, e un
/// ciclo senza tetto qui appenderebbe la sonda invece di misurarla.
fn pump_layout() {
    for _ in 0..200 {
        if !gtk::events_pending() {
            break;
        }
        gtk::main_iteration_do(false);
    }
}

/// The allocation of a widget in window coordinates.
fn alloc(w: &gtk::Widget) -> (f64, f64, f64, f64) {
    let a = w.allocation();
    (a.x() as f64, a.y() as f64, a.width() as f64, a.height() as f64)
}

/// Prints what is packed and where, so a reader can see the geometry that
/// produced the verdict instead of trusting the verdict.
pub fn report(window: &tao::window::Window, point: (f64, f64)) {
    // Un giro di main loop PRIMA di leggere, e non e' scaramanzia: sotto GTK le
    // allocazioni valgono `-1 x -1` a `1x1` finche' il box non ha fatto un
    // passaggio di layout, e la prima corsa di questa sonda su CI ha letto
    // esattamente quello - due view trovate, sei verdetti `false` per un motivo
    // che non c'entrava niente con lo z order. Un artefatto di misura travestito
    // da risultato e' peggio di nessuna misura.
    pump_layout();
    let views = packed(window);
    if views.is_empty() {
        println!("   (no webview packed in the vbox)");
        return;
    }
    for (i, w) in views.iter().enumerate() {
        let (x, y, cw, ch) = alloc(w);
        println!(
            "   [{i}] {:<8} allocation x={x:.0} y={y:.0} w={cw:.0} h={ch:.0}",
            role_at(i)
        );
    }
    println!("   point {:?} lands on: {}", point, top_at(window, point));
}

/// Which view a point lands on.
///
/// Under GTK this is a question about LAYOUT, not about stacking: `pack_start`
/// lays widgets out side by side inside the box, so at most one allocation can
/// contain the point. When none does, the point fell on the box itself, which
/// is the honest answer and not "nobody is on top".
pub fn top_at(window: &tao::window::Window, point: (f64, f64)) -> String {
    // Anche qui, e non solo in `report`: questa funzione e' chiamata
    // direttamente da ogni verdetto, e leggere un'allocazione non ancora
    // calcolata darebbe `none` per tutti.
    pump_layout();
    for (i, w) in packed(window).into_iter().enumerate() {
        let (x, y, cw, ch) = alloc(&w);
        if point.0 >= x && point.0 < x + cw && point.1 >= y && point.1 < y + ch {
            return role_at(i).to_string();
        }
    }
    "none".to_string()
}

/// Ask the widget of `which` to come forward.
///
/// Three candidates, tried in order, because the card asks which call - if any -
/// reorders two packed webviews WITHOUT reloading them:
///
/// 1. `GdkWindow::raise` on the widget's own gdk window. This is the call
///    `browser_linux::raise` makes in the shell, behind its `has_window` guard,
///    and it is the one whose usefulness has never been measured. Under
///    `pack_start` the widget usually has no window of its own, in which case
///    the guard is false and the call never happens: that alone is worth
///    reporting.
/// 2. `reorder_child` to the last position in the box. This is the GTK way to
///    change packing order, and it is NOT what the shell does today.
/// 3. nothing else: if neither moves the pixels, the arm reports a no.
pub fn raise_role(window: &tao::window::Window, which: &str) {
    let Some(target) = packed(window)
        .into_iter()
        .enumerate()
        .find(|(i, _)| role_at(*i) == which)
        .map(|(_, w)| w)
    else {
        println!("   raise: no widget for role {which}");
        return;
    };

    // 1. The production call, with the same guard the shell applies.
    match target.window() {
        Some(gdk_window) => {
            gdk_window.raise();
            println!("   raise: GdkWindow::raise called (the widget HAS its own window)");
        }
        None => {
            println!(
                "   raise: the widget has NO gdk window of its own, so the shell's \
                 `has_window` guard is false and browser_linux::raise is a no-op here"
            );
        }
    }

    // 2. The packing-order move, reported separately so the two are not
    //    confused in the verdict.
    if let Some(vbox) = window.default_vbox() {
        let n = vbox.children().len() as i32;
        vbox.reorder_child(&target, n - 1);
        println!("   raise: reorder_child to position {} also applied", n - 1);
    }
}

/// Give the keyboard to a view. Returns whether the widget accepted it.
pub fn focus_role(window: &tao::window::Window, which: &str) -> bool {
    let Some(target) = packed(window)
        .into_iter()
        .enumerate()
        .find(|(i, _)| role_at(*i) == which)
        .map(|(_, w)| w)
    else {
        return false;
    };
    target.grab_focus();
    target.has_focus()
}

/// Is `which` the widget holding the keyboard right now?
pub fn first_responder_is(window: &tao::window::Window, which: &str) -> bool {
    packed(window)
        .into_iter()
        .enumerate()
        .any(|(i, w)| role_at(i) == which && w.has_focus())
}
