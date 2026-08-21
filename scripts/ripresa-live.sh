#!/usr/bin/env bash
# ripresa-live.sh — la prova DAL VIVO che un turno ucciso dal riavvio del
# server torna DA SOLO.
#
# ── Perche' esiste, e perche' non e' un test ───────────────────────────────
# La regola di chi merita la ripresa (`lib/ripresa-boot.ts`) e' pura e provata.
# Il giro che la applica tocca il DB e manda turni veri, e i suoi due estremi —
# un server che muore sotto una risposta, e un altro che nasce e la riprende —
# non stanno dentro un test: vogliono due processi, una CLI autenticata, e il
# tempo reale fra i due.
#
# E' esattamente il buco da cui e' passato il guasto del 20/08 su topic:9f9e9629
# con tutti i test verdi. Quindi questa prova attraversa TUTTO: server vero,
# modello vero, SIGTERM vero, e la domanda che conta — «non tocco niente: la
# risposta torna?».
#
#   bash scripts/ripresa-live.sh
#
# ── Isolamento ────────────────────────────────────────────────────────────
# Porta, DATA_DIR e socket dedicati: non tocca il DB dell'utente. HOME resta
# quello VERO, ed e' deliberato: e' l'unico modo perche' la CLI sia autenticata.
set -uo pipefail

PORT="${RIPRESA_PORT:-13401}"
# NON in $TMPDIR: su macOS quella directory non regge il locking di SQLite
# (`SQLITE_IOERR_VNODE`) e il server nasce senza poter leggere le topic — cioe'
# vivo e inutile, che e' il modo peggiore di fallire una prova.
OUT="${RIPRESA_OUT:-$HOME/.topics/prove/ripresa-live}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SENTINELLA="RIPRESA-VIVA-$RANDOM"
DATA="$OUT/data"

rm -rf "$OUT"; mkdir -p "$DATA"
cd "$REPO_ROOT"

avvia_server() {
  BUN_PORT=$PORT \
  DATA_DIR="$DATA" \
  TOPICS_HOME="$DATA/.topics-home" \
  TOPICS_PTY_SOCKET="/tmp/topics-pty-ripresa-$PORT.sock" \
  TOPICS_AI_BRIDGE_SOCKET="/tmp/topics-ai-ripresa-$PORT.sock" \
  TOPICS_AI_BRIDGE=0 \
    bun run server.ts >> "$1" 2>&1 &
  echo $!
}
attendi_server() {
  for _ in $(seq 1 90); do
    curl -skf "https://127.0.0.1:$PORT/api/topics" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

SRV=$(avvia_server "$OUT/server1.log")
SRV2=""
trap 'kill $SRV ${SRV2:-} 2>/dev/null' EXIT
attendi_server || { echo "il server non e' partito"; exit 1; }
echo "== server #1 su :$PORT (pid $SRV)"

# Provider `topics`: e' il runtime NATIVO, quello che NON sopravvive al riavvio.
# Su claude-code il turno vive in un figlio e viene riadottato: sarebbe un'altra
# prova, non questa.
TOPIC=$(curl -skf -X POST "https://127.0.0.1:$PORT/api/topics" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"prova ripresa\",\"provider\":\"topics\",\"projectPath\":\"$REPO_ROOT\"}")
SK=$(echo "$TOPIC" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sessionKey",""))' 2>/dev/null)
[ -z "$SK" ] && { echo "NIENTE SESSIONKEY: $TOPIC"; exit 1; }
echo "== sessionKey=$SK  sentinella=$SENTINELLA"

# Un turno che scrive prosa PRIMA di un tool lungo: e' la forma del guasto —
# `turnIsOnlyError` non mostrerebbe «Riprova», quindi senza ripresa automatica
# questa chat resterebbe ferma per sempre.
echo "== mando il messaggio, poi uccido il server mentre risponde"
curl -skN --max-time 120 -X POST "https://127.0.0.1:$PORT/api/chat" \
  -H 'content-type: application/json' \
  -d "{\"sessionKey\":\"$SK\",\"provider\":\"topics\",\"messages\":[{\"role\":\"user\",\"content\":\"Di' che stai per misurare, poi lancia con bash 'sleep 40; echo $SENTINELLA' e riporta cosa stampa. Rispondi in una riga.\"}]}" \
  > "$OUT/turno1.sse" 2>&1 &
CURL=$!

# Si aspetta che il turno sia DAVVERO in volo: uccidere prima che parta
# proverebbe un'altra cosa (e la ripresa non avrebbe niente da riprendere).
# Si aspetta il TOOL, non un evento qualunque: uccidere prima che il tool parta
# lascia un turno che finisce da solo in pochi secondi, e la prova misura una
# cosa diversa da quella che dice. Successo il 20/08: SIGTERM a 5s, turno
# completo, zero riprese, e la prova che accusava la ripresa.
VISTO_TOOL=0
for _ in $(seq 1 60); do
  sleep 1
  # Il nome nel flusso e' `tool_calls` con dentro il comando: si aspetta che
  # gli ARGOMENTI siano arrivati, cioe' che il comando sia partito davvero.
  if grep -q 'sleep 40' "$OUT/turno1.sse" 2>/dev/null; then VISTO_TOOL=1; break; fi
done
[ "$VISTO_TOOL" = 1 ] || { echo "il turno non ha mai lanciato il tool: la prova non e' valida"; exit 1; }
# Un attimo perche' il tool sia DAVVERO in corso (il suo `sleep 40` regge).
sleep 3
echo "== il turno sta lavorando: SIGTERM (come fswatch su un salvataggio)"
kill -TERM $SRV 2>/dev/null
kill $CURL 2>/dev/null
# `wait` NON serve qui: il pid nasce dentro una `$( )`, quindi e' figlio di
# quella subshell e non di questa — `wait` torna subito con un errore, e il
# server #2 partiva mentre il #1 stava ancora spegnendosi. Risultato: «Another
# Topics server is already running», il #2 moriva sul lock, e la prova
# accusava la ripresa di non aver fatto niente. Si aspetta il pid, per davvero.
for _ in $(seq 1 30); do
  kill -0 $SRV 2>/dev/null || break
  sleep 1
done
kill -0 $SRV 2>/dev/null && { echo "il server #1 non e' uscito"; exit 1; }
echo "== server #1 uscito"

echo "== server #2: nasce e dovrebbe riprendere DA SOLO"
SRV2=$(avvia_server "$OUT/server2.log")
attendi_server || { echo "il server #2 non e' partito"; exit 1; }

echo "== aspetto la risposta ripresa (max 150s), senza toccare niente"
for i in $(seq 1 30); do
  sleep 5
  curl -skf "https://127.0.0.1:$PORT/api/history/$SK" > "$OUT/hist.json" 2>/dev/null || continue
  python3 -c "
import json,sys
d=json.load(open('$OUT/hist.json'))
m=d if isinstance(d,list) else d.get('messages',[])
sys.exit(0 if any(x.get('role')=='assistant' and '$SENTINELLA' in (x.get('content') or '') for x in m) else 1)
" 2>/dev/null && { echo "== risposta arrivata dopo ~$((i*5))s dal riavvio"; break; }
done

python3 - "$OUT/hist.json" "$SENTINELLA" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
msgs=d if isinstance(d,list) else d.get("messages",[])
print(f"== righe in chat: {len(msgs)}")
for m in msgs:
    kinds=",".join(b.get("kind","?") for b in (m.get("blocks") or []))
    print("   ", m.get("role"), repr((m.get("content") or "")[:90]), f"[{kinds}]")
blocchi=[(m.get("role"), [b.get("kind") for b in (m.get("blocks") or [])]) for m in msgs]
# La TRACCIA sul turno morto (mai due riprese) e il CARTELLO sul turno nuovo
# (chi legge deve sapere da dove viene) sono due cose diverse: si pretendono
# entrambe, perche' e' possibile avere l'una senza l'altra.
traccia=any("ripreso" in k for r,k in blocchi if "error" in k)
cartello=any("ripreso" in k for r,k in blocchi if "error" not in k)
ripreso=traccia and cartello
verdetto=any(b.get("kind")=="error" for m in msgs for b in (m.get("blocks") or []))
risposta=any(m.get("role")=="assistant" and sys.argv[2] in (m.get("content") or "") for m in msgs)
print("\n== il turno ucciso PORTA il verdetto:", "si'" if verdetto else "NO")
print("== il turno ucciso porta la TRACCIA (mai due riprese):", "si'" if traccia else "NO")
print("== il turno nuovo porta il CARTELLO della ripresa:", "si'" if cartello else "NO")
print("== la risposta e' TORNATA da sola:", "si'" if risposta else "NO")
raise SystemExit(0 if (verdetto and ripreso and risposta) else 1)
PY
ESITO=$?
echo "== righe [ripresa] nel log del server #2:"
grep -n "\[ripresa\]" "$OUT/server2.log" | head -5 || echo "   nessuna"
exit $ESITO
