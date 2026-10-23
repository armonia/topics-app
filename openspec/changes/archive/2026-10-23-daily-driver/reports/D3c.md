# D3c, parità dello status Git

**Barra prima:** `gitStatus` assente, 0/30 fixture.
**Barra dopo:** `bun test native/parity.test.ts` 30/30 sul Mac, nessuno saltato. Mutazione vera, in
una copia del crate con X e Y scambiati nell'adattatore: 15/30 rossi (restano verdi solo gli
scenari simmetrici, `MM`, `UU`, `AA` e quelli senza voci). Parità anche sui repo veri: una worktree
di topics-app (9 voci) e un checkout con 378 voci e 10.587 commit.

## Fatto

- `gitStatus(path)` nel crate, asincrona con `AsyncTask` (pool di thread, mai il loop JS): radice,
  ramo, ahead/behind, voci porcelain v1 nell'ordine di git, ultimo commit (`%h|%H|%s|%an`). `null`
  fuori da un repo. Wrapper in `server/lib/native-addon.ts`, opzionale al caricamento: un `.node`
  vecchio senza la funzione si carica ancora. Nessun chiamante nel server.
- Il confronto segue porcelain **v1**, il formato che leggono oggi `parseBranchHeader` e
  `parsePorcelainZ`; il v2 della traccia era un'indicazione sbagliata.
- `native/parity.test.ts`: 30 scenari generati con `git` in cartelle temporanee, ognuno confrontato
  con `toEqual` sull'uscita dei parser del server. In CI gira nel job `tauri` dopo la build
  dell'addon.
- In revisione:
  - ahead/behind visitano solo la divergenza (`with_hidden`), come git; prima ogni chiamata
    visitava due volte l'intera storia;
  - lo scenario «da una sottocartella» ora interroga davvero la sottocartella, con un file cambiato
    fuori da essa;
  - tolta dal test la mutazione simulata, sostituita da quella vera qui sopra;
  - su Linux, filesystem che distingue le maiuscole, gix dava un file in conflitto `DU` anche come
    non tracciato `??` (CI rossa sullo scenario DU/UD): l'adattatore scarta un `??` per un percorso
    già tracciato, perché git non elenca mai un percorso due volte;
  - lo scenario del submodule committa con un'identità sua: in CI non ce n'è una globale.

## Misura (build release arm64, Mac con load average fra 57 e 83)

| repo | `git status` | i 3 processi del server | `gitStatus` nativo |
|---|---|---|---|
| worktree, 9 voci | 52 ms | 88 ms | 55 ms |
| checkout, 378 voci | 53 ms | 91-102 ms | 50 ms |

Mediane di 10 giri alternati. Il nativo sostituisce `rev-parse`, `status` e `log -1`: tre processi
in meno per ricalcolo, e circa metà del tempo. Il primo giro di misura (1.827 ms contro 198) usava
la build di debug e non vale.

## Trovato e non fatto

- `%ar` e numstat restano al passo 3.
- LFS provato con un filtro `cat` in clean e smudge, non con il processo di `git-lfs`.
- CI: attesi 30 su 30 su Linux, 28 più 2 saltati con il motivo su Windows (symlink, bit di
  esecuzione).
- `cargo fmt --check` non disponibile: il componente `rustfmt` non è installato.

## Rifiutato

- Lo spawn di `git` dentro gix per trovare la config di sistema: in un processo isolato le chiamate
  a `git` sono state 0. Nessun ripiego aggiunto.
