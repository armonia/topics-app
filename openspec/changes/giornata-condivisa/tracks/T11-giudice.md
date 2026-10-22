# T11 - Un giudice sulla consegna

**GOAL.** La consegna di una card passa da uno scorer che rifiuta i casi che i
cancelli deterministici hanno gia' lasciato passare.

## Perche' ora

I cancelli oggi sono deterministici (`checks-gate`, `ci-evidence`) e nient'altro
misura se il lavoro e' buono. L'indice di memoria del progetto e' un catalogo di
consegne che hanno superato i cancelli ed erano sbagliate:

- «consegna non pushata, CI verde su testa vecchia»: 2 card su 2 il 15/09, con
  `deliveryCommit` mai pushato;
- «verde su tree sporco»;
- «rail rosso su main: ogni card in review lo consegna come proprio»;
- «un giro ucciso viene riportato come rosso»;
- «static-rails della board non e' il passo omonimo della CI»: 11 comandi contro
  18.

Ognuna di queste e' un controllo certo, non un'opinione. Sono la lista di
partenza dello scorer.

## Cosa cambia

Un passo scorer nel giro review verso done, che gira **sulla consegna** e non sul
codice in generale. I controlli di partenza, tutti con una risposta binaria:

1. Lo sha consegnato e' uguale a `headRefOid` della PR.
2. Il rail rosso veniva da `main` prima della card, o l'ha introdotto la card.
3. Le tracce di `tasks.md` sono coperte dalla barra di `acceptance.md`.
4. Il giro di CI letto e' finito, non ucciso (exit 143 non vale per rosso).
5. L'albero da cui viene la misura era pulito.

Il resto si scrive dopo averli visti mordere: non si inventano controlli per
simmetria.

## Barra

- `bun scripts/delivery-score.ts` rifiuta una consegna con sha non pushato, e
  una con un rail rosso ereditato da main.
- Mutazione: far tornare uno `deliveryCommit` non pushato fa fallire lo scorer.

## Fuori

Un giudice a modello sul gusto del codice. Qui si verificano fatti, non stile:
una rubrica che sostituisce il giudizio con una tabella e' HERO-R.
