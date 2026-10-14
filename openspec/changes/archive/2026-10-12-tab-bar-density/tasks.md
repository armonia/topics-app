# Tasks — tab-bar-density

- [x] T1 `client/src/components/Layout/tabDensity.ts` (pura) + test. Barra: acceptance 1.
  Fatto: `tabDensity.test.ts` 8 pass / 0 fail (12/10); land in #285 (d2ba9d501, antenato di HEAD).
- [x] T2 PaneTabBar misura lo spazio DISPONIBILE (attenzione: la radice è `flex-initial` e si
  stringe al contenuto, misurarla è circolare: serve lo spazio del contenitore meno i fratelli,
  es. il menu +) e applica le larghezze; quadratino e compatta nel markup; congelamento alla
  chiusura. Barra: acceptance 2-4.
  Fatto: `availableTabWidth(bar, strip)` + ResizeObserver (PaneTabBar.tsx:109-124,832-850),
  `frozenDensity` alla chiusura (:500-510,866-893); e2e DENS-01..07 in `tab-bar-density.spec.ts`; land in #285.
- [x] T3 Cancelli e video. Barra: acceptance 5.
  Fatto: land in #285 con CI verde (typecheck:client, check:bloat, check:identifier-language);
  video DENS su CI della PR, non committato (test-results/ è gitignorato).
