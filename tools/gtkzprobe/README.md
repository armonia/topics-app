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

Run 2026-09-14 in the container above (Debian bookworm, webkit2gtk-4.1,
Xvfb 1280x800x24), exit 0:

| question | answer |
|---|---|
| pane created first, floating view second | the **second** is on top |
| `set_bounds` on the lower view | **no reorder** - it stays underneath |
| `XRaiseWindow` on the lower view | the raised view **wins** |
| the raised view held the keyboard | the focus **stays inside it** |
| a third view created afterwards | **covers** the raised one |
| the raised page | **survives** - same token it minted at birth, no reload |

Same rule as the other two engines: **stacking is creation order**, and only an
explicit reorder changes it. **The raise is one `XRaiseWindow` on the child's X
window and nothing else** - no geometry moves, and the focus does not follow.

What is missing to write the arm in `browser_linux.rs` is not the call, it is
the handle: wry exposes no accessor for a child's X window, so the shell will
have to find it the way this probe does (walk `XQueryTree` under the parent) or
get one added upstream.

**Two independent verdicts, not one**, as on the other platforms: the window
tree (`XQueryTree`, bottom first) and the screen pixel at the overlap
(`XGetImage` on the root, each page painting a colour of its own). They agree
everywhere except right after the raise, where the tree already says `pane` and
the pixel still says `floater`: the restacked window had not repainted when the
frame was read. The verdict is the tree's, and the disagreement is what tells
you why.

**A size surprise, worth knowing before trusting any geometry here.** The two
ways a child gets its size do not agree: at CREATION wry scales the logical rect
by the GDK dpi factor (a view asked for 420 comes back 438 wide, 100/96 of it),
while `set_bounds` afterwards writes the numbers through unscaled (420). The
probe matches views by width with a 6% tolerance for exactly this reason. Under
X11 tao's own `scale_factor()` is 1.0 and does not explain the difference.

## What it does not say

Only the stacking of sibling child webviews inside ONE window, under Xvfb. A
software-rendered X server with no window manager is not a user's desktop: a
real window manager is entitled to restack windows on its own, and the pixel
counter proof is weaker here than on the other two platforms (on a reused
container with a locked soup profile the pages never painted and every pixel
read came back black, while the tree verdicts were unaffected). The Wayland
session, where there are no X11 child windows at all, is a different question
this probe cannot reach.
