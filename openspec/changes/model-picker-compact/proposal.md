# model-picker-compact — Selettore modelli compatto

## Perché

Lo screenshot del 06/10 mostra un pannello lenzuolo: sezioni sempre aperte,
ogni blocco con 2-3 righe di prosa (banda, Automatico). Su desktop il
selettore chiede pagine di scroll per cambiare azienda.

## Cosa cambia

- Le sezioni azienda diventano accordion veri: intestazione-bottone che
  apre/chiude, aperta di default la sezione della scelta corrente (la prima
  con Automatico). La ricerca apre tutto; pulendola torna il toggle.
- La banda va a una riga: solo cosa resta fuori («Gli altri vanno
  diretti»). Le righe «va diretto perché…» restano come sono.
- La frase di Automatico («Usa il predefinito: …») esce dal composer su
  desktop (resta descrizione accessibile); variante full e telefono la
  mostrano ancora.
- Finestre (200K), via-X, Precedenti, footer: invariati (dati, non prosa).
- Il layout `columns` morto esce da `ModelList` (prop, rami, test): una
  lista sola, niente rami (lo chiedeva anche il gate bloat: 846 > 800).

## Barra

Unit + typecheck + lint + gate verdi in locale; i 5 e2e del selettore verdi
su CI (su questo Mac non gira nessun browser: webkit assente, chromium
vietato); screenshot CI rivisti da me; mutazione sul default-aperto rossa.

## Fuori

Chip del composer (già h-8 a una riga); pagina «Provider e chiavi»;
colori, font, stile.

## Deciso da me

- L'intestazione è un bottone solo sulla prima riga, il motore ⌄ resta
  fratello sotto: niente bottoni annidati (axe `nested-interactive`).
- Hint Automatico in `sr-only`, non in `title`: la descrizione accessibile
  resta identica e i test a11y non cambiano.
- `routingLine` tagliata al solo «resta fuori», senza nuove chiavi: il COME
  (abbonamento, niente processo) esce, non si sposta.
- Stato aperto in memoria per apertura (come la scelta del motore), non
  persistito: meno stato, niente migrazioni.

## Deciso da Attilio (06/10)

Sezione aperta di default = quella della scelta corrente; con Automatico,
la prima. Base: PR244 (lista verticale + banda e hint compatti, serviti
alla sua CI) mergiata prima di questa.
