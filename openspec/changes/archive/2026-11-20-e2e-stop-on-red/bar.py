#!/usr/bin/env python3
"""The bar of e2e-stop-on-red, measured on real CI runs through `gh api`.

    python3 openspec/changes/e2e-stop-on-red/bar.py stop  <run_id>
    python3 openspec/changes/e2e-stop-on-red/bar.py green <run_id> [baseline_runs]

stop:  exit 0 when the run concluded `failure` (never `cancelled`), unit or
       gates of its latest attempt is red, and every `e2e (N)` shard concluded
       `failure` at most 120 s after the first red (or after its own start,
       for a shard that started after the red). A run where the shards ran to
       the end exits 1: that is what the mutant run must do.
green: exit 0 when the run concluded `success` and its shards took as long as
       on the green pull request runs before it: median shard at most 10% over
       the baseline median, slowest shard at most the baseline p90. Durations
       are started -> completed, so the queue (p90 16.7 min) is not measured.
"""
import json
import statistics
import subprocess
import sys
from datetime import datetime

REPO = "armonia/topics-app"
LIMIT_S = 120


def api(path):
    out = subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").timestamp()


def jobs_of(run_id):
    return api(f"repos/{REPO}/actions/runs/{run_id}/jobs?per_page=100")["jobs"]


def shards(jobs):
    return [j for j in jobs if j["name"].startswith("e2e (")]


def stop(run_id):
    run = api(f"repos/{REPO}/actions/runs/{run_id}")
    jobs = jobs_of(run_id)
    print(f"run {run_id} ({run['html_url']}): {run['status']} / {run['conclusion']}, attempt {run['run_attempt']}")
    ok = run["conclusion"] == "failure"
    reds = [j for j in jobs if j["name"] in ("unit", "gates") and j["conclusion"] == "failure"]
    if not reds:
        print("FAIL no red unit or gates job in this run")
        return 1
    t_red = min(ts(j["completed_at"]) for j in reds)
    for j in reds:
        print(f"  red  {j['name']:8} completed {j['completed_at']}")
    for j in sorted(shards(jobs), key=lambda j: j["name"]):
        if not j["completed_at"]:
            print(f"  FAIL {j['name']} not completed")
            ok = False
            continue
        start, end = ts(j["started_at"]), ts(j["completed_at"])
        ran = (end - start) / 60
        if end <= t_red:
            # Nothing to stop: the shard (usually e2e (0), the touched specs) was done first.
            print(f"  ok   {j['name']:8} {j['conclusion']}, ended {t_red - end:.0f} s BEFORE the red, ran {ran:.1f} min")
            continue
        late = end - max(t_red, start)
        notes = [a["message"] for a in api(f"repos/{REPO}/check-runs/{j['id']}/annotations")]
        said = any(m.startswith("fermato:") for m in notes)
        good = j["conclusion"] == "failure" and late <= LIMIT_S and said
        ok = ok and good
        print(f"  {'ok  ' if good else 'FAIL'} {j['name']:8} {j['conclusion']}, ended {late:+.0f} s after the red, ran {ran:.1f} min, "
              f"{'says «fermato»' if said else 'no «fermato» annotation'}")
    if run["conclusion"] != "failure":
        print(f"FAIL run conclusion is {run['conclusion']}, not failure")
    print("BAR GREEN: every shard stopped within 120 s of the red" if ok else "BAR RED")
    return 0 if ok else 1


def durations(jobs):
    return [(ts(j["completed_at"]) - ts(j["started_at"])) / 60 for j in shards(jobs) if j["completed_at"]]


def green(run_id, n):
    run = api(f"repos/{REPO}/actions/runs/{run_id}")
    jobs = jobs_of(run_id)
    mine = durations(jobs)
    listed = api(f"repos/{REPO}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=100")["workflow_runs"]
    before = [r for r in listed if ts(r["created_at"]) < ts(run["created_at"]) and r["id"] != run["id"]][:n]
    base_med, base_max, base_wall = [], [], []
    for r in before:
        d = durations(jobs_of(r["id"]))
        if len(d) < 8:
            continue
        base_med.append(statistics.median(d))
        base_max.append(max(d))
        base_wall.append((ts(r["updated_at"]) - ts(r["run_started_at"])) / 60)
    q = lambda a, p: sorted(a)[int(p * (len(a) - 1))]
    wall = (ts(run["updated_at"]) - ts(run["run_started_at"])) / 60
    print(f"run {run_id} ({run['html_url']}): {run['conclusion']}, {len(mine)} shards")
    print(f"  this run   median shard {statistics.median(mine):5.1f} min, slowest {max(mine):5.1f} min, wall {wall:5.1f} min (queue included)")
    print(f"  baseline   median shard {statistics.median(base_med):5.1f} min, slowest {statistics.median(base_max):5.1f} min (p90 {q(base_max, .9):.1f}), wall {statistics.median(base_wall):5.1f} min, over {len(base_med)} green PR runs")
    ok = (run["conclusion"] == "success"
          and statistics.median(mine) <= statistics.median(base_med) * 1.10
          and max(mine) <= q(base_max, .9))
    print("BAR GREEN: shards as long as before" if ok else "BAR RED")
    return 0 if ok else 1


if __name__ == "__main__":
    mode, run_id = sys.argv[1], sys.argv[2]
    sys.exit(stop(run_id) if mode == "stop" else green(run_id, int(sys.argv[3]) if len(sys.argv) > 3 else 20))
