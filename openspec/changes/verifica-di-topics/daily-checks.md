# Le prove del giro giornaliero (CHECK-02, tier `daily`)

Non codice: configurazione di QUESTA installazione (regola zero). Le tre prove che il
censimento vuole per il giro con `topics=sì` — e2e notturna, copia notturna del DB, Guardiano —
vanno nell'elenco `checks` del setting `topicsCheck` (colonna `topics_check_json`), ciascuna con
`tier: "daily"`: il giro giornaliero le esegue, un exit diverso da zero o un tempo oltre il tetto
le rende rosse.

In questa installazione sono applicate: le tre righe sotto sono già nel setting dal 22/11, con i
percorsi e i comandi veri di questa macchina (non ripetuti qui perché sono dati di questa
installazione, non del repo).

Forma di ciascuna prova (generica, da adattare alla macchina che la esegue):

- **e2e notturna**: legge l'ultimo giro del workflow `e2e-nightly.yml` su `main` con `gh run list`
  sul repo del progetto (richiede `gh` autenticato) ed è rosso se la conclusione non è un successo
  o se il giro è più vecchio della soglia scelta (qui 26 ore, con 2 ore di margine sopra la
  mezzanotte attesa). Forma del comando, con la soglia in secondi al posto del nome:
  ```
  gh run list --repo armonia/topics-app --workflow e2e-nightly.yml --branch main --limit 1 \
    --json conclusion,createdAt \
    --jq 'if (.[0].conclusion=="success") and ((now-(.[0].createdAt|fromdateiso8601))<93600+7200) then "ok" else "red" end' \
    | grep -qx ok
  ```
- **copia notturna del DB**: un `find` sulla cartella `backups` della cartella dati (`DATA_DIR`,
  vedi `scripts/db-snapshot.ts`), che cerca uno snapshot `topics-YYYY-MM-DD.db.zst` più giovane
  della soglia e non vuoto. Il glob è sul nome reale dello snapshot, non `*.sqlite*`: il DB vive
  compresso in `.zst`, non come file `.sqlite` sciolto. Forma del comando, con la soglia in minuti
  al posto del nome:
  ```
  find "$DATA_DIR/backups" -maxdepth 1 -name 'topics-*.db.zst' -mmin -1560 -size +1k | grep -q .
  ```
- **Guardiano**: una sonda del processo o del suo ultimo giro registrato (un `launchctl print`,
  un ping, un file di stato più giovane della cadenza del giro). Il comando dipende da come il
  Guardiano è installato su questa macchina, non da qualcosa nominato nel repo.

`checkTimeoutSec` nello stesso setting resta il tetto d'orologio di ogni comando (30s di default):
una prova che aspetta una rete va alzata caso per caso.
