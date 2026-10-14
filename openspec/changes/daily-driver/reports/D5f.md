# D5f — Card a calendario

**Bar prima:** funzione assente, 0/1 prove; nessuna creazione ricorrente verificabile.

**Bar dopo:** `bun test server/services/scheduled-cards.test.ts` exit 0, 7 pass, 22 assert; `bun run typecheck` exit 0 (5/5); `bun run lint` exit 0 (4 warning preesistenti client); `bun run check:migrations` exit 0 (184 file); controlli lingua, UI, commenti, `git diff --check` exit 0. E2E tipizzato, ma prova browser/video demandata alla CI.

## Fatto

- Ricorrenze per board con regola cron, fuso IANA, colonna e label; modifica, pausa e cancellazione soft. Le card create entrano nel dispatcher esistente. Le istanze mantengono il legame storico con la ricorrenza.
- Tick atomico: salta una ricorrenza se la card precedente è ancora aperta, recupera al massimo una scadenza, evita duplicati dopo riavvio e gestisce le ore ambigue o inesistenti del DST. La ricerca cron esamina date e orari candidati; `0 0 30 2 *` è rifiutata senza scansione al minuto.
- Menu board con elenco, esito, prossima esecuzione nel fuso configurato, form e preset; test E2E con clock controllabile e video attivato per la CI.
- Mutazione del ramo che salta le card aperte: il test mirato è andato rosso come atteso (5 pass, 1 fail, exit 1); mutanti rimossi.
- Review indipendente: corretti blocco CPU su cron impossibile e formattazione nel fuso del browser.

## Trovato e non fatto

- E2E browser non eseguito sul Mac come richiesto dalla traccia; `typecheck:e2e` è verde. Resta la prova CI con video.
- Nessuna prova su server avviato o database di produzione; la migration è locale e coperta dal controllo numerico.

## Rifiutato

- `check:emdash` sull'intero `server.ts` segnala una riga preesistente (`server.ts:3858`, testo sul bundle non ancora creato); il controllo esplicito sui 10 file applicativi toccati è verde.
- Commit e push non eseguiti, come richiesto dal brief.
