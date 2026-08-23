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
BACKUP="$PLIST.bak.$(date +%Y%m%d-%H%M%S)"
cp "$PLIST" "$BACKUP"

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
  LAST_ERR=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["status"].get("lastError") or "")' <<<"$OUT" 2>/dev/null || echo "")
  if [[ "$CONN" == "connected" ]]; then
    echo
    echo "Fatto: la presence e' collegata come «${NAME}»."
    # Due redirezioni sullo stesso stdin si annullano: con `python3 - <<'PY'`
    # SEGUITO da `<<<"$OUT"`, l'ultima vince e Python riceve il JSON al posto
    # del proprio codice. Il JSON passa come argomento, non come stdin.
    python3 -c 'import json,sys
s=json.loads(sys.argv[1])["status"]; a=s.get("activity") or {}
print("  mostra:", a.get("details"), "|", a.get("state"))
print("  errore:", s.get("lastError") or "nessuno")' "$OUT"
    echo
    echo "Guarda il tuo profilo Discord: dovrebbe dire «${NAME}»."
    exit 0
  fi
done

# Qui il lavoro NON e' riuscito, e lasciare la configurazione nuova su un
# server che non si collega significa consegnare un guasto. Si torna indietro:
# meglio il nome vecchio di una presence morta.
#
# Il caso tipico, visto provando davvero: un Application ID che esiste ma NON
# e' tuo. Discord accetta la connessione al socket e poi non manda mai READY,
# perche' l'app appartiene a qualcun altro. Il messaggio lo dice, cosi' non si
# cerca il guasto nel posto sbagliato.
echo >&2
echo "La presence non si e' collegata (stato: ${CONN:-sconosciuto})." >&2
if [[ "${LAST_ERR:-}" == *"READY"* ]]; then
  echo "Discord non ha risposto READY: quasi sempre significa che" >&2
  echo "l'applicazione $ID non appartiene a questo account." >&2
  echo "Creane una TUA su https://discord.com/developers/applications." >&2
elif [[ -n "${LAST_ERR:-}" ]]; then
  echo "Discord dice: $LAST_ERR" >&2
fi
echo >&2
echo "Rimetto la configurazione precedente…" >&2
cp "$BACKUP" "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
echo "Ripristinato. Niente e' cambiato." >&2
exit 1
