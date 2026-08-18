#!/bin/bash
# ─── Il cancello del hot-reload: l'albero sta in piedi? ─────────────────────
#
# Il watcher di start-prod.sh riavvia il server appena UN file sotto server/
# cambia. Una modifica fatta di più file — l'import prima, il modulo dopo — è
# quasi sempre incoerente per qualche secondo, e in quella finestra il watcher
# fa ripartire il server su un albero a metà. Due esiti, entrambi visti sul
# campo:
#
#   • il modulo non esiste ancora → il server non parte più e il loop di
#     riavvio gira a vuoto (19 giri di «Cannot find module ./inline-sent-state
#     from server/context/adapt.ts» il 3 agosto): app giù, ogni sessione persa;
#   • il modulo esiste ma non esporta ancora quel nome → il server PARTE, e la
#     rottura salta fuori solo quando qualcuno passa di lì. È così che
#     `createHumanWaitLedger is not defined` ha ucciso un turno vivo su
#     topic:ed2070df alle 22:26 del 3 agosto: messaggio dell'utente salvato,
#     nessuna risposta, e a schermo il cartello «No response received» che dà
#     la colpa al servizio AI.
#
# Il cancello: prima di segare il server che sta lavorando, prova a risolvere
# tutto il grafo dei moduli NOSTRI. Passa? Si ricarica. Non passa? Il server
# vecchio resta su — è di sicuro migliore di uno che non parte — e il prossimo
# salvataggio riproverà.
#
# `--packages=external` tiene fuori node_modules: lì dentro playwright importa
# `electron` e `chromium-bidi`, che non installiamo, e un cancello che fallisce
# sempre è un cancello aperto. Il costo del giro è ~30ms su 293 moduli.
#
# ─── Cancello migration SQL (2026-08-17) ────────────────────────────────────
#
# Il bun build prova l'albero JS, ma le migration SQL non passano di lì:
# server/db.ts le applica all'avvio, e una .sql con un errore di sintassi fa
# morire il boot. Salvare un file sotto server/db/migrations/ lo applica al DB
# vivo in pochi secondi, e la finestra fra «salvo» e «me ne accorgo» è il danno.
#
# Misurato il 17/08: 506 boot falliti in 10 minuti e 38 secondi (01:00:48 →
# 01:11:26), un tentativo al secondo, senza nessun freno.
#
# Soluzione: se sotto server/db/migrations/ ci sono file non ancora in
# schema_migrations del DB VIVO, si tenta di applicarli su una COPIA temporanea
# del DB. Se sqlite3 restituisce un errore, si salta il giro: la migration rotta
# non arriva al DB vivo, e il server vecchio resta su.
#
# Uso:  server-reload-gate.sh [APP_DIR]
# Esce 0 se l'albero compila e le migration pending sono valide, 1 altrimenti
# (e stampa il perché, corto).
set -uo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

if [ ! -x "$BUN" ] && ! command -v "$BUN" >/dev/null 2>&1; then
  # Senza bun non possiamo giudicare: non è un motivo per bloccare il reload,
  # che senza bun non partirebbe comunque. Lascia passare e non mentire.
  echo "[reload-gate] bun non trovato — cancello disattivato" >&2
  exit 0
fi

if out=$("$BUN" build "$APP_DIR/server.ts" --target=bun --packages=external --outfile=/dev/null 2>&1); then
  : # albero JS ok
else
  # Solo le prime righe: l'errore vero è in cima, il resto è la cascata.
  echo "$out" | sed -e 's/\x1b\[[0-9;]*m//g' | grep -E "^(error|warn)" | head -n 3
  exit 1
fi

# ─── Cancello migration SQL ──────────────────────────────────────────────────
#
# Solo se sqlite3 è disponibile: senza di lui non possiamo leggere il registro.
# Il cancello rimane aperto (exit 0) — meglio un reload di un blocco perpetuo.
SQLITE3="$(command -v sqlite3 2>/dev/null)"
if [ -z "$SQLITE3" ]; then
  exit 0
fi

MIGRATIONS_DIR="$APP_DIR/server/db/migrations"
if [ ! -d "$MIGRATIONS_DIR" ]; then
  # Nessuna cartella migration su disco (binary sidecar): niente da fare.
  exit 0
fi

# Il DB vivo: cerchiamo DATA_DIR nell'ambiente, poi il default.
DATA_DIR="${DATA_DIR:-${TOPICS_DATA_DIR:-}}"
if [ -z "$DATA_DIR" ]; then
  # Default dell'app: ~/.openclaw/data/topics.db (APP_DATA_DIR se impostato)
  _APP_DATA="${APP_DATA_DIR:-$HOME/.openclaw}"
  DATA_DIR="$_APP_DATA/data"
fi
DB_PATH="$DATA_DIR/topics.db"

if [ ! -f "$DB_PATH" ]; then
  # DB non ancora creato (primo avvio): nessuna migration è "pending"
  # rispetto al registro, quindi niente da controllare.
  exit 0
fi

# Le migration già applicate sul DB vivo.
APPLIED=$("$SQLITE3" "$DB_PATH" \
  "SELECT name FROM schema_migrations;" 2>/dev/null) || {
  # schema_migrations non esiste ancora (DB ante-tracciamento): lasciamo passare.
  exit 0
}

# Trova i file .sql nella cartella che non sono nel registro.
PENDING=()
while IFS= read -r -d '' sql_file; do
  fname="$(basename "$sql_file")"
  # pattern atteso: NNN-slug.sql oppure timestamp-slug.sql
  if ! echo "$APPLIED" | grep -qxF "$fname"; then
    PENDING+=("$sql_file")
  fi
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -print0 | sort -z)

if [ "${#PENDING[@]}" -eq 0 ]; then
  # Nessuna migration pending: ok.
  exit 0
fi

# Copia il DB in una directory temporanea e prova ad applicare le pending.
# La copia include il WAL (se esiste) così il checkpoint è già dentro.
TMP_DIR="$(mktemp -d)"
TMP_DB="$TMP_DIR/probe.db"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$DB_PATH" "$TMP_DB" 2>/dev/null || {
  echo "[reload-gate] impossibile copiare il DB — cancello migration disattivato" >&2
  exit 0
}
[ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "${TMP_DB}-wal" 2>/dev/null || true
[ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "${TMP_DB}-shm" 2>/dev/null || true

for sql_file in "${PENDING[@]}"; do
  fname="$(basename "$sql_file")"
  if ! mig_out=$("$SQLITE3" "$TMP_DB" < "$sql_file" 2>&1); then
    echo "[reload-gate] migration pending '$fname' fallisce sulla copia del DB:"
    echo "$mig_out" | head -n 5
    echo "[reload-gate] il server vecchio resta su — correggi la migration e risalva"
    exit 1
  fi
done

exit 0
