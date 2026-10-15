# D7d-a · Test instabili, primo giro

## Barra · prima → dopo

- Censimento CI del 15/10, 33 run di main in 3 giorni: follow **10** primi tentativi rossi, POP-03 **7**, NH-02 **6**, PLANTAB-01 **6**, compact **6**. Gate locali prima: non misurati.
- Dopo: `bun run typecheck:e2e` exit **0**; `bun run typecheck` exit **0**; `bun run lint` exit **0** (4 warning già presenti); `bun test client/src/lib/taskConversationFollow.test.ts` exit **0**, **3/3**.
- Mutazione della regola di follow nella copia temporanea: lo stesso test esce **1** (1 rosso atteso); il worktree è rimasto intatto.
- Barra CI repeat=20/load=true: **non eseguita**. Richiede il push, vietato dal brief locale; restano le clip qui sotto.

## Fatto

- `.github/workflows/clip-consegna.yml`: aggiunti `repeat` (default 1, sopra 1 usa `--repeat-each` e `--retries=0`) e `load` (default false, un `yes` per core, terminati dal trap). Con i default il comando Playwright resta invariato. `git diff --check` exit **0**; parsing YAML Ruby exit **0**. `actionlint` non è installato.
- `tests/e2e/task-conversation-follow.spec.ts`, `client/src/components/Board/TaskDetail.tsx`: il resize verticale cambia `clientHeight` di 280 px, ma il vecchio handler poteva interpretare lo scroll automatico del layout come gesto dell’utente e spegnere il follow prima del re-pin. Ora rileva la variazione del riquadro e conserva la scelta di chi era già in follow. Test isolato **3/3** verde e **1/3** rosso con la regola precedente nella copia. La clip Chromium resta da lanciare:
  `gh workflow run clip-consegna.yml --repo armonia/topics-app --ref daily/d7d-flaky-a -f spec=tests/e2e/task-conversation-follow.spec.ts -f grep="a reader following the last answer keeps it in view while the drawer narrows and widens (#275)" -f repeat=20 -f load=true -f slowmo=false`
- `tests/e2e/notification-history.spec.ts`, NH-02: la misura attende ora `attention:init`. Il negozio parte vuoto (`ready: false`) e riceve il conteggio dal frame; il test leggeva la baseline prima del frame e confrontava `""` con `"1"`. Prova census: errore esatto alla riga 148; prova codice: `recordAttentionFrames` conta gli init prima della misura. Clip:
  `gh workflow run clip-consegna.yml --repo armonia/topics-app --ref daily/d7d-flaky-a -f spec=tests/e2e/notification-history.spec.ts -f grep="NH-02: opening the history marks nothing, not even after a reload, and a row raises no number" -f repeat=20 -f load=true -f slowmo=false`

## Trovato e non fatto

- **POP-03:** il log mostra la cella del browser trascinato senza la seconda tab, atteso `[b2,b1]`, ricevuto `[b2]`; il test aspetta solo la visibilità prima del gesto. La causa del drop mancato non è provata e Chromium non gira sul Mac. Clip:
  `gh workflow run clip-consegna.yml --repo armonia/topics-app --ref daily/d7d-flaky-a -f spec=tests/e2e/pane-over-pane-group.spec.ts -f grep="POP-03: il ritorno — una tab tolta dal gruppo torna una pane a sé" -f repeat=20 -f load=true -f slowmo=false`
- **PLANTAB-01:** il setup verifica il puntatore `planCommentId`; nel log il POST del commento, il GET del task e il GET della board rispondono 201/200, ma il tab non compare. Non è provato quale stato client lo perda; non ho cambiato prodotto o test senza causa. Clip:
  `gh workflow run clip-consegna.yml --repo armonia/topics-app --ref daily/d7d-flaky-a -f spec=tests/e2e/plan-surface.spec.ts -f grep="PLANTAB-01: nessun piano si legge scorrendo di lato" -f repeat=20 -f load=true -f slowmo=false`
- **Chat compact:** i 6 log falliscono aspettando che `/compact` arrivi sul socket (`sent` resta diverso da `[/compact]`); la causa tra input UI e invio WS resta da provare. Il tentativo WebKit locale non è arrivato alla spec: global setup fermo su `Bundle a metà (index.html): aspetto il build del client…`; interrotto con exit **130**, senza build extra. Clip:
  `gh workflow run clip-consegna.yml --repo armonia/topics-app --ref daily/d7d-flaky-a -f spec=tests/e2e/chat-compact-drain.spec.ts -f grep="lo stream:end di una compattazione (con riga scartata) fa partire la coda" -f repeat=20 -f load=true -f slowmo=false`

## Rifiutato

- Per NH-02 il log non prova che la riga di cronologia accenda il badge: l’errore coincide con la lettura prima di `attention:init`, mentre il badge deriva dal negozio `attention`, separato dalla cronologia.
- Nessun retry o timeout aumentato. Il tentativo WebKit interrotto non è contato come test rosso.
