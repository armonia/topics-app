# Tasks: newtab-arc

- [x] T1 focus + elenco. Autofocus affidabile (anche con focus UrlBar nativa in
  gara), lista suggerimenti filtrata con sezioni. Barra: B1 verde in spec.
- [x] T2 sorgenti. Tab aperte (pane store), recenti/top (stesse di TabSheet),
  comandi esistenti. Barra: B2 verde in spec, niente duplicati.
- [x] T3 classifica + crea-file. URL/comando/file, nota .md nel progetto del
  topic + apertura editor. Barra: B3+B4 verdi in spec.
- [x] T4 spec + requisiti + gates. `NEWTAB-ARC-01..04` in specs (remote-browser
  o nuovo file), `@covers`, mutazione rossa, gates locali + CI verdi.

Note di chiusura (06/10/2026, branch `topics/newtab-arc`):
- T1: la sheet resta aperta come richiede TOPIC-BROWSER-02; il campo vince con
  una guardia su `focusin` (solo furti dalla sheet, ritirata al primo gesto).
- T2: "recenti" = pagine globali di `browserSiteHistory` (la cronologia della
  pane corrente è vuota per definizione); `Suggestion` estratto in
  `components/Shared/Suggestion.tsx` e riusato dalla sheet.
- T3: comandi in sola suggestione (l'esecuzione resta alla chat); senza
  `projectPath` la porta nota resta chiusa e il testo naviga.
- T4: requisiti in `openspec/specs/newtab-arc/spec.md` (file nuovo, non
  `remote-browser`); mutazione sempre-URL rossa su 03b+03c; chromium solo in CI
  (su questo Mac non c'è).
