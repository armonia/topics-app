#!/usr/bin/env python3
# Campiona ogni N secondi, finché il processo radice vive:
#   - phys_footprint sommato su radice e discendenti (proc_pid_rusage, veloce; non RSS)
#   - pressione di memoria del sistema (1 normale, 2 warn, 4 critico) e swap usato
# Uso: sample.py <pid-radice> <csv> [secondi]
import csv, ctypes, subprocess, sys, time

class RUsageV2(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "ri_user_time", "ri_system_time", "ri_pkg_idle_wkups", "ri_interrupt_wkups", "ri_pageins",
        "ri_wired_size", "ri_resident_size", "ri_phys_footprint", "ri_proc_start_abstime",
        "ri_proc_exit_abstime", "ri_child_user_time", "ri_child_system_time", "ri_child_pkg_idle_wkups",
        "ri_child_interrupt_wkups", "ri_child_pageins", "ri_child_elapsed_abstime", "ri_diskio_bytesread",
        "ri_diskio_byteswritten")]

libproc = ctypes.CDLL("/usr/lib/libproc.dylib")

def footprint(pid):
    buf = RUsageV2()
    return buf.ri_phys_footprint if libproc.proc_pid_rusage(pid, 2, ctypes.byref(buf)) == 0 else 0

def tree(root):
    kids = {}
    for line in subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout.splitlines():
        p, pp = map(int, line.split())
        kids.setdefault(pp, []).append(p)
    out, todo = [], [root]
    while todo:
        p = todo.pop()
        out.append(p)
        todo += kids.get(p, [])
    return out

def sysctl(name):
    return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True).stdout.strip()

def swap_used_mb():
    # «total = 8192.00M  used = 6716.56M  free = …»
    s = sysctl("vm.swapusage")
    return float(s.split("used = ")[1].split("M")[0])

root, path = int(sys.argv[1]), sys.argv[2]
step = float(sys.argv[3]) if len(sys.argv) > 3 else 3
with open(path, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["t", "procs", "footprint_mb", "pressure", "swap_used_mb", "load1"])
    t0 = time.time()
    while True:
        pids = tree(root)
        if footprint(root) == 0 and subprocess.run(["kill", "-0", str(root)], capture_output=True).returncode != 0:
            break
        fp = sum(footprint(p) for p in pids) / 2**20
        w.writerow([round(time.time() - t0, 1), len(pids), round(fp, 1), sysctl("kern.memorystatus_vm_pressure_level"),
                    round(swap_used_mb()), sysctl("vm.loadavg").split()[1]])
        f.flush()
        time.sleep(step)
