# Acceptance: infinite-scroll

Ciò che è verde resta verde: le e2e della chat (`chat-tail-first`, `chat-history-window`,
`history-page-budget`, `tab-switch-instant`, `chat-compact-drain`), `bun run typecheck`, i `check:*`.

## Chat (CHAT-HIST-01)

`tests/e2e/chat-infinite-scroll.spec.ts`, Chromium e WebKit, video:

- **GIVEN** una chat di tre pagine aperta sulla coda
- **WHEN** chi legge risale con la rotella, a vista ferma dopo ogni colpo, e attraversa la fusione a passi di 12 px
- **THEN** il resto arriva senza click, con una richiesta sola
- **AND** nel fotogramma della fusione le righe si spostano al più del passo, nei fotogrammi dopo di 0 px (± 1 px)
- **AND** nessun fotogramma campionato (rAF) resta senza righe; CLS ≤ 0,01 dove misurabile (Chromium)
- **AND** scorrendo ancora si arriva al primo messaggio

`tests/e2e/chat-tail-first.spec.ts`: chi arriva in cima prima della rete trova la riga in attesa
(`aria-busy`) e il resto entra da solo, la riga letta spostata al più dell'altezza della riga.

Da aggiungere con la riprogettazione, ognuno rosso sul bundle di oggi:

- risalendo con la tastiera (Pagina su, freccia) e con Home, la riga letta non si sposta oltre il
  passo nel fotogramma della fusione e resta ferma dopo;
- con la scheda della chat nascosta mentre la richiesta è in volo, tornando alla chat la riga letta
  è dove era;
- dopo la fusione il contatore «↓ N» non conta le righe aggiunte in cima.
