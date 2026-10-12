# Proposal: mobile-chrome-feedback

## Why

Attilio, 05/10/2026, provando Topics dal telefono (msg 3862, mai implementato):
la top bar deve rivelarsi allo scroll con le sessioni subito dopo la safe area,
il menu Topics deve stare nel menu utente per liberarla, la bottom bar ha tasti
piccoli con raggi e spaziature dubbi, il toggle Search è fuori distanza, Cerca
si apre su fondo grigio fuori design system, «In attesa» premuto non fa nulla.

## Cosa cambia (6 voci, tutte sotto 768px)

- A1 top: header mobile reveal-on-scroll; voce Topics dentro il menu utente
  (foglio esistente); sessioni/righe subito dopo la safe area, sotto allo scroll.
- A2 bottom: verifica e sistema geometria tasti — raggio concentrico primo/ultimo
  (Cerca, Profilo), aria sotto e ai lati, bilanciamento icona/label (PASSO/SOPRA).
- A3: toggle Search (Cerca) alla stessa distanza degli altri tasti.
- A4: Cerca mobile nel design system (stesso fondo della app, safe-area vera,
  nessuno stacco col notch).
- A5: «In attesa» sempre premibile: con coda va al prossimo (come oggi), a coda
  vuota apre la pagina In attesa (Now di Inbox) invece di restare morto.
- A6: pencil al centro: tap = nuova chat subito; long-press = menu «+» completo.

## Barra

`specs/acceptance.md`: e2e webkit 390x844 nuove misure + gates invariati verdi.

## Fuori

- Desktop e tablet: nessun pixel cambia sopra 768px.
- New-tab Arc/Dia: change separata (`newtab-arc`).
- Nuove voci di menu o stanze: si riusa solo ciò che esiste.

## Deciso da me

- Pencil centrale: tap nuova chat, long-press menu completo (non si perde il «+»).
- «In attesa» a coda vuota apre Inbox/Now, non un toast.
- «Tasti figli» interpretato come geometria/spaziatura (A2+A3), non nuove voci.
