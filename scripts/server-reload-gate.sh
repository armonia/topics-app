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
# Uso:  server-reload-gate.sh [APP_DIR]
# Esce 0 se l'albero compila, 1 altrimenti (e stampa il perché, corto).
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
  exit 0
fi

# Solo le prime righe: l'errore vero è in cima, il resto è la cascata.
echo "$out" | sed -e 's/\x1b\[[0-9;]*m//g' | grep -E "^(error|warn)" | head -n 3
exit 1
