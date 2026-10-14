## Regole comuni a tutte le tracce di daily-driver

**Setup, barra di base e recinto** sono quelli di `../../cloud-quality-pass/tracks/_comuni.md`
(sezioni «Setup», «La barra», «Recinto»), con le differenze di questa pagina. Leggili prima di
partire. Se non riesci a leggerli per intero, fermati e dillo.

### Differenze rispetto a cloud-quality-pass

- **Qui si aggiungono funzioni.** D4, D5 e D6 portano funzioni nuove. Il recinto vale per tutto il
  resto: niente rinomine o riformattazioni in blocco, nessun cambio di stack fuori dalla traccia.
- **Dipendenze nuove solo con il perché nel commit**, con il nome e la licenza. D3 introduce
  `napi-rs`, `gix` e `ignore` (MIT o Apache-2.0).
- **Dove gira:**
  - in cloud o in CI tutto ciò che è codice e test;
  - sul Mac solo le misure che chiedono l'app vera (`scripts/measure-webview.sh`, le misure della
    baseline sul log di produzione) e il porto in produzione;
  - sul Mac, mai suite e2e intere né build ripetute.

### La prova

Una traccia è finita quando la sua barra esce 0, e lo dice il comando, non una casella.

Per un comportamento serve uno scenario spec-flow con il video: il `.webm` del test è la prova.

Sul punto critico serve una mutazione, fatta in una copia e mai nel file vero: il test deve
diventare rosso. Un test che non è mai stato visto fallire non è un test.

### Consegna

1. **Ramo e REPORT.**
   - Il ramo è `daily/<id-traccia>`, partito da `origin/main`.
   - Il REPORT va in `reports/<id>.md`: barra prima e dopo, con i numeri.
2. **Revisione.** Una revisione indipendente: chi ha scritto non verifica.
3. **Merge.** PR, CI verde, merge.
4. **Porto in produzione.**
   - Si porta per file con `topics-port-merge.sh`.
   - **Mai un merge dentro il checkout di produzione.**
   - Le migrazioni si provano prima su una copia del db.
5. **Il numero vero.** Per le tracce di velocità: lo stesso script della baseline sul log di
   produzione, 24 ore dopo il porto.

### Lingua

- Identificatori e commenti in inglese: lo controllano `check:identifier-language` e
  `check:comment-language`.
- Testi dell'interfaccia in italiano, senza il trattino lungo: lo controlla `check:emdash`.
