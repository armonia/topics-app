# Tasks — feature-weight-inventory

Convenzione: ogni fase chiude con `tsc` verde e i test della fase verdi. Ogni check
aggiunto va visto **fallire almeno una volta** prima di dirlo fatto.

## Phase 1 — Il registro (puro, testato)
- [x] `client/src/lib/featureWeight.ts`: `registerFeatureWeight(label, natura, fn)`,
      `collectFeatureWeights()`, tipi `Misurato` / `Trattenuto`.
- [x] Regole pure e testate: voci vuote escluse, proprietario in errore = non misurato
      (mai zero), ordinamento stabile e deterministico a parità di peso.
- [x] Nessun totale che mescoli le due nature: il tipo stesso deve renderlo impossibile.

## Phase 2 — Le sorgenti
- [x] Registrare: tab aperte (per tipo), task della kanban, chat in memoria, anteprime
      dei topic, coda dei turni, cronologia siti, tab dei task.
- [x] Registrare le voci MISURATE dalla flotta già esistente: sessioni terminale e pane
      browser, riusando `paneUsage` senza aggiungere letture di sistema.
- [x] `devHeapProbe` diventa un LETTORE di questo registro invece di tenerne uno suo:
      un solo elenco di proprietari, non due che divergono.

## Phase 3 — Le superfici
- [x] Estratto nel tooltip del totale in `SidebarStatusBar`.
- [x] Inventario completo nel dropdown (`PerfSection`).
- [x] Raccolta on-demand: nessun timer, nessuna invocazione a riposo.
- [x] i18n it + en, `check-emdash` verde.

## Phase 4 — Prova
- [x] Unitari sul registro e sull'aggregazione, provati capaci di fallire (3 difetti
      iniettati, 3 rossi distinti).
- [x] E2E che apre il dropdown e verifica l'inventario, provato capace di fallire
      (2 difetti iniettati, exit 1 in entrambi i casi).
- [x] `bun run test:unit` (11.391, 0 rossi) + `typecheck` (0 su 5 progetti) +
      `check-emdash` verdi. `check:bloat` rosso su `i18n.ts`/`i18n-en.ts`, che a
      HEAD erano gia' 1898 contro un tetto di 1746: preesistente, non mio, non
      registrato. Il mio unico delta (`server.ts` +25) e' registrato.

## Trovato provando, e corretto
- Il primo E2E restava VERDE con un difetto iniettato che scriveva i byte stimati
  come «MB»: guardava la colonna visibile, e quella riga vive nel `title`. Coperti
  entrambi, piu' un unitario sull'invariante.
- `toLocaleString('it-IT')` dipende dall'ICU del runtime. Sostituito con una regola
  esplicita, piu' un test che la confronta col runtime dove il runtime ha
  un'opinione.
- Sui dati veri le righe dicevano «1 voce · 1 processo»: lo stesso numero due
  volte. Le voci si tacciono quando coincidono coi processi.
