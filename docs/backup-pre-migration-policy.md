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
sqlite3 data/topics.db "SELECT name FROM schema_migrations ORDER BY applied_at DESC LIMIT 5;"
```

Se entrambi i controlli passano, il backup e' eliminabile.

## Se una migration si interrompe

Il runner applica ogni migration in una transazione e la registra soltanto
dopo averne eseguito tutto il SQL. Anche `duplicate column name` interrompe
l'avvio: la colonna puo' esistere in un vecchio DB modificato a mano, mentre
altre colonne, indici o aggiornamenti della stessa migration sono mancanti.
La transazione fallita viene annullata, la migration resta non registrata e
la connessione viene chiusa; un nuovo avvio riprova senza dichiarare successo.
Le migration gia' registrate continuano a essere saltate normalmente.

Conservare il backup e identificare il file indicato nell'errore. Il recupero
richiede una verifica specifica dello schema e dei dati: usare un backup
coerente precedente alla migration, verificando anche i dati scritti dopo lo
snapshot, oppure preparare una correzione mirata su una copia isolata. Se non
esiste un backup verificato, aprire un task di incident. Non aggiungere a mano
la riga al registro e non eliminare colonne per forzare il prossimo avvio.

## Scadenza automatica

Se dopo **7 giorni** un backup e' ancora presente, e' un segnale che nessuno
ha verificato la migration. A quel punto:

1. Verificare manualmente i due controlli sopra.
2. Se la migration e' applicata: cancellare il backup con `trash`.
3. Se la migration NON e' applicata: aprire un task di incident.

Non implementare una scadenza automatica (cron, script): la verifica prima
della cancellazione e' intenzionale e richiede un occhio umano.

## Come si copia

Non con `cp`: una copia del file mentre il server scrive prende il DB a meta'
di un checkpoint, obbliga a copiare anche il `-wal` a mano, e porta con se' le
pagine libere (il 2026-09-07 il DB vivo ne aveva 28.273, cioe' 116 MB di
niente ripetuti in ognuna delle nove copie trovate in `data/`). SQLite ha il
comando fatto per questo:

```bash
sqlite3 data/topics.db "VACUUM INTO 'data/topics.db.bak-pre-<slug>'"
```

Snapshot consistente anche a server acceso, WAL gia' incluso, freelist a zero:
un solo file, grande quanto i dati e non quanto il file. Verifica:
`sqlite3 'file:data/topics.db.bak-pre-<slug>?mode=ro' 'PRAGMA freelist_count'`
deve dare 0.

Niente `VACUUM` sul DB vivo per «recuperare» quelle pagine: le riusa da solo
(~3.800 al giorno con i nuovi blocchi) e in una settimana la freelist e' a
zero senza fermare il server.

## Cosa fare con i WAL

Ogni backup puo' avere un `-wal` accanto (solo se copiato con `cp`: `VACUUM
INTO` non ne produce). Va trattato come il backup stesso: cancellato insieme,
con `trash`.

## Riferimento

- Task che ha generato questa regola: `f0b07ae0-92cb-4efa-8efd-2f2591dda27b`
- Backup rimossi: `topics.db.bak-pre-amicizia-090` (269 MB, 10/08) e
  `topics.db.bak-pre-push-device-scope` (651 MB, 15/08), entrambi verificati
  prima della rimozione (migration applicate, DB vivo).
