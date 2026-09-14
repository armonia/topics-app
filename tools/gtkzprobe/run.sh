#!/bin/sh
# Xvfb started by hand, not through xvfb-run: in this image xvfb-run never
# handed control to the probe (the container sat there with an X server up, a
# live wrapper and no process of ours), and a probe that never runs reports
# nothing. Started explicitly, the exit code below is the probe's own, which is
# the whole answer of the arm.
set -e
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
sleep 3
DISPLAY=:99 exec ./target/release/gtkzprobe "$@"
