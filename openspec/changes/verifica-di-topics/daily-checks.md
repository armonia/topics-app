# Le prove del giro giornaliero (CHECK-02, tier `daily`)

Non codice: configurazione di QUESTA installazione (regola zero). Le tre prove che il
censimento vuole per il giro con `topics=sì` — e2e notturna, copia notturna del DB, Guardiano —
vanno nell'elenco `checks` del setting `topicsCheck` (colonna `topics_check_json`), ciascuna con
`tier: "daily"`: il giro giornaliero le esegue, un exit diverso da zero o un tempo oltre il tetto
le rende rosse.

Il JSON sotto è pronto per le prime due; la terza ha solo il segnaposto, perché "Guardiano" non è
nominato da nessuna parte in questo repo e il suo comando lo sa solo chi l'ha installato.

```json
{
  "checks": [
    {
      "name": "e2e notturna",
      "tier": "daily",
      "command": "gh run list --repo armonia/topics-app --workflow e2e-nightly.yml --branch main --limit 1 --json conclusion,createdAt --jq 'if (.[0].conclusion==\"success\") and ((now-(.[0].createdAt|fromdateiso8601))<129600) then \"ok\" else \"red\" end' | grep -qx ok"
    },
    {
      "name": "copia notturna del DB",
      "tier": "daily",
      "command": "find <CARTELLA_DELLE_COPIE> -maxdepth 1 -name '*.sqlite*' -mmin -1560 -size +1k | grep -q ."
    },
    {
      "name": "Guardiano",
      "tier": "daily",
      "command": "<COMANDO O SONDA DEL GUARDIANO QUI>"
    }
  ]
}
```

Da sistemare prima di incollarlo nelle impostazioni:
- **e2e notturna**: pronto così com'è se `gh` è autenticato sul server (legge l'ultimo giro del
  workflow `e2e-nightly.yml` su `main`, rosso se non è un successo o ha più di 26 ore).
- **copia notturna del DB**: `<CARTELLA_DELLE_COPIE>` è la cartella dove la copia notturna scrive
  i suoi file — va sostituita con il percorso vero di questa macchina (non ce n'è uno nel repo).
  129600 e -1560 sono entrambi 26 ore in secondi/minuti: tengono un margine di 2 ore sopra la
  mezzanotte attesa, da aggiustare se la copia gira a un'altra ora.
- **Guardiano**: questo repo non nomina nessun processo con questo nome — serve il comando o la
  sonda di chi l'ha installato (un `launchctl print`, un ping, un file di stato) prima che la riga
  abbia un senso.

`checkTimeoutSec` nello stesso setting resta il tetto d'orologio di ogni comando (30s di default):
una prova che aspetta una rete va alzata caso per caso.
