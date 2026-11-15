---
version: alpha
name: Topics
description: "App di lavoro di Attilio con gli agenti: chat, board dei task, browser, terminali e tray. Densa, calma, si usa tutto il giorno."
colors:
  primary: "#0066ff"
  primary-hover: "#0052cc"
  primary-ink: "#1447e6"
  background: "hsl(220 5.6% 96%)"
  surface: "#ffffff"
  surface-elevated: "hsl(220 4.9% 98.1%)"
  chrome: "hsl(220 5.6% 93%)"
  border: "hsl(220 4.9% 91.4%)"
  text: "hsl(220 3.5% 10.6%)"
  text-secondary: "hsl(220 2.8% 36.4%)"
  text-muted: "hsl(220 2.8% 42.5%)"
  success: "#10b981"
  warning: "#f59e0b"
  on-primary: "#ffffff"
typography:
  mini:
    fontFamily: system-ui
    fontSize: 11px
    lineHeight: 1.4
  compact:
    fontFamily: system-ui
    fontSize: 12px
    lineHeight: 1.4
  prose:
    fontFamily: system-ui
    fontSize: 13px
    lineHeight: 1.55
  title:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.3
  headline:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
  display:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "\"tnum\""
  mono:
    fontFamily: JetBrains Mono
    fontSize: 12px
    lineHeight: 1.5
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary-ink}"
    textColor: "{colors.on-primary}"
    typography: "{typography.compact}"
    rounded: "{rounded.sm}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.mini}"
  chrome-bar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
---

# Topics

I valori veri stanno in `client/src/index.css` (`:root` per il chiaro, il blocco scuro subito
sotto), con la scala dei testi commentata riga per riga e `client/src/styles/contrast-tokens.test.ts`
come barra del contrasto. Se questo file e il CSS non coincidono, vince il CSS e questo file si
riallinea. I componenti stanno in `client/src/ui/`, la galleria in `client/src/ui-gallery/`.

## Overview

Uno strumento da tenere aperto tutto il giorno, non una vetrina: denso, sobrio, veloce. Le
superfici sono grigie e neutre, il blu dice «questo si può fare» e niente altro. Chi lo usa deve
capire a colpo d'occhio cosa sta succedendo e perché, senza aprire un log.

## Colors

Grigi neutri leggermente freddi (tinta 220) su tre piani: chrome della finestra, sfondo,
superfici. Un accento solo, il blu; verde e ambra solo per stati (riuscito, attenzione). Il tema
scuro ha gli stessi ruoli con valori suoi, mai il chiaro invertito.

## Typography

Font di sistema, un solo mono (JetBrains Mono) per codice e terminali. La dimensione di default
dell'interfaccia è 11 px (righe, etichette, menu, chip); 13 px per la prosa dei messaggi. Ogni
dimensione ha un ruolo scritto nel CSS: un valore fuori scala si aggiunge lì, mai a mano.

## Layout

Sidebar, pannelli affiancati e tab; sul telefono una colonna con la barra in basso. Ogni
pannello si apre già al suo primo frame giusto, senza salti.

## Elevation & Depth

Piatta: bordi sottili e piani di grigio. Ombra solo su menu, popover e modali.

## Shapes

Raggio 8 px per pannelli e card, 6 px per bottoni e campi, 4 px per chip piccoli.

## Components

Righe dense di lista, card della board, chip di stato, tab, tendine, modali, la tray della
barra dei menu.

## Do's and Don'ts

- Do: ogni funzione ha la sua interfaccia, interruttore più stato (cosa fa adesso e perché).
- Do: ogni numero ha accanto il valore e una frase; lo calcola un posto solo e ogni superficie
  lo legge da lì.
- Do: i nomi visibili (sessioni, card, righe della tray, cron) dicono il lavoro in parole
  semplici.
- Do: ciò che Attilio deve giudicare si vede dentro Topics, nel task, con immagini grandi.
- Don't: id, nomi di file o comandi nei titoli.
- Don't: una funzione che esiste solo come variabile d'ambiente o riga di log.
- Don't: rifare ciò che non è stato segnalato.

## Riferimenti

- Micro-interazioni e componenti: Bruno Delorence (<https://brunodelorence.com/components>).
- Lo studio di 31 concorrenti in `docs/competitors/`, per i flussi.

## Approvato, non toccare

- La barra della tray («perfetta», 23/10): si lavora solo sul menu a tendina se segnalato.
- La scala dei testi e i token del CSS: si aggiungono ruoli, non si spostano valori.

## Feedback di Attilio

- 04/08 «così come tutto, deve avere interfaccia di gestione / abilitazione ad hoc con ottima
  UI/UX» → interruttore più stato, calcolato dallo stesso codice del comportamento.
- 23/10 «se questo è il criterio con cui migliora c'è da preoccuparsi» (rifatta la barra della
  tray che era perfetta) → due liste: segnalato e approvato.
- 24/10 «non è spiegato, non c'è nulla… avevo chiesto che fosse consistente e sensato» → tray e
  hub con gli stessi numeri, colori e frasi, più un valore complessivo.
- 24/10 sui nomi nella tray («auto-2» nell'hub) → i nomi dicono il lavoro.
- 11/11 «non dovresti farla tu ma dovrei vederla da topics» → la consegna è il task di Topics,
  non un prototipo o foto in chat; se Topics non le mostra bene, quello è il primo lavoro.
- 12/11 tray bocciata dopo un «prima/dopo» identico → due immagini uguali vogliono dire che la
  versione nuova non è stata catturata.
