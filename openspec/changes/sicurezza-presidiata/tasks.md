# Tracce

Ogni traccia ha la sua barra (in `specs/acceptance.md`); lo stato lo dà il test, non la casella. Codice e commenti in inglese nei file nuovi (`check:comment-language`). Nessun nome, host o account nel codice: ciò che varia sta nelle impostazioni o nella tabella `machines` (regola zero).

## T1 · Vista (dipende da: niente)
Rotta `GET /api/machines/health` che legge l'ultimo giro di `server/boot/machine-health.ts` (lo stesso dato di `machines-health.json`, tipi da `shared/machine-health.ts`); store client; segno di sicurezza su ogni riga nodo di `client/src/components/Sidebar/DevicesLevel.tsx` e `client/src/components/Settings/NodesSection.tsx`, con i quattro check nel menu della riga. Icone lucide (`ShieldCheck`, `ShieldAlert`, `ShieldX`, `ShieldQuestion`), niente emoji.
Barra: test della rotta + e2e `machine-security-view.spec.ts` con video; screenshot 375/768/1440/3440 accanto al prima.

## T2 · Avviso (dipende da: niente)
Funzione pura `securityAlerts(prev, next, openCards)` → card da aprire e da chiudere, chiave `security:<machineId>:<check>`; aggancio al giro di MACHINE-05; board di destinazione da impostazione (vuota = nessuna card, il default funziona).
Barra: unit test delle transizioni + mutazione sulla chiave.

## T3 · Server senza Topics (dipende da: niente)
Elenco di server nelle impostazioni (host, utente SSH, porta); un `Runner` che esegue i comandi delle sonde via `ssh -o BatchMode=yes` in sola lettura; i parser restano quelli di `machine-security.ts`.
Barra: unit test con uscite registrate di un server Ubuntu; una corsa vera su un server di prova, esito nel resoconto.

## T4 · Aggiornato da solo (dipende da: T2 per la card)
Giro quotidiano dell'audit dipendenze su main senza push (job programmato di Topics quando il motore dei lavori programmati è pronto, nel frattempo `schedule:` in un workflow GitHub); check `reboot-required` oltre 24 ore nelle sonde Linux.
Barra: `check:security --only=dependencies` esce 0 su main; test del parser `reboot-required`.

## T5 · Segreti oscurati (dipende da: niente)
`server/lib/secret-redaction.ts`: regole chiuse e testate; applicate dove si salvano argomenti e output dei tool, prima del salvataggio e del rinvio al modello; pulizia una tantum delle righe già salvate dopo backup di `data/topics.db` (+ `-wal`), provata su un DB sintetico come le migration di dati.
Barra: unit test con un caso vero per regola e i falsi positivi noti; mutazione sulla regola `sshpass -p`.
