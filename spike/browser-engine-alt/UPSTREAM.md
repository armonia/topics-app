# Obscura — come ci teniamo attaccati a upstream senza forkarlo

> Decisione del 2026-08-19. Il perché sta in `EVALUATION.md`; qui c'è la **meccanica**.

## La regola

**Non abbiamo un motore nostro e non abbiamo un fork.** Puntiamo al `main` di
[obscura](https://github.com/h4ckf0r0day/obscura) e ci appoggiamo sopra una pila di patch
in `patches/`. A ogni aggiornamento **scarichiamo gratis il lavoro degli altri** e
paghiamo solo per le righe che abbiamo scritto noi.

L'aritmetica che decide: Obscura è **138 000 righe**; la nostra patch è **143**. Un fork
ci farebbe mantenere le prime per portarci dietro le seconde. Upstream le mantiene per
noi.

## Il rischio, e come lo teniamo sotto controllo

Lo schema "patch appoggiate" ha **un solo** modo di rompersi: upstream tocca le stesse
righe e la patch non si applica più. Non è un rischio da sperare che non capiti, è un
rischio da **misurare**:

```bash
bun run obscura:check     # esce non-zero se una patch non regge più
```

Tre esiti, tutti e tre provati:

| esito | significa | cosa fare |
|---|---|---|
| `OK` | la patch si applica sull'upstream corrente | niente |
| `CONFLITTO` | upstream ha toccato le stesse righe | riscrivere la patch |
| `LANDED` | upstream **contiene già** le nostre righe | **cancellare** la patch |

`LANDED` è il caso lieto ed è il motivo per cui esiste il rilevamento: una patch mergiata
upstream che restasse in `patches/` fallirebbe al prossimo giro, e sembrerebbe un guasto
invece di una vittoria.

Quanto è concreto il rischio, misurato sul passato: `bootstrap.js` ha **234 commit** e
cambia in media **65 righe per commit** — è un file vivo. Ma `stroke()` e
`createLinearGradient` **non li ha toccati nessuno dall'initial release**. Stiamo
patchando una zona morta di un file vivo: è la condizione migliore possibile, e il check
ci avvisa il giorno in cui smette di esserlo.

## Uso

```bash
bun run obscura:status    # dove sta upstream, cosa abbiamo di nostro
bun run obscura:check     # gate: le patch reggono ancora? (per la CI)
bun run obscura:build     # clona/aggiorna, applica la pila, compila il binario
```

Il checkout vive in `~/.cache/topics/obscura-src` (`OBSCURA_WORKDIR` per spostarlo) e
viene **resettato duro a ogni run**: l'albero è usa-e-getta, la verità sta in `patches/`.
La prima build richiede ~15-20 minuti perché V8 compila da sorgente; poi è in cache.

## Ciclo di vita di una patch

1. **`pending`** — l'abbiamo scritta, non l'abbiamo ancora proposta.
2. **`proposed`** — PR aperta upstream, il campo `pr` nel manifest porta l'URL.
3. **`landed`** — mergiata: si cancella il file e si toglie la voce dal manifest.

Lo stato sta in `patches/manifest.json` insieme al **perché** della patch, che è la parte
che si dimentica per prima.

## Perché questo schema regge (e non è ottimismo)

- **Ci leghiamo a un protocollo, non a un codice.** Obscura è un eseguibile che parla CDP
  su una porta: la stessa interfaccia che Topics usa già per Chromium. Se il progetto
  muore, si torna indietro cambiando un endpoint.
- **Le PR esterne passano.** 85% dei PR chiusi vengono mergiati, mediana **4.9 ore**.
  Mandare upstream non è una scommessa.
- **La patch è l'assicurazione.** Se upstream rifiutasse o sparisse, `obscura:build` la
  riapplica e ricompila senza dipendere da nessuno.
- **Apache-2.0 senza CLA.** Quello che è già stato concesso non si può revocare: nel
  peggiore dei casi resta l'ultima versione buona, ed è nostra da usare.
