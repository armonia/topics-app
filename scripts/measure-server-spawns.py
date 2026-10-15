#!/usr/bin/env python3 -I
"""macOS only. Usage: python3 scripts/measure-server-spawns.py <pid> <seconds> [output.json]."""
import ctypes
import ctypes.util
import json
import select
import sys
import time
from collections import Counter


if sys.platform != "darwin":
    raise SystemExit("measure-server-spawns.py works only on macOS (kqueue NOTE_FORK).")
if len(sys.argv) not in (3, 4):
    raise SystemExit(__doc__)

pid, seconds = int(sys.argv[1]), float(sys.argv[2])
if seconds <= 0:
    raise SystemExit("seconds must be a positive number")
output_path = sys.argv[3] if len(sys.argv) == 4 else None
libproc = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")


def child_pids(parent_pid):
    buffer = (ctypes.c_int * 4096)()
    count = libproc.proc_listchildpids(parent_pid, buffer, ctypes.sizeof(buffer))
    return set(buffer[:max(0, count)]) if count > 0 else set()


def process_name(child_pid):
    buffer = ctypes.create_string_buffer(256)
    return buffer.value.decode(errors="replace") if libproc.proc_name(child_pid, buffer, 256) > 0 else "?"


queue = select.kqueue()
queue.control([
    select.kevent(
        pid,
        filter=select.KQ_FILTER_PROC,
        flags=select.KQ_EV_ADD,
        fflags=select.KQ_NOTE_FORK | select.KQ_NOTE_EXIT,
    )
], 0)

forks = 0
names = Counter()
seen = child_pids(pid)
end_at = time.time() + seconds
while time.time() < end_at:
    events = queue.control(None, 64, min(1.0, end_at - time.time()))
    for event in events:
        if event.fflags & select.KQ_NOTE_EXIT:
            print("The measured process exited.")
            end_at = 0
            break
        if event.fflags & select.KQ_NOTE_FORK:
            forks += 1
    if events:
        # posix_spawn reveals the child's name just after exec; retry for about 20 ms.
        for _ in range(4):
            current = child_pids(pid)
            for child_pid in current - seen:
                name = process_name(child_pid)
                if name not in ("?", "bun"):
                    names[name] += 1
                seen.add(child_pid)
            time.sleep(0.005)
        seen &= child_pids(pid)

result = {
    "pid": pid,
    "seconds": seconds,
    "forks": forks,
    "per_hour": round(forks * 3600 / seconds),
    "named_children": dict(names.most_common()),
}
print(json.dumps(result))
if output_path:
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(result, output_file)
