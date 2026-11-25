# T9 · Server: il loop non si ferma per lanciare processi

Change `cloud-quality-pass`, traccia T9. Ramo di consegna: `cloud/t9-server-loop`.
Parti da `cloud/quality-pass-integrata`: T1 (topic dalla copia locale), T5 (server), T3 (avvio del
server) e T2 (board) sono già fusi lì, i loro REPORT sono in `reports/`. Le regole comuni (setup,
barra, recinto, prova, consegna, modelli) sono in `tracks/_comuni.md`: leggile prima di partire.

**GOAL.** Nessun `spawnSync`/`execSync` nei percorsi periodici o caldi del server: il loop non si
ferma per un `ps` o un `git`, quindi streaming e WebSocket non hanno pause ogni pochi secondi.

**FUORI.** Cambiare cosa rispondono le rotte (stesso JSON), migration, gli spawn una tantum
all'avvio.

## Dove guardare

- `server/routes/processes.ts`: `isPidAlive` e `pidStartTime` fanno `Bun.spawnSync(["ps", ...])`
  ogni 3 s per ogni script tracciato (REPORT di T5). Su Linux bastano `process.kill(pid, 0)` e
  `/proc/<pid>/stat`; su macOS un solo `ps` asincrono per tutti gli script del giro.
- La rotta legacy `/api/system/status` (`server/providers/health.ts` dice dove sta): due `ps` più
  `ss`/`lsof` a ogni giro di cache; uno solo condiviso basta.
- `/api/git/branches` in `server/routes/files.ts`: un `git rev-list --count` per ramo, in serie; un
  solo `git for-each-ref --format='%(refname) %(upstream:track)'` dà lo stesso.
- Ogni altro `spawnSync`/`execSync` raggiungibile da una rotta o da un timer: elencali tutti nel
  REPORT con il verdetto. Per gli spawn asincroni c'è `spawnBounded` di T5.

## Misure (prima e dopo, stessa VM, due corse)

| Numero | Comando | Target |
|---|---|---|
| ritardo del loop, p99 e max su 60 s, 20 script tracciati e stato aperto | banco nuovo con `perf_hooks.monitorEventLoopDelay` | p99 −50%, max sotto 20 ms |
| `/api/git/branches` con 40 rami con upstream | banco nuovo | −50% |
| JSON delle rotte toccate | golden prima/dopo | identico |

Sul Mac di produzione `ps` scorre ~900 processi: scrivi nel REPORT la stima del guadagno lì.

## Prova

- Mutazione: rimetti uno `spawnSync` nel percorso periodico, il banco del loop lo vede.
- I test di `processes`, `status`, `files` verdi; barra intera prima della consegna.
