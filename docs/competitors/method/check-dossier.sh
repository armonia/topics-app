#!/usr/bin/env bash
# La barra di un dossier: i 16 titoli nell'ordine giusto, lunghezza, fonti, niente trattini lunghi ne' email.
# Esce non-zero se un dossier non passa.
R="$(cd "$(dirname "$0")" && pwd)"
titoli=("In tre righe" "Identità" "Architettura" "Sessioni e task" "Usabilità" "Browser e anteprima" "Terminale, editor, file" "Remoto e mobile" "Provider e protocolli" "Performance" "Affidabilità e qualità" "Sicurezza e privacy" "Estendibilità" "Da prendere per Topics" "Da evitare" "Fonti")
rc=0
if [ $# -gt 0 ]; then files=("$@"); else files=("$R"/dossiers/*.md); fi
[ -e "${files[0]}" ] || { echo "nessun dossier"; exit 1; }
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  trovati=$(/usr/bin/grep -E '^## ' "$f" | sed 's/^## //')
  atteso=$(printf '%s\n' "${titoli[@]}")
  problemi=()
  [ "$trovati" = "$atteso" ] || problemi+=("titoli diversi")
  n=$(wc -l < "$f" | tr -d ' '); { [ "$n" -lt 150 ] || [ "$n" -gt 400 ]; } && problemi+=("$n righe")
  fonti=$(/usr/bin/grep -o -E '\[(codice|doc|README|issue|release)[^]]*\]' "$f" | wc -l | tr -d ' ')
  [ "$fonti" -lt 15 ] && problemi+=("solo $fonti fonti")
  /usr/bin/grep -q '—' "$f" && problemi+=("trattino lungo")
  senza=$(/usr/bin/grep -o -i -w -E 'piu|perche|gia|puo|cosi' "$f" | wc -l | tr -d ' ')
  /usr/bin/grep -q -E "\b[lL] [aeiouAEIOU]" "$f" && senza=$((senza+3))
  [ "$senza" -ge 3 ] && problemi+=("accenti o apostrofi mancanti ($senza)")
  /usr/bin/grep -q -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' "$f" && problemi+=("email")
  nv=$(/usr/bin/grep -o '\[non verificato\]' "$f" | wc -l | tr -d ' ')
  if [ ${#problemi[@]} -eq 0 ]; then echo "OK    $(basename "$f") · $n righe · $fonti fonti · $nv non verificati"
  else echo "NO    $(basename "$f") · ${problemi[*]}"; rc=1; fi
done
exit $rc
