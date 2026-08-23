#!/usr/bin/env bash
# Punta la Rich Presence di Topics a un'applicazione Discord diversa.
#
# PERCHE' ESISTE: il nome che Discord mostra sul profilo ("sta giocando a ...")
# e' il nome dell'APPLICAZIONE registrata con quel Client ID, non qualcosa che
# il nostro codice possa scegliere. Oggi Topics usa l'app 1467514747988611174,
# che si chiama «Jarvis» ed e' la stessa del bot: rinominarla farebbe comparire
# «Topics» sul profilo ma cambierebbe il nome del bot ovunque.
#
# La via pulita e' una SECONDA applicazione, chiamata «Topics», usata solo per
# la presence. Crearla richiede l'account umano (i token bot ricevono 403 su
# POST /applications, verificato), quindi quel passo resta manuale:
#
#   1. https://discord.com/developers/applications  →  New Application
#   2. nome: Topics
#   3. copia l'APPLICATION ID
#   4. lancia questo script con quell'id
#
# Da li' in poi fa tutto lui: scrive la variabile nel LaunchAgent del server,
# lo riavvia e verifica che Discord risponda col nome giusto.
#
#   ./set-discord-app.sh <APPLICATION_ID>
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.armonia.topics-server.plist"
LABEL="com.armonia.topics-server"
API="https://127.0.0.1:3333"

ID="${1:-}"
if [[ -z "$ID" ]]; then
  echo "uso: $0 <APPLICATION_ID>" >&2
  echo "     l'id si prende da https://discord.com/developers/applications" >&2
  exit 64
fi
if [[ ! "$ID" =~ ^[0-9]{17,20}$ ]]; then
  echo "non sembra un Application ID Discord (attesi 17-20 numeri): $ID" >&2
  exit 64
fi

# Che nome ha davvero quell'app? Meglio scoprirlo adesso che dopo il riavvio.
NAME=$(curl -s -m 8 "https://discord.com/api/v10/applications/$ID/rpc" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name",""))' 2>/dev/null || true)
# Niente `?` come sentinella: dentro [[ == ]] e' un glob (un carattere
# qualsiasi), non un letterale, e il confronto fa cose che non sembra fare.
if [[ -z "$NAME" ]]; then
  echo "Discord non riconosce l'applicazione $ID." >&2
  echo "Controlla di aver copiato l'Application ID e non il Client Secret." >&2
  exit 1
fi
echo "L'applicazione $ID si chiama: «${NAME}»"
echo "E' questo il nome che comparira' sul profilo Discord."
# `&&` in coda con set -e: se la condizione e' falsa l'intera riga vale 1 e lo
# script muore in silenzio, senza stampare niente. Con `if` il messaggio esce.
if [[ "$NAME" == "Jarvis" ]]; then
  echo >&2
  echo "Questa e' proprio l'applicazione che stai cercando di NON usare." >&2
  echo "Serve un'app nuova: https://discord.com/developers/applications → New Application." >&2
  exit 1
fi

[[ -f "$PLIST" ]] || { echo "LaunchAgent non trovato: $PLIST" >&2; exit 1; }
cp "$PLIST" "$PLIST.bak.$(date +%Y%m%d-%H%M%S)"

/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:DISCORD_CLIENT_ID string $ID" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:DISCORD_CLIENT_ID $ID" "$PLIST"
plutil -lint "$PLIST" >/dev/null

echo "Riavvio il server…"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Non basta che riparta: deve ricollegarsi a Discord e pubblicare.
for _ in $(seq 1 20); do
  sleep 3
  OUT=$(curl -sk -m 5 "$API/api/profile/discord" 2>/dev/null || true)
  [[ -z "$OUT" ]] && continue
  CONN=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["status"]["connection"])' <<<"$OUT" 2>/dev/null || echo "")
  if [[ "$CONN" == "connected" ]]; then
    echo
    echo "Fatto: la presence e' collegata come «${NAME}»."
    python3 - <<'PY' <<<"$OUT"
import json,sys
s=json.load(sys.stdin)["status"]; a=s.get("activity") or {}
print("  mostra:", a.get("details"), "|", a.get("state"))
print("  errore:", s.get("lastError") or "nessuno")
PY
    echo
    echo "Guarda il tuo profilo Discord: dovrebbe dire «${NAME}»."
    exit 0
  fi
done

echo "Il server e' ripartito ma la presence non risulta collegata." >&2
echo "Stato: ${CONN:-sconosciuto} — controlla con:" >&2
echo "  curl -sk $API/api/profile/discord | python3 -m json.tool" >&2
exit 1
