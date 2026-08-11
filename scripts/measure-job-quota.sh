#!/usr/bin/env bash
# Misura il PREZZO della recinzione: la stessa build da zero, una volta libera
# (cargo prende tutti i core) e una volta con la quota che lo spawn passa a un
# agent dispatchato (CARGO_BUILD_JOBS/MAKEFLAGS).
#
# INTERLACCIATA E RIPETUTA, e non è pignoleria: la prima versione girava una
# corsa per configurazione, e su questo host — che dispaccia agenti mentre
# misura — le due corse si sono contraddette (‑j2 uscito PIÙ VELOCE di ‑j3).
# Non era la quota, era il carico di fondo che cambiava sotto la misura. Con le
# configurazioni alternate a giro (A B C A B C …) la deriva lenta colpisce
# tutte allo stesso modo, e si legge la MEDIANA per giro, non una corsa sola.
#
# Ogni corsa parte da una target dir vergine (build davvero da zero) e la
# cancella subito dopo, così la corsa seguente non paga l'I/O della precedente.
# Il carico viene stampato prima e dopo: un tempo senza il suo carico, su una
# macchina come questa, non si può rileggere.
#
# Uso: scripts/measure-job-quota.sh "<job...>" [giri] [dir-crate]
#      job = numero di job, oppure 0 per «libera» (cargo decide, cioè tutti i core)
# Es.: scripts/measure-job-quota.sh "0 3 2" 3
set -u

LEGS="${1:-0 3}"
ROUNDS="${2:-1}"
CRATE="${3:-$(cd "$(dirname "$0")/.." && pwd)/desktop-tauri/src-tauri}"
OUT="${OUT:-/tmp/job-quota-measure}"
mkdir -p "$OUT"

cores="$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)"
echo "crate=$CRATE cores=$cores legs=[$LEGS] giri=$ROUNDS"

# I sidecar (server, pty-bridge, webrtc-bridge) NON li compila cargo: sono
# risorse `externalBin`, e `tauri-build` ne verifica solo l'ESISTENZA. In un
# worktree fresco non ci sono, e ogni corsa moriva con rc=101 dopo aver
# compilato tutte le dipendenze — un tempo che sembrava una misura e non lo era.
# Si stubbano come fa la CI (ci.yml, «Stub sidecar binaries»): la misura resta
# quella della compilazione Rust, che è ciò che `-j` governa.
triple="$(rustc -vV | sed -n 's/host: //p')"
mkdir -p "$CRATE/binaries"
for s in topics-server pty-bridge webrtc-bridge; do
  [ -e "$CRATE/binaries/$s-$triple" ] || { touch "$CRATE/binaries/$s-$triple"; echo "stub: binaries/$s-$triple"; }
done

run() {
  local jobs="$1" giro="$2"
  local etichetta; [ "$jobs" = "0" ] && etichetta="libera" || etichetta="j$jobs"
  local target="$OUT/target-corrente"
  rm -rf "$target"; mkdir -p "$target"
  local prima dopo t0 t1 rc
  prima="$(uptime | sed 's/.*averages: //' | awk '{print $1}')"
  t0=$(date +%s)
  if [ "$jobs" = "0" ]; then
    ( cd "$CRATE" && env CARGO_TARGET_DIR="$target" CARGO_TERM_PROGRESS_WHEN=never cargo build ) \
      >"$OUT/$etichetta-$giro.log" 2>&1
  else
    ( cd "$CRATE" && env CARGO_TARGET_DIR="$target" CARGO_TERM_PROGRESS_WHEN=never \
        CARGO_BUILD_JOBS="$jobs" MAKEFLAGS="-j$jobs" cargo build ) \
      >"$OUT/$etichetta-$giro.log" 2>&1
  fi
  rc=$?
  t1=$(date +%s)
  dopo="$(uptime | sed 's/.*averages: //' | awk '{print $1}')"
  rm -rf "$target"
  # Il risultato si SCRIVE prima di stamparlo. La versione precedente faceva il
  # contrario e ci ha rimesso una corsa intera: in `echo "... $prima→$dopo"` bash
  # inghiotte i byte di `→` dentro il nome della variabile, e con `set -u` la
  # riga muore — dopo dieci minuti di build, senza lasciarne traccia. Le graffe
  # separano il nome dal carattere che segue.
  echo "$giro $etichetta $((t1 - t0)) $prima $dopo $rc" >>"$OUT/results.txt"
  echo "giro $giro · $etichetta · wall=$((t1 - t0))s · load ${prima} -> ${dopo} · rc=$rc"
}

: >"$OUT/results.txt"
for giro in $(seq 1 "$ROUNDS"); do
  for jobs in $LEGS; do run "$jobs" "$giro"; done
done
echo "=== fine ==="
cat "$OUT/results.txt"

# Una corsa che ESCE NON-ZERO non è una misura, è una build rotta col
# cronometro attaccato: la prima versione ne ha prodotte due (sidecar mancanti,
# rc=101) e i loro tempi si leggevano come se fossero buoni. Qui si dice forte.
falliti="$(awk '$6 != 0' "$OUT/results.txt" | wc -l | tr -d ' ')"
if [ "$falliti" != "0" ]; then
  echo "!!! $falliti corse USCITE NON-ZERO: non sono misure. Vedi i .log in $OUT"
  awk '$6 != 0 {print "    rotta: giro " $1 " " $2 " rc=" $6}' "$OUT/results.txt"
fi

# La MEDIANA per configurazione, sulle sole corse buone: con il carico di fondo
# che si muove sotto la misura, una corsa sola non decide niente.
echo "=== mediane (solo corse rc=0) ==="
awk '$6 == 0 {t[$2] = t[$2] " " $3} END {
  for (k in t) {
    n = split(t[k], v, " ");
    for (i = 1; i < n; i++) for (j = i + 1; j <= n; j++) if (v[i] + 0 > v[j] + 0) { tmp = v[i]; v[i] = v[j]; v[j] = tmp }
    mediana = (n % 2) ? v[(n + 1) / 2] : int((v[n / 2] + v[n / 2 + 1]) / 2);
    printf "%-8s n=%d  mediana=%ss  (%s)\n", k, n, mediana, t[k];
  }
}' "$OUT/results.txt"
