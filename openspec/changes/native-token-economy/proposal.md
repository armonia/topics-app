# Proposal — native-token-economy

## Perché

Attilio, 11/10: «vorrei essere certo che il sistema non bruci token inutili, anche durante le start,
e vedo che il contesto si ottimizza troppo spesso». Misurato sul motore nativo lo stesso giorno:

- **Compattazioni troppo fitte.** Soglia 150k (0,75 di 200k), obiettivo 110k (0,55), ma nel log 182
  compattazioni con taglio medio del 15% (168k → 138k): si torna a ~120k e dopo ~30-40k di tool si
  ricompatta. Sulla chat 18b232ac cinque in 20 minuti. Ognuna cambia il prefisso, la cache salta e
  si riscrive l'intera storia (~110-125k a 1,25x).
- **Effetto sul conto.** Chat 18b232ac, 11/10, 4 turni: 6,3M token letti dalla cache, 1,21M
  riscritti, 442k in uscita. Le riscritture sono quasi tutte compattazioni (5 × ~115k).
- **Nessuna misura per giro.** Il DB tiene il totale per turno; il log di compattazione non dice
  nemmeno di quale chat è. Senza il giro non si può dire quanto costa l'avvio (sistema + tool) né il
  ritmo della cache.

## Cosa cambia

1. Una riga di log per giro del nativo: chat, giro, input nuovo, letti dalla cache, scritti in
   cache, uscita, compattato sì/no. La riga di compattazione porta la chat.
2. La compattazione compra più spazio per volta: soglia 0,85 quando la stima è calibrata sui
   conteggi veri dell'API (0,75 finché non lo è), obiettivo 0,40. Meno compattazioni, e ognuna
   riscrive una storia più corta. Un contesto pieno resta coperto da `recoverFromFullContext`.
3. `scripts/token-audit.ts` (sola lettura su log e DB): per chat, compattazioni/ora, quota di
   scritture dovuta alle compattazioni, costo del primo giro, chiamate ausiliarie (giudice degli
   obiettivi, nome automatico) per turno.

## Fuori

Il CLI di Claude Code (ha la sua compattazione), riassunto con un modello al posto del taglio
(seconda fase se i numeri lo chiedono), prezzi e quote.

## Deciso da me

0,85 / 0,40: con l'obiettivo a 80k ci sono ~90k di margine invece di 40k. Si perde più storia
vecchia per volta, ma è quella già alleggerita (risultati dei tool svuotati) e il modello la
rilegge se serve.
