# T0 - Il checkout primario torna su main, senza toccare un file

Fatto il 22/10/2026, **a server vivo**, senza finestra e senza riavvio. Il piano
diceva «va fatto a server fermo»: era una precauzione sbagliata, e il motivo per
cui era sbagliata vale piu' del risultato.

## Lo stato di partenza, e perche' la misura iniziale era ottimista

Il checkout primario era su **HEAD distaccato** 153 commit dietro `origin/main`,
con 458 voci sporche. La prima misura diceva «268 dei 276 modificati sono
identici a `origin/main`, quindi lo sporco e' un falso»: era vera e insufficiente.
Guardava solo le voci marcate `M`, cioe' i file che differivano dal **vecchio**
HEAD. I file che combaciavano col vecchio HEAD erano *puliti* e quindi invisibili,
ed erano la maggioranza: **179 file stantii**, fra cui l'intero albero di
`openspec/changes/daily-driver/` che risultava semplicemente assente.

Da qui veniva l'errore di lettura piu' costoso della giornata: cercando
`daily-driver` nel checkout non lo trovavo, e ne concludevo che il piano non
esistesse. Esisteva, con 45 report.

## Le tre operazioni, e perche' non toccano i file

```
git update-ref refs/heads/main <sha di origin/main>   # sposta una ref
git symbolic-ref HEAD refs/heads/main                 # attacca HEAD al ramo
git reset                                             # riallinea solo l'indice
```

Nessuna delle tre scrive nell'albero di lavoro. `git reset` senza `--hard` tocca
l'indice e basta. Provato, non dedotto: l'impronta di `mtime`, dimensione e nome
di ogni `.ts`/`.tsx` sotto `server/`, `client/src` e `shared/` e'
`c77bef1a9732c577bb26fc46d6cb347f6051f782` prima **e dopo**.

Effetto: `HEAD` passa da distaccato a `main`,
`git rev-list --left-right --count main...origin/main` da `6 646` a **`0 0`**, e
lo sporco da 458 voci a 202, perche' ora dice la verita' invece di confrontarsi
con un commit di 153 commit prima.

## Il ripristino dei 179, e perche' nemmeno quello riavvia il server

I 179 stantii sono **tutti** test, documenti e `openspec/`: zero file di
produzione. Lo dice la classificazione, non la fiducia: per ogni voce sporca ho
confrontato il file col vecchio HEAD, e dei quattro che sembravano di produzione
nessuno lo era davvero (erano `*.test.ts`).

Questo rende il ripristino innocuo, e il motivo sta nel watcher:
`scripts/server-watch.sh` ricava i file da guardare dal **grafo dei moduli** di
`server.ts` (`bun build --metafile`), piu' `shared/` per intero come rete. Un
`*.test.ts` non e' importato da `server.ts`, quindi non e' nel grafo. Verificato
anche il caso di rete: nessuno dei 179 sta sotto `shared/`.

Dopo il ripristino: 12 file sporchi tracciati, 11 non tracciati, e il server
**non e' ripartito** (pid 92082 prima e dopo, `HTTP 200` in 34 ms,
`scripts/server-reload-gate.sh` esce 0).

## I 12 che restano sono lavoro vero, e non si buttano

Non sono residui: sono una spike coerente sul motore del browser.
`server/browser-engine-registry.ts`, `shared/browser-ws-messages.ts`,
`server/routes/terminal.ts`, `openspec/specs/remote-browser/spec.md`, quattro
file di test attigui, piu' le cartelle non tracciate `desktop-tauri/cef-spike/`,
`spike/neko/`, `spike/rrweb-cobrowse/` e
`server/browser-engine-switch-activation.md`.

Restano dove sono, e il loro diff e' salvato come patch fuori dal repo. Chi le
riprende decide se diventano una change: **non sono di questa traccia**.

## Cosa resta

- Il base ref delle worktree e il target del land: e' il codice, ed e' il lavoro
  principale di T0.
- I rami `salvataggio/*` si cancellano quando `fix/recupero-commit-locali` e'
  fuso.
