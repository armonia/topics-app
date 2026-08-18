# Politica dei backup pre-migration

## Perche' esiste questa regola

I backup creati a mano prima di una migration vengono dimenticati: nessuno li
cancella, nessuno sa cosa proteggevano, e nel tempo si accumulano sul disco.
Il 18/08 erano presenti due backup stantii per un totale di ~920 MB (task
f0b07ae0). La regola qui sotto chiude il buco.

## La convenzione

**Nome**: `data/topics.db.bak-pre-<slug-della-migration>` dove lo slug e'
il nome leggibile della migration (es. `pre-amicizia-090`, `pre-push-device-scope`).

**Quando si crea**: solo prima di eseguire una migration distruttiva o
difficilmente reversibile. Una migration additive (aggiunge una colonna
nullable, crea una tabella) non richiede backup.

**Dove vivono**: nella stessa cartella del DB vivo (`data/`). Non vanno
copiati altrove.

**Quanti se ne tengono**: **uno solo** per migration applicata. Appena la
migration e' confermata andata a buon fine (il DB vivo apre e risponde, la
tabella delle migration registra la migration), il backup va rimosso con
`trash`, non con `rm`.

**Chi li cancella**: chi ha avviato la migration. Non e' un'operazione
automatica: si fa subito dopo aver verificato il successo, non giorni dopo.

## Come si verifica che la migration e' andata a buon fine

Prima di cancellare il backup:

```bash
# 1. Il DB vivo apre e risponde
sqlite3 data/topics.db "SELECT count(*) FROM sqlite_master WHERE type='table';"

# 2. La migration risulta applicata
sqlite3 data/topics.db "SELECT name FROM migrations ORDER BY applied_at DESC LIMIT 5;"
# (o la tabella che il progetto usa per tracciare le migration)
```

Se entrambi i controlli passano, il backup e' eliminabile.

## Scadenza automatica

Se dopo **7 giorni** un backup e' ancora presente, e' un segnale che nessuno
ha verificato la migration. A quel punto:

1. Verificare manualmente i due controlli sopra.
2. Se la migration e' applicata: cancellare il backup con `trash`.
3. Se la migration NON e' applicata: aprire un task di incident.

Non implementare una scadenza automatica (cron, script): la verifica prima
della cancellazione e' intenzionale e richiede un occhio umano.

## Cosa fare con i WAL

Ogni backup puo' avere un `-wal` accanto. Va trattato come il backup stesso:
cancellato insieme, con `trash`.

## Riferimento

- Task che ha generato questa regola: `f0b07ae0-92cb-4efa-8efd-2f2591dda27b`
- Backup rimossi: `topics.db.bak-pre-amicizia-090` (269 MB, 10/08) e
  `topics.db.bak-pre-push-device-scope` (651 MB, 15/08), entrambi verificati
  prima della rimozione (migration applicate, DB vivo).
