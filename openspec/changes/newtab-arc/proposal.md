# Proposal: newtab-arc

## Why

Attilio, 05/10/2026 (msg 3862, mai implementato): la scheda nuova deve fare come
Arc/Dia — scrivere subito, con autocomplete di tab aperte e ultime pagine, e
gestire URL, auto-suggerimento di comandi e creazione file (testo troppo lungo
= si sta creando un file). Oggi NewTabPage ha solo campo + top sites, senza
focus né suggerimenti.

## Cosa cambia (solo scheda nuova del browser, desktop e mobile)

- B1: focus subito nel campo all'apertura; digitando, elenco suggerimenti sotto.
- B2: sezioni: tab aperte del browser · recenti (storico) · top sites · comandi.
- B3: invio classifica: URL/navigabile → naviga (stessa regola `toNavigableUrl`);
  comando (`/...`) → esegue/suggerisce; testo lungo/multilinea → offre crea-file.
- B4: crea-file: nota `.md` col contenuto nella cartella progetto del topic
  corrente, aperta nell'editor; annullabile (bozza, non commit).

## Barra

`specs/acceptance.md`: e2e webkit+chromium su classificazione e sezioni.

## Fuori

- Barra indirizzi e TabSheet: restano come sono (condividono solo le sorgenti).
- Ricerca web: nessuna; i suggerimenti sono locali (tab, storico, comandi).
- Comandi nuovi: solo quelli che esistono già.

## Deciso da me

- «Troppo lungo» = multilinea o oltre 500 caratteri (documentato nel test).
- File = nota nella cartella progetto del topic corrente, aperta nell'editor.
- Stesse sorgenti di TabSheet (`chrome.history`, `rankSites`), niente copie.
