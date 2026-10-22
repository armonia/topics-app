#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "misura disponibile solo su macOS" >&2
  exit 2
fi
if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
  echo "uso: scripts/measure-webview.sh <PID-WebContent-di-Topics>" >&2
  exit 2
fi

pid="$1"
command_line="$(ps -p "$pid" -o command=)"
if [[ "$command_line" != *WebContent* ]]; then
  echo "il PID $pid non identifica un processo WebContent: $command_line" >&2
  exit 2
fi

out="${TMPDIR:-/tmp}/topics-webview-$(date +%Y%m%d-%H%M%S).csv"
printf 'timestamp,footprint_bytes,cpu_percent\n' > "$out"
echo "PID $pid · 21 campioni ogni 30s per 10m · app in background con 5 topic aperti"
echo "CSV $out"

for sample in $(seq 0 20); do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  footprint_text="$(/usr/bin/footprint --pid "$pid" --format bytes --noCategories 2>&1)" || {
    echo "footprint non leggibile al campione $sample: $footprint_text" >&2
    exit 2
  }
  footprint_bytes="$(printf '%s\n' "$footprint_text" | awk '/footprint/ { for (i=1; i<=NF; i++) if ($i ~ /^[0-9]+$/) value=$i } END { if (value != "") print value }')"
  cpu_percent="$(ps -p "$pid" -o %cpu= | tr -d ' ')"
  if [[ -z "$footprint_bytes" || -z "$cpu_percent" ]]; then
    echo "campione $sample incompleto: footprint='$footprint_text', cpu='$cpu_percent'" >&2
    exit 2
  fi
  printf '%s,%s,%s\n' "$timestamp" "$footprint_bytes" "$cpu_percent" >> "$out"
  printf '%s  footprint %s B · CPU %s%%\n' "$timestamp" "$footprint_bytes" "$cpu_percent"
  if [[ "$sample" -lt 20 ]]; then sleep 30; fi
done

awk -F, 'NR > 1 { mem += $2; cpu += $3; if (NR == 2 || $2 < min) min=$2; if (NR == 2 || $2 > max) max=$2; n++ } END { printf "media footprint %.1f MB · min %.1f MB · max %.1f MB · CPU media %.2f%% · campioni %d\n", mem/n/1048576, min/1048576, max/1048576, cpu/n, n }' "$out"
awk -F, 'NR > 1 { if (NR == 2 || $2 > max) max=$2; cpu += $3; n++ } END { if (max/1048576 > 600 || cpu/n > 2) { printf "ROSSO: max %.1f MB (tetto 600) · CPU media %.2f%% (tetto 2%%)\n", max/1048576, cpu/n; exit 1 } printf "verde: max %.1f MB · CPU media %.2f%%\n", max/1048576, cpu/n }' "$out"
