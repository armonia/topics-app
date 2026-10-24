#!/usr/bin/env python3
"""capped.py LIMIT_MB TIMEOUT_S -- cmd...: Linux twin of the Mac cap used for #427's bar.

Kills the whole process group past LIMIT_MB of resident memory (summed over
the process tree) or TIMEOUT_S. Exit 137 on the memory cap, 124 on the time
cap, otherwise cmd's own exit code; one "[capped]" line on stderr either way.
"""
import os
import signal
import subprocess
import sys
import time

limit_mb, timeout_s = float(sys.argv[1]), float(sys.argv[2])
cmd = sys.argv[sys.argv.index("--") + 1:]
page = os.sysconf("SC_PAGE_SIZE")


def tree_rss_mb(root):
    children = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(int(name))
    total, stack = 0, [root]
    while stack:
        pid = stack.pop()
        try:
            with open(f"/proc/{pid}/statm") as f:
                total += int(f.read().split()[1]) * page
        except (OSError, ValueError, IndexError):
            pass
        stack.extend(children.get(pid, []))
    return total / 1048576


proc = subprocess.Popen(cmd, start_new_session=True)
start, peak = time.monotonic(), 0.0


def kill(line, code):
    os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()
    print(line, file=sys.stderr)
    sys.exit(code)


while proc.poll() is None:
    mb = tree_rss_mb(proc.pid)
    peak = max(peak, mb)
    if mb > limit_mb:
        kill(f"[capped] killed: footprint {mb:.0f} MB > {limit_mb:.0f} MB", 137)
    if time.monotonic() - start > timeout_s:
        kill(f"[capped] killed: over {timeout_s:.0f} s, peak {peak:.0f} MB", 124)
    time.sleep(0.2)
print(f"[capped] peak {peak:.0f} MB", file=sys.stderr)
sys.exit(proc.returncode)
