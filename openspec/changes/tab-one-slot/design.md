# Design: tab-one-slot

## Le zone

Una tab (`PaneTabBar.tsx`, larga fissa: 150, browser 200/300) ha tre zone, in
quest'ordine, separate dal `gap-2` (8 px) della riga:

| Zona | Larghezza | Cosa |
|------|-----------|------|
| Icona | fissa per tipo (14, browser 16, chat 0) | glifo del tipo, favicon del progetto o del sito, con UN segno d'angolo largo zero |
| Nome | `flex-1 min-w-[56px]`, tronca | `TabLabel`: il nome, e nel tooltip consumo e tempo |
| Slot | 20 px, sempre riservato, ultimo | `TabSlot`: un segnale a riposo, un comando al passaggio |

Misura su WebKit (chat, 150 px): nome x=8 w=106, slot x=122 w=20, identici a
riposo, al lavoro, con attenzione, al passaggio e da fermata. Progetto con tutti
i segnali: nome x=30 w=84.

## La macchina a stati dello slot

Due funzioni pure in `client/src/lib/tabSlot.ts` (test: `tabSlot.test.ts`).

A riposo, `tabSlotSignal({ frozen, working, attention })`:

```
frozen                      -> freeze     (fiocco, SwapFreezeLabel variant="glyph")
working && attention > 0    -> working    (anello da 20 attorno al numero)
working                     -> working    (il loader del tipo: Topic/Project/Terminal/BrowserStreamingSpinner)
attention > 0               -> attention  (NotificationBadge)
altrimenti                  -> none
```

Al passaggio del mouse o col fuoco da tastiera (`:has(:focus-visible)`),
`tabSlotCommand({ canStop, closable, isProject })`:

```
canStop && !isProject  -> stop   (pane-tab-stop, stesso onStopStreaming del compositore)
closable               -> close  (pane-tab-close, PendingActionRing col conto alla rovescia)
altrimenti             -> nessun comando
```

`canStop` legge `useTopicLoading`: fermato il turno torna falso e lo stesso slot
diventa Chiudi. Lo slot e' centrato sulla colonna del glifo di comando (16 px,
che finisce a `ROW_PX` dal bordo come sulla riga, CHROME-05): sta a 6 px dal
bordo, 2 dentro il padding, cosi' segnale e glifo hanno lo stesso centro
(CHROME-04). La scatola condivisa `ROW_ACTION_BOX` (28, 36 col dito) sborda
dallo slot, mai sul nome; con la 36 resta a filo del bordo e il glifo cade a
10 px, lo stesso residuo della riga. Col dito (`not (hover: hover)`) il comando sta
sulla tab selezionata (`data-active="true"`); un conto alla rovescia in corso
(`data-pending`) lo tiene acceso ovunque sia il puntatore. Regole in
`index.css`, blocco «ONE TAB, THREE ZONES».

Per tipo, chi dice «lavoro»: chat `useTopicLoading || useTopicBackgroundWork`;
progetto le stesse aggregate, spente se la tab e' selezionata; terminale
`useTerminalLoading`; browser `useBrowserLoading`; board le card in corso (e
l'attenzione sono le card in review, `useBoardTabCounts`).

## Cosa e' andato dove

| Prima (in fila fra nome e bordo) | Adesso |
|---|---|
| NotificationBadge, loader, SwapFreezeLabel compatto | slot |
| BoardTabCounts (glifo + numero per stato) | slot: review = numero, in corso = anello; conteggi esatti nel title (`useBoardTabCounts`) |
| marcatore di progetto `tab-project-marker` | icona di tipo progetto se manca la favicon, altrimenti segno d'angolo |
| SharedOrgBadge `pane-tab-shared-org` | segno d'angolo, vince sul marcatore |
| BrowserTabConsoleCue | pallino rosso sull'angolo della favicon |
| BrowserTabDownloadsCue (segnale + bottone) | conteggio sui tre puntini, che con download aperti aprono il foglio sui Download |
| tre puntini del browser nel binario | `.tab-extras`: al passaggio, sopra la coda del nome (sfumata), a sinistra dello slot |
| spillo `tab-pinned`, globo `tab-spawned-browser`, cloud `tab-cloud` | nome accessibile della tab (`aria-label`) |
| SessionElapsed / ProjectElapsed (`tab-elapsed`, `project-elapsed`) | tooltip del nome, calcolato quando arriva il puntatore |
| PaneTabCommands, StopTurnButton, `rowCommandSequence` sulla tab | `TabSlot`; `rowCommandSequence` resta alla sola riga di sidebar |

La riga di sidebar non cambia.

## Fuori

- `BrowserTabTypeIcon` (connessione assente, Chromium vero, condiviso) resta in
  fila fra favicon e nome: e' nella zona icona, ma compare e sparisce, quindi su
  una tab browser il nome si sposta ancora quando cambia quel tipo.
