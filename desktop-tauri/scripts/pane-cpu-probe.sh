#!/usr/bin/env bash
# pane-cpu-probe.sh <contextId> <seconds> - CPU of one native browser pane, read
# from OUTSIDE the app (macOS).
#
# The bar of change `mac-usabile-sotto-carico`, round 4 (gates P1..P3, T): every
# CPU gate compares a state against a control taken back to back, so the numbers
# must come from the same instrument each time and never from the app measuring
# itself. `ps -o time=` is cumulative CPU per process; two reads N seconds apart
# give % of one core over exactly that window.
#
# Which WebContent belongs to the pane: the one holding files under
# `WebsiteDataStore/<uuid>`, where the uuid is `data_store_uuid_for(contextId)`
# in desktop-tauri/src-tauri/src/lib.rs (two FNV-1a streams, v4 bits forced).
#
# Prints: pane WebContent, GPU, shell and the Topics total, where "Topics" is
# every process macOS holds the shell responsible for
# (`responsibility_get_pid_responsible_for_pid`, the call `perf_metrics` uses,
# reached here through python ctypes): Mail's own WebKit helpers stay out even
# with Mail in front, which is the control state of the protocol.
set -euo pipefail

ctx="${1:?usage: pane-cpu-probe.sh <contextId> <seconds>}"
secs="${2:?usage: pane-cpu-probe.sh <contextId> <seconds>}"

uuid="$(python3 - "$ctx" <<'PY'
import sys
MASK = (1 << 64) - 1
def fnv(seed, data):
    h = seed
    for b in data:
        h ^= b
        h = (h * 0x00000100000001B3) & MASK
    return h
c = sys.argv[1].encode()
out = bytearray(fnv(0xcbf29ce484222325, c).to_bytes(8, "big") + fnv(0x9e3779b97f4a7c15, c).to_bytes(8, "big"))
out[6] = (out[6] & 0x0F) | 0x40
out[8] = (out[8] & 0x3F) | 0x80
h = out.hex()
print(f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}")
PY
)"

shell_pid="$(pgrep -x Topics | head -1 || true)"
[ -n "$shell_pid" ] || { echo "Topics is not running" >&2; exit 2; }

# The helpers macOS holds the shell responsible for, with their names.
responsible="$(python3 - "$shell_pid" <<'PY'
import ctypes, subprocess, sys
own = int(sys.argv[1])
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
lib.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]
lib.responsibility_get_pid_responsible_for_pid.restype = ctypes.c_int
for line in subprocess.run(["ps", "-axo", "pid=,comm="], capture_output=True, text=True).stdout.splitlines():
    pid, _, comm = line.strip().partition(" ")
    if pid.isdigit() and int(pid) != own and lib.responsibility_get_pid_responsible_for_pid(int(pid)) == own:
        print(pid, comm.strip().rsplit("/", 1)[-1])
PY
)"
helpers="$(echo "$responsible" | awk '{print $1}')"
gpu_pid="$(echo "$responsible" | awk '/GPU/ {print $1; exit}')"
pane_pid=""
for p in $(echo "$responsible" | awk '/WebContent/ {print $1}'); do
  if lsof -p "$p" -Fn 2>/dev/null | grep -qi "WebsiteDataStore/$uuid"; then pane_pid="$p"; break; fi
done

# `ps -o time=` prints [[dd-]hh:]mm:ss.cc; to seconds.
cpu_seconds() {
  ps -o time= -p "$1" 2>/dev/null | awk '{
    n = split($1, a, /[-:]/); s = 0
    if (n == 2) s = a[1] * 60 + a[2]
    else if (n == 3) s = a[1] * 3600 + a[2] * 60 + a[3]
    else if (n == 4) s = a[1] * 86400 + a[2] * 3600 + a[3] * 60 + a[4]
    printf "%.2f", s
  }'
}

all="$shell_pid $helpers"
# macOS ships bash 3.2 (no associative arrays): the first reads go in a list.
before=""
for p in $all; do before="$before $p=$(cpu_seconds "$p")"; done
first() { for kv in $before; do [ "${kv%%=*}" = "$1" ] && { echo "${kv#*=}"; return; }; done; }
sleep "$secs"
total=0
report() { # label pid
  local b a
  b="$(first "$2")"; a="$(cpu_seconds "$2")"
  if [ -z "$b" ] || [ -z "$a" ]; then printf "%-16s pid %-7s not measured\n" "$1" "$2"; return; fi
  printf "%-16s pid %-7s %6.1f%% of a core\n" "$1" "$2" "$(echo "($a - $b) * 100 / $secs" | bc -l)"
}
if [ -n "$pane_pid" ]; then report "pane WebContent" "$pane_pid"; else echo "pane WebContent  not found for store $uuid"; fi
if [ -n "$gpu_pid" ]; then report "GPU" "$gpu_pid"; fi
report "shell" "$shell_pid"
for p in $all; do
  a="$(cpu_seconds "$p")"; b="$(first "$p")"
  if [ -n "$a" ] && [ -n "$b" ]; then total="$(echo "$total + $a - $b" | bc -l)"; fi
done
printf "%-16s             %6.1f%% of a core\n" "Topics total" "$(echo "$total * 100 / $secs" | bc -l)"
