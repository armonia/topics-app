# T0 - Riconciliazione dei commit locali non pubblicati

Misurato il 22/10/2026. Tredici commit esistevano solo su questo disco: sette
sul checkout primario in HEAD distaccato, sei su `main` locale. `git cherry
origin/main` li dava **tutti** come `+`, cioe' «non a monte». La conclusione era
sbagliata, e la differenza fra `cherry` e il contenuto e' il motivo per cui vale
la pena scrivere questo foglio.

## I sette del checkout primario: superati, il contenuto e' su main

`cherry` li segnava mancanti perche' confronta i **patch-id**: la stessa materia
e' arrivata a monte per un'altra strada (schiacciata in una PR), quindi i
patch-id non combaciano. Il contenuto invece c'e'.

| File | Confronto con `origin/main` |
|---|---|
| `client/src/lib/chunkReloadGuard.ts` | identico |
| `server/lib/terminal-idle-park.ts` | identico |
| `server/providers/child-exit.ts` | identico |
| `public/sw.js` | identico |
| `client/src/state/pane/panePreload.ts` | main ha 24 righe in piu', 0 in meno |
| `server/routes/terminal.ts` | main ha 192 righe in piu' e 37 diverse |

Le 37 righe «in meno» su `terminal.ts` sembravano lavoro perso. Non lo sono:
`isPtyBridgeDisabled`, `pendingBufferRequests` e `bridgeConnecting` sono tutti
presenti su `origin/main` nello stesso file, spostati dentro di esso. E' un
rimescolamento, non una rimozione.

**Verdetto: superati.** Nessun cherry-pick. Il ramo
`salvataggio/7-commit-non-pushati` resta come rete finche' questa traccia non e'
chiusa, poi si cancella.

## I sei di `main` locale: uno solo manca davvero

| Commit | Esito |
|---|---|
| `13120f14e5` i task agent possono leggere la chat che `resolve_tab` indica | **MANCA**, recuperato |
| `366eb9f902` + `8da9151b13` + `ce2906a728` parole del gate identifier-language | superati |
| `e7500b4315` via lo slug della home da un commento di test | superato |
| `c687302c79` baseline di `check:bloat` | **scartato di proposito** |

Il recuperato e' un difetto di comportamento vero, 4 righe di produzione e 5 di
test: `resolve_tab` risponde a un `/tab/chat/<id>` incollato con
`next: read_chat_messages`, ma quello strumento era escluso per i task agent,
quindi l'agente veniva mandato a uno strumento che non aveva. Sta su
`fix/recupero-commit-locali`, cherry-pick con `-x`, e
`bun test server/mcp/topics-mcp-server.test.ts` da' 153 pass su 153.

I tre del gate sono superati **per misura, non per somiglianza**: su
`origin/main` `bun run check:identifier-language` esce 0 da se'
(«5382 nomi non inglesi, tutti gia' nella baseline»). Un gate che passa non ha
bisogno delle parole che gli volevamo insegnare.

La baseline di `check:bloat` si scarta e non si riporta: quella locale e' stata
congelata su un albero di 646 commit piu' vecchio. Rigiocarla scriverebbe come
«vero oggi» un numero di allora. Si rigenera con
`bun run check:bloat --update-baseline` quando serve, e il commit che lo fa dice
da quale albero.

## Cosa resta da fare, e non e' di questa traccia

- Il checkout primario torna su `main` allineato a `origin/main`. Va fatto a
  server fermo: la produzione serve da quella cartella.
- I due rami `salvataggio/*` si cancellano quando `fix/recupero-commit-locali`
  e' fuso.
