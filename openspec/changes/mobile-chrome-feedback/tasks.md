# Tasks: mobile-chrome-feedback

- [x] T1 top reveal + menu. Header mobile si compatta/rivela allo scroll, righe
  da dopo la safe area; voce Topics nel foglio utente. Barra: A1 verde in spec.
- [x] T2 geometria bottom. Raggi/aria/bilanciamento in MobileChromeBar+safeAreaArc.
  Barra: A2+A3 verdi in spec, ui-audit senza misalign nuovi.
- [x] T3 Cerca nel design system. Fondo/safe-area della palette mobile.
  Barra: A4 verde in spec.
- [x] T4 In attesa + pencil. Tasto sempre vivo (zero → Inbox/Now); pencil centrale
  tap/long-press. Barra: A5+A6 verdi in spec.
- [x] T5 spec + requisiti + gates. `specs/mobile-chrome/spec.md` (MOBILE-CHROME-07..12),
  `tests/e2e/mobile-chrome-feedback.spec.ts` con `@covers`, mutazione rossa,
  gates locali + CI verdi.
