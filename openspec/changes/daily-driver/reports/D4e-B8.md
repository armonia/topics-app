# D4e — B8, le azioni dell'agente: misurate, niente da togliere

## Barra

`browser/act` con p50 ≤ 500 ms nel log di produzione.

## Misura (log del server, 08-15/10)

- 59 chiamate a `browser/act`: p50 **26 ms**. Solo le 55 riuscite: p50 24 ms, p90 110 ms, massimo
  287 ms.
- I lenti sono 4 errori 500 da 3 a 17,8 s, tutti nello stesso minuto del 13/10 (23:37): un clic su
  una riga della board che non si assestava, fino al timeout di 15 s.
- I «3 s di p50» dell'audit del 14/10 non si ritrovano: la barra è già rispettata.

## Fatto

- Nessun cambio al codice.

## Trovato e non fatto

- Il clic che aspetta 15 s un elemento che non si assesta risponde 500 senza dire perché: sarebbe
  B9 (verifica dopo l'azione), non B8.
- Per B7: i `[LAG]` del loop principale sono scesi a 10 il 15/10 (62 il 14/10, 111 il 13/10). In
  molti il fermo è fuori CPU (per esempio 1.094 ms con 43 ms di CPU e 18 ms in coda): un'attesa,
  non un calcolo. Prima di spostare il mirror in un Worker va capito cosa aspetta il loop.

## Rifiutato

- Togliere attese «a occhio» dal percorso di `browser/act`: la misura non lo chiede.
