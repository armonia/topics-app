#!/usr/bin/env python3
# Riassume i CSV di run.sh: per fase picco e mediana del footprint, pressione massima,
# crescita dello swap, durata. Uso: summary.py <cartella>
import csv, json, os, statistics, sys

d = sys.argv[1]
print(f"{'fase':8} {'durata':>7} {'fp med MB':>10} {'fp max MB':>10} {'press max':>9} {'swap Δ MB':>10} {'load max':>8}")
for name in ("idle-1", "cloud", "idle-2", "local"):
    p = os.path.join(d, name + ".csv")
    if not os.path.exists(p):
        continue
    rows = list(csv.DictReader(open(p)))
    if not rows:
        continue
    fp = [float(r["footprint_mb"]) for r in rows]
    sw = [float(r["swap_used_mb"]) for r in rows]
    print(f"{name:8} {rows[-1]['t']:>6}s {statistics.median(fp):>10.0f} {max(fp):>10.0f} "
          f"{max(int(r['pressure']) for r in rows):>9} {sw[-1] - sw[0]:>+10.0f} {max(float(r['load1']) for r in rows):>8.1f}")
for m in ("cloud", "local"):
    p = os.path.join(d, f"{m}-results.json")
    if os.path.exists(p):
        r = json.load(open(p))
        print(m, "esiti:", [x["outcome"] for x in r], "durata media s:", round(sum(x["ms"] for x in r) / len(r) / 1000))
