# T16 — un turno nativo non ferma il server: niente spawn sincroni sul suo percorso

**GOAL.** Due spawn sincroni girano a ogni turno del motore nativo e fermano il loop del server per tutti
(le altre chat, i frame in streaming): la lettura del Portachiavi (`server/providers/native/auth.ts:150`,
`security find-generic-password`, ~30 ms) e `git rev-parse --git-common-dir` di `claudeMemoryDir`
(`server/lib/native-parity.ts:114`, a ogni assemblaggio del contesto). Sono i due «KNOWN DEBT» dell'elenco di
`server/lib/sync-spawn-scan.test.ts`. Toglili dal percorso del turno senza cambiare cosa legge il turno.

- **Base:** `cloud/quality-pass-integrata` @ `093068f60` (Bun 1.4.2 fissata in `.bun-version`) più questo
  brief: ramo `cloud/t16-base`.

## Vincoli

- **Credenziali fresche come oggi.** Ogni turno legge le credenziali correnti: un cambio di account fatto
  con la CLI (il Portachiavi cambia) vale dal turno dopo, come adesso. Nessuna cache dei token in memoria
  oltre a quella che c'è. La lettura asincrona sostituisce quella sincrona sul percorso del turno
  (`getAccessToken`, `recoverAfter401`); quella sincrona resta solo dove un'API è sincrona per contratto
  (`hasCredentials`?): dici quali, quante volte girano e perché restano.
- Rinnovo, lock, formati dei file e scrittura nel Portachiavi: non si toccano.
- **`claudeMemoryDir`**: asincrono lungo l'assemblaggio del contesto, oppure memo per (cwd, home) con una
  scadenza breve; scegli e scrivi il perché. Una cartella che diventa un repo, o una worktree rimossa, si
  vede entro la scadenza.
- Il Portachiavi esiste solo su macOS: in VM provi col runner finto (`setKeychainRunnerForTests`), che dovrà
  avere anche la forma asincrona. La prova col Portachiavi vero la fa il coordinatore sul Mac.

## Barra

- **B1:** le due voci escono dall'elenco di `sync-spawn-scan.test.ts` (o quella che resta spiega perché) e la
  scansione è verde.
- **B2 freschezza:** un test cambia l'elemento del Portachiavi finto fra due turni e il secondo turno usa il
  token nuovo; verde prima e dopo.
- **B3 blocco del loop:** con un runner finto che impiega 30 ms, il ritardo massimo del loop
  (`monitorEventLoopDelay` o un timer di sonda) durante `getAccessToken` più l'assemblaggio del contesto,
  prima e dopo, numeri nel REPORT.
- **B4 mutazione** (copia scratch, mai il file vero): rimettere la lettura sincrona sul percorso del turno fa
  diventare rosso un test.
- **B5 verde resta verde:** la barra comune di `_comuni.md`.

## Consegna

Ramo `cloud/t16-turno-asincrono`, REPORT in `openspec/changes/cloud-quality-pass/reports/T16.md`.

**FUORI.** OAuth (rinnovo, `renewSerialized`, lock), formati delle credenziali, `writeKeychainCredentials`,
migrazioni, workflow CI, `.bun-version`, la chat e i test e2e (li hanno T13 e T15).
