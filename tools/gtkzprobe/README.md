# gtkzprobe - two child WebKitGTK views in one window: who is on top, and what puts the other one back?

The Linux twin of `tools/wkzprobe z` and `tools/wvzprobe z`, and the instrument
for the `ENGINES-GAP` that `browser_raise` carries on webkitgtk (card
`e0821533`, probe asked for by card `99e56f4f`). Same five questions, same
shape: a host webview filling the window plus child webviews positioned by
`set_bounds`, exactly like a browser pane.

## The premise that was wrong: it is not a GtkFixed

The shell's gap said "wry puts every child with `GtkFixed.put`, which appends".
That is the OTHER shape. With the `x11` feature, which is ON by default and is
what the shell builds with, `new_as_child` creates a real X11 window with
`XCreateSimpleWindow` as a child of the parent's X window and hangs a GTK
toplevel off it (`webkitgtk/mod.rs:159` and `:192`). `GtkFixed.put` (`:620`)
only serves `new_gtk`, which panes do not use.

So the pile is an X11 stacking order, the question "which call reorders it" is
an X11 question, and the candidate is **`XRaiseWindow`**: a restack and nothing
else, so it should move no geometry and touch no input focus. The probe reads
the tree with `XQueryTree` (bottom first, last is the top) and the screen with
`XGetImage` on the root window, each page painting a colour of its own: two
independent verdicts, as on the other two platforms.

## Running it

This repository has no Linux machine, so the probe brings its own. One
container, one Xvfb, one run:

```bash
docker build -t gtkzprobe tools/gtkzprobe && docker run --rm gtkzprobe
```

Exit 0 = every expectation met, 1 = at least one missed, 2 = wrong platform or
no X11 display, 3 = watchdog at 40 s. Debian bookworm is the oldest
distribution carrying `webkit2gtk-4.1`, the ABI wry 0.55 links against, and the
container disables compositing, DMABUF and the sandbox, because Xvfb has no GPU
and the container hands out no namespaces.

**The step clock is a proxy wake, not `ControlFlow::WaitUntil`**, for the reason
`tools/wvzprobe/README.md` records: on Windows two `WaitUntil` shapes never ran
a single step, and a thread posting a user event every 600 ms is the one clock
both backends owe the caller. Worth knowing before writing any other timed probe
here.

## Measured

**Not yet run.** The arm and its machine are written and the container builds,
but no verdict has been taken on a real WebKitGTK yet, so nothing is claimed
here: the `ENGINES-GAP` on webkitgtk in `lib.rs` stays open and now names this
probe as its instrument. When the run happens, the table goes here in the shape
`tools/wvzprobe/README.md` uses, with the date and the WebKitGTK version, and a
run under Xvfb has to say out loud what it cannot: a software-rendered, unmanaged
X server is not a user's desktop, and a window manager is entitled to restack
windows on its own.
