#!/usr/bin/env bash
# monitor-woken-live.sh — la prova DAL VIVO che la risposta di un `Monitor`
# arriva in chat.
#
# ── Perche' esiste, e perche' non e' un test ───────────────────────────────
# Il risveglio del Monitor (`server/providers/claude/woken-turn.ts`) e' coperto
# da tre livelli di test: la regola pura, il contratto del provider, e
# un'integrazione che guida `POST /api/chat` e rilegge la riga dal DB vero.
# Tutti e tre erano VERDI mentre la sveglia, in produzione, non era collegata:
# `adottaTurniRisvegliati` chiedeva il provider a boot time e non lo trovava,
# perche' `initProvider` registra claude-code piu' tardi, in fire-and-forget.
# I test guidano il provider direttamente e quel cablaggio non lo attraversano.
#
# Questo script attraversa TUTTO: server vero, CLI vera e autenticata, Monitor
# vero, e la domanda che conta — «non scrivo piu' niente: la risposta arriva?».
# Non e' automatizzabile nella suite perche' pretende un account Claude attivo
# e ~2 minuti di attesa reale; e' l'attrezzo da lanciare a mano quando si tocca
# la catena del risveglio.
#
#   bun run scripts/monitor-woken-live.sh     # oppure: bash scripts/…
#
# ── Isolamento ────────────────────────────────────────────────────────────
# Porta, DATA_DIR e socket dedicati: non tocca il DB dell'app dell'utente ne'
# i suoi bridge. HOME invece resta quello VERO, ed e' deliberato: e' l'unico
# modo perche' la CLI sia autenticata, che e' il pezzo che i test non possono
# simulare. Il DB di prova viene ricreato a ogni corsa.
set -uo pipefail

PORT="${WOKEN_PORT:-13399}"
OUT="${WOKEN_OUT:-${TMPDIR:-/tmp}/topics-woken-live}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SENTINELLA="RISVEGLIO-VIVO-$RANDOM"
DATA="$OUT/data"

mkdir -p "$DATA"
cd "$REPO_ROOT"

BUN_PORT=$PORT \
DATA_DIR="$DATA" \
TOPICS_HOME="$DATA/.topics-home" \
TOPICS_PTY_SOCKET="/tmp/topics-pty-woken-$PORT.sock" \
TOPICS_AI_BRIDGE_SOCKET="/tmp/topics-ai-woken-$PORT.sock" \
TOPICS_AI_BRIDGE=0 \
  bun run server.ts > "$OUT/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null' EXIT

# `-k`: il server monta un certificato di sviluppo.
for _ in $(seq 1 90); do
  curl -skf "https://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
echo "== server su :$PORT (pid $SRV), log in $OUT/server.log"

TOPIC=$(curl -skf -X POST "https://127.0.0.1:$PORT/api/topics" \
  -H 'content-type: application/json' \
  -d '{"name":"prova monitor","provider":"claude-code"}')
SK=$(echo "$TOPIC" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sessionKey",""))' 2>/dev/null)
if [ -z "$SK" ]; then echo "NIENTE SESSIONKEY, il server non e' partito: $TOPIC"; exit 1; fi
echo "== sessionKey=$SK  sentinella=$SENTINELLA"

echo "== turno 1: armo il Monitor"
curl -skN --max-time 300 -X POST "https://127.0.0.1:$PORT/api/chat" \
  -H 'content-type: application/json' \
  -d "{\"sessionKey\":\"$SK\",\"provider\":\"claude-code\",\"messages\":[{\"role\":\"user\",\"content\":\"Arma un Monitor sul comando 'sleep 20; echo $SENTINELLA' con description 'prova risveglio'. Poi rispondi solo 'armato' e fermati: non aspettare, non lanciare altri tool.\"}]}" \
  > "$OUT/turn1.sse" 2>&1
echo "== turno 1 chiuso — da qui in poi NESSUNO scrive piu' niente"

# La sentinella sta anche nel PROMPT UTENTE: cercarla nel JSON intero e' un
# falso positivo garantito. Si guarda solo nelle righe `assistant` — ed e' un
# errore gia' commesso: la prima versione usciva a 5s, prima che il Monitor
# (sleep 20) scattasse, e uccideva il server portandosi via cio' che misurava.
trovata() {
  curl -skf "https://127.0.0.1:$PORT/api/history/$SK" > "$OUT/hist.json" 2>/dev/null || return 1
  python3 -c "
import json,sys
try: d=json.load(open('$OUT/hist.json'))
except Exception: sys.exit(1)
msgs=d if isinstance(d,list) else d.get('messages',[])
sys.exit(0 if any(m.get('role')=='assistant' and '$SENTINELLA' in (m.get('content') or '') for m in msgs) else 1)
" 2>/dev/null
}

echo "== aspetto il risveglio (max 120s), in silenzio"
for i in $(seq 1 24); do
  sleep 5
  if trovata; then echo "== arrivato dopo ~$((i*5))s"; break; fi
done

python3 - "$OUT/hist.json" "$SENTINELLA" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("   cronologia illeggibile:",e); raise SystemExit(1)
msgs=d if isinstance(d,list) else d.get("messages",[])
print(f"== righe in chat: {len(msgs)}")
for m in msgs: print("   ", m.get("role"), repr((m.get("content") or "")[:150]))
ok=any(m.get("role")=="assistant" and sys.argv[2] in (m.get("content") or "") for m in msgs)
print("\n== VERDETTO:", "la risposta del Monitor E' ARRIVATA IN CHAT" if ok
      else "NON e' arrivata — guarda le righe [woken] qui sotto")
raise SystemExit(0 if ok else 1)
PY
ESITO=$?

echo "== righe [woken] nel log:"
grep -n "\[woken\]" "$OUT/server.log" | head -10 || echo "   nessuna: la sveglia non e' scattata"
exit $ESITO
