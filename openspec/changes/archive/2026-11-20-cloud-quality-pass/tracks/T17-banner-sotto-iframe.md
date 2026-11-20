# T17 — il banner del bundle sotto l'iframe del browser, sul telefono: `usability-audit` «sidebar and the bundle banner»

**GOAL.** Il test cade al primo tentativo in OGNI corsa dal 07/10, in Chromium e in WebKit, e passa al
retry. Trova perché e correggi la causa giusta (nell'app o nel test, decidi con le prove).

- **Base:** `cloud/quality-pass-integrata` @ `5eb857502` più questo brief: ramo `cloud/t17-base`.
  Main per i confronti: `origin/main` @ `332e883bb` (il difetto c'è anche lì).

## Cosa si sa già (dal coordinatore)

- **Firma.** `tests/e2e/usability-audit.spec.ts:482`, gruppo `phone 390x844, touch`, passo «banner: bundle
  rebuilt»: due violazioni `target-covered`, `[data-testid="bundle-stale-reload"]` (48×18) e
  `[data-testid="update-banner-dismiss"]` (24×24), «centre answered by `[data-testid="browser-iframe"]`».
  Uguale in Chromium e WebKit, nello stesso shard.
- **Quante volte.** Main: 3 CI su 3 più recenti (37757736231, 37508090467, 37504718894) e le nightly del 07/10
  e dell'08/10; la nightly del 06/10 no. Integrazione: 4 corse su 4 (l'ultima 37773132103). Mai al retry.
- **I pezzi.** `client/src/components/Browser/hostedIframe.ts`: gli iframe del browser vivono in uno strato
  `position:fixed; inset:0; z-index:1` appeso a `document.body`, e un pane gli presta un rettangolo (il commento
  dice: le sovrapposizioni partono da 60, quindi vincono). `client/src/components/DevBundleToast.tsx` monta
  `SidebarUpdateBanner` (`client/src/components/Shared/SidebarUpdateBanner.tsx`): agganciato al numero di
  versione in fondo alla sidebar, altrimenti `fixed z-50`. Sul telefono il banner sta nella sidebar.
- **Ipotesi da provare per prima.** Una spec che gira prima nello stesso shard (un server e un DB per shard)
  lascia una tab browser aperta; al primo tentativo l'app la ripristina e il suo iframe, a z-index 1 sopra un
  banner che vive in un contesto di impilamento più basso, copre i bottoni. Al retry il ripristino è diverso.

## Le domande a cui il REPORT risponde

1. Quale spec lascia la tab browser (ordine dello shard: `scripts/e2e-plan-shards.ts`, log della CI).
2. **Un utente lo vede?** Sul telefono, con una tab browser aperta e un bundle nuovo, i bottoni del banner
   si toccano? Se no è un difetto dell'app, e si corregge l'app (il banner sopra lo strato, o l'iframe che
   non copre ciò che il suo pane non mostra), con una spec che lo dice. Se l'utente non può arrivarci,
   si corregge il test (stato isolato), e il REPORT spiega perché l'utente non ci arriva.
3. Perché al retry passa.

## Vincoli

- Niente retry, timeout alzati, `skip`, `fixme`. Non toccare la regola dello strato (mai spostare un iframe:
  il commento in testa a `hostedIframe.ts` dice perché) né il percorso nativo di Tauri
  (`lib/shell/browserOcclusion.ts`), a meno che la causa non stia lì.
- Le regole comuni di `_comuni.md`, compresi setup, barra comune e consegna. Codice e commenti in inglese.

## Barra

- **B1 riproduzione:** uno scenario che apre la tab browser come la lascia la spec che la lascia, poi il caso:
  rosso prima, verde dopo, N=10, `--retries=0`, in Chromium E in WebKit.
- **B2:** `usability-audit.spec.ts` intera ×3, `--retries=0`, verde dopo, nei due browser.
- **B3 mutazione** (copia scratch, mai il file vero): senza il fix, B1 torna rosso.
- **B4:** la barra comune di `_comuni.md`.
- **Prova visiva:** video prima e dopo in WebKit del banner sul telefono con la tab browser aperta.

## Consegna

Ramo `cloud/t17-banner-iframe`, REPORT in `openspec/changes/cloud-quality-pass/reports/T17.md`.

**FUORI.** Il server, la chat, la board, i workflow CI, `.bun-version`, le migrazioni.
