# D8 · Sicurezza del browser: tracce riservate finché non sono chiuse

Regole comuni: `tracks/_comuni.md`.

**GOAL.** I problemi di sicurezza trovati dall'audit del browser del 14/10 sono chiusi in
produzione, ognuno con un test che era rosso su main prima della correzione.

## Perché i dettagli non sono qui

Il repository è pubblico. Descrivere un problema aperto vuol dire spiegare a chiunque come usarlo
prima che sia corretto.

Le tracce R1, R2 e R3 sono descritte in una nota privata del proprietario, con la prova, il rimedio
e la barra di ciascuna. Quando una è chiusa e la correzione è in produzione, la sua descrizione entra
qui insieme al commit che la chiude.

## Cosa è già a posto

Restano coperte dai loro test:
- il controllo dell'origine sui WebSocket;
- gli ospiti esclusi dal browser;
- la guardia sulla porta CDP del sidecar;
- gli schemi permessi alla navigazione;
- i file di stato con permessi 0600;
- il replayer senza script;
- `file://` servito solo da allowlist con `CSP: sandbox`.

## Barra

```bash
bun run check:security                 # esce 0, come oggi
```

- **Le barre di R1, R2 e R3**, scritte nella nota privata: escono 0, e ognuna è stata vista
  fallire su main prima della correzione.
- **Ordine.** R2 può partire subito. R1 e R3 aspettano il merge del ramo
  `topics/browser-mac-scroll-mirror`; R1 va subito dopo il passo B1 di D4.
- **Revisione.** Una revisione indipendente rilegge ogni correzione prima del merge.
