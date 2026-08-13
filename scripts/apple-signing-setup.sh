#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Da «ho appena pagato l'iscrizione» a «la CI firma e notarizza», senza che
# nessun segreto passi da una chat o resti in un file.
#
# ── COSA FA A MANO L'UMANO, E PERCHÉ NON PUÒ FARLO QUESTO SCRIPT ────────────
# Creare l'Apple Account, accettare il contratto che impegna [azienda], e
# pagare. Sono atti legali e finanziari: non si automatizzano, e nessuno
# strumento cambia questo. Tutto il resto è qui.
#
# ── PERCHÉ I VALORI NON ARRIVANO COME ARGOMENTI ─────────────────────────────
# `gh secret set NOME --body "$VALORE"` mette il segreto nella riga di comando,
# che è leggibile da `ps` a qualunque altro processo della macchina e finisce
# nella cronologia della shell. Qui i valori arrivano SEMPRE da stdin, letti
# senza eco, e non vengono mai stampati — nemmeno in caso di errore.
#
# Uso:
#   scripts/apple-signing-setup.sh csr        # 1. prepara la richiesta per Apple
#   scripts/apple-signing-setup.sh importa    # 2. installa il .cer scaricato
#   scripts/apple-signing-setup.sh segreti    # 3. carica i segreti su GitHub
#   scripts/apple-signing-setup.sh verifica   # 4. controlla un .app/.dmg firmato
# ─────────────────────────────────────────────────────────────────────────────

LAVORO="${TMPDIR:-/tmp}/apple-signing-$USER"
mkdir -p "$LAVORO"
chmod 700 "$LAVORO"

rosso()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()   { printf '\033[2m%s\033[0m\n' "$*"; }

serve() {
  command -v "$1" >/dev/null 2>&1 || { rosso "Manca $1. $2"; exit 1; }
}

# ── 1. La richiesta di firma ────────────────────────────────────────────────
# Apple vuole una CSR generata sulla TUA macchina: la chiave privata non lascia
# mai il portachiavi, e il certificato che ti restituisce vale solo con quella.
csr() {
  local email nome
  read -r -p "Email dell'Apple Account (quello NUOVO, titolare di [azienda]): " email
  read -r -p "Nome e cognome legali: " nome
  [ -n "$email" ] && [ -n "$nome" ] || { rosso "Servono entrambi."; exit 1; }

  local chiave="$LAVORO/armonia-developer-id.key"
  local richiesta="$LAVORO/armonia-developer-id.certSigningRequest"

  # 2048 bit RSA: è quello che Apple accetta per i Developer ID.
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$chiave" -out "$richiesta" \
    -subj "/emailAddress=$email/CN=$nome/C=IT" 2>/dev/null
  chmod 600 "$chiave"

  verde "Fatto. Richiesta: $richiesta"
  cat <<ISTRUZIONI

Adesso, sul portale — e serve l'account TITOLARE, un Admin non può:

  1. https://developer.apple.com/account/resources/certificates/add
  2. Scegli «Developer ID Application».
     NON «Apple Distribution» e NON «Apple Development»: quelle due sono per
     l'App Store, e con quelle Gatekeeper blocca lo stesso.
  3. Carica $richiesta
  4. Scarica il .cer e poi lancia:

       scripts/apple-signing-setup.sh importa ~/Downloads/developerID_application.cer

La chiave privata resta in $chiave e non va da nessuna parte.

ISTRUZIONI
}

# ── 2. Installare il certificato ────────────────────────────────────────────
importa() {
  local cer="${1:-}"
  [ -n "$cer" ] && [ -f "$cer" ] || { rosso "Uso: $0 importa <percorso del .cer>"; exit 1; }
  local chiave="$LAVORO/armonia-developer-id.key"
  [ -f "$chiave" ] || { rosso "Non trovo la chiave privata in $chiave. Hai fatto il passo 'csr'?"; exit 1; }

  # Il .cer di Apple è DER; per unirlo alla chiave in un .p12 serve in PEM.
  openssl x509 -inform DER -in "$cer" -out "$LAVORO/cert.pem" 2>/dev/null \
    || cp "$cer" "$LAVORO/cert.pem"

  local p12="$LAVORO/armonia-developer-id.p12"
  echo
  info "Scegli una password per il .p12. Serve alla CI, e la caricheremo come segreto."
  info "Non viene stampata e non finisce in nessun file oltre al .p12 stesso."
  local pw pw2
  read -r -s -p "Password: " pw; echo
  read -r -s -p "Ripetila:  " pw2; echo
  [ "$pw" = "$pw2" ] || { rosso "Non coincidono."; exit 1; }
  [ -n "$pw" ] || { rosso "Vuota no: un .p12 senza password è una chiave privata in chiaro."; exit 1; }

  openssl pkcs12 -export -legacy \
    -inkey "$chiave" -in "$LAVORO/cert.pem" \
    -out "$p12" -passout "pass:$pw" 2>/dev/null \
  || openssl pkcs12 -export \
    -inkey "$chiave" -in "$LAVORO/cert.pem" \
    -out "$p12" -passout "pass:$pw"
  chmod 600 "$p12"
  unset pw pw2

  # Nel portachiavi, così puoi firmare anche in locale.
  security import "$cer" -k ~/Library/Keychains/login.keychain-db 2>/dev/null || true

  echo
  verde "Certificato pronto: $p12"
  local identita
  identita=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 || true)
  if [ -n "$identita" ]; then
    verde "Identità nel portachiavi:"
    echo "  $identita"
  else
    info "L'identità non compare ancora fra quelle valide — normale se il"
    info "certificato intermedio di Apple manca. Aprilo con doppio clic, oppure"
    info "scarica https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"
  fi
  echo
  info "Poi: scripts/apple-signing-setup.sh segreti"
}

# ── 3. I segreti su GitHub ──────────────────────────────────────────────────
# Il workflow è GIÀ armato: `.github/workflows/tauri-release.yml` arma la
# notarizzazione solo se ci sono tutte e tre le sue variabili, altrimenti firma
# e basta. Qui si riempiono le sei caselle.
segreti() {
  serve gh "Installalo con: brew install gh"
  gh auth status >/dev/null 2>&1 || { rosso "Non sei autenticato: gh auth login"; exit 1; }

  local p12="$LAVORO/armonia-developer-id.p12"
  [ -f "$p12" ] || { rosso "Non trovo $p12. Fai prima 'importa'."; exit 1; }

  echo
  info "Sei valori. Nessuno viene stampato, nessuno passa dalla riga di comando."
  echo

  # base64 del .p12 — via stdin, mai come argomento.
  base64 -i "$p12" | gh secret set APPLE_CERTIFICATE
  verde "APPLE_CERTIFICATE ✓"

  local pw
  read -r -s -p "Password del .p12 (la stessa di prima): " pw; echo
  printf '%s' "$pw" | gh secret set APPLE_CERTIFICATE_PASSWORD
  unset pw
  verde "APPLE_CERTIFICATE_PASSWORD ✓"

  # L'identità si LEGGE dal portachiavi invece di farla riscrivere: un refuso
  # qui non fallisce al momento del salvataggio, fallisce a fine build.
  local identita
  identita=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep "Developer ID Application" | head -1 \
    | sed -E 's/.*"(.*)".*/\1/' || true)
  if [ -n "$identita" ]; then
    info "Identità trovata: $identita"
    printf '%s' "$identita" | gh secret set APPLE_SIGNING_IDENTITY
  else
    read -r -p 'APPLE_SIGNING_IDENTITY (es. "Developer ID Application: [azienda] (TEAMID)"): ' identita
    printf '%s' "$identita" | gh secret set APPLE_SIGNING_IDENTITY
  fi
  verde "APPLE_SIGNING_IDENTITY ✓"

  local appleid
  read -r -p "APPLE_ID (l'email dell'account titolare): " appleid
  printf '%s' "$appleid" | gh secret set APPLE_ID
  verde "APPLE_ID ✓"

  echo
  info "APPLE_PASSWORD è una APP-SPECIFIC PASSWORD, non quella dell'account."
  info "Si genera su https://account.apple.com → Sign-In and Security →"
  info "App-Specific Passwords. Ha la forma xxxx-xxxx-xxxx-xxxx."
  local asp
  read -r -s -p "APPLE_PASSWORD: " asp; echo
  case "$asp" in
    ????-????-????-????) : ;;
    *) rosso "Non ha la forma di una app-specific password. Controlla."; exit 1 ;;
  esac
  printf '%s' "$asp" | gh secret set APPLE_PASSWORD
  unset asp
  verde "APPLE_PASSWORD ✓"

  local team
  # Il Team ID sta fra parentesi nel nome dell'identità: si prende da lì se c'è.
  team=$(printf '%s' "$identita" | sed -nE 's/.*\(([A-Z0-9]{10})\).*/\1/p')
  if [ -n "$team" ]; then
    info "Team ID dedotto dall'identità: $team"
  else
    read -r -p "APPLE_TEAM_ID (10 caratteri): " team
  fi
  printf '%s' "$team" | gh secret set APPLE_TEAM_ID
  verde "APPLE_TEAM_ID ✓"

  echo
  verde "Tutti e sei caricati. Controllo:"
  gh secret list | grep -E "APPLE_" || true
  echo
  info "Da ora un tag tauri-vX.Y.Z firma E notarizza. Il .p12 è ancora in"
  info "$p12 — cancellalo quando hai finito: trash \"$p12\""
}

# ── 4. La prova ─────────────────────────────────────────────────────────────
# «Firmato» e «notarizzato» sono due cose diverse, e solo la seconda toglie il
# blocco di Gatekeeper. Questo le distingue invece di fidarsi del build verde.
verifica() {
  local bersaglio="${1:-$HOME/Applications/Topics.app}"
  [ -e "$bersaglio" ] || { rosso "Non trovo $bersaglio"; exit 1; }

  echo; info "── Chi l'ha firmata ──"
  codesign -dvv "$bersaglio" 2>&1 | grep -E "Authority|TeamIdentifier|Timestamp" || true

  echo; info "── Gatekeeper la farebbe partire? ──"
  if spctl -a -vvv -t install "$bersaglio" 2>&1 | tee /dev/stderr | grep -q "accepted"; then
    verde "Accettata."
  else
    rosso "RIFIUTATA: un cliente vedrebbe il blocco al primo avvio."
  fi

  echo; info "── La ricevuta di notarizzazione è attaccata? ──"
  if xcrun stapler validate "$bersaglio" 2>&1 | grep -q "worked"; then
    verde "Attaccata: funziona anche col Mac offline."
  else
    rosso "Assente. Senza, un Mac senza rete blocca lo stesso."
  fi
}

case "${1:-}" in
  csr)      csr ;;
  importa)  importa "${2:-}" ;;
  segreti)  segreti ;;
  verifica) verifica "${2:-}" ;;
  *)
    cat <<USO
Da «ho pagato» a «la CI firma e notarizza».

  $0 csr                    prepara la richiesta da caricare sul portale
  $0 importa <file.cer>     installa il certificato scaricato, crea il .p12
  $0 segreti                carica i sei segreti su GitHub (mai da riga di comando)
  $0 verifica [app]         dice se Gatekeeper la accetta e se la ricevuta c'è

Prima di tutto questo, a mano e solo tu: creare l'Apple Account, iscrivere
l'organizzazione (serve il suo D-U-N-S, che Apple verifica), pagare.
USO
    ;;
esac
