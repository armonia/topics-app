# Tracce

Lo stato di una traccia lo dà git e il suo test, non una casella. Ogni traccia è una card della board e una PR. Regole in `proposal.md`, barre in `specs/acceptance.md`, mappa del codice in `../posta-per-gli-agenti-ricerca/mappa-topics.md`. Le tracce vanno in fila, una alla volta.

## E5 Invio di una mail una volta sola, anche se il server riparte
Regola P8. Usa il registro delle consegne del motore dei lavori programmati (T3, R23): stessi stati, stessa regola del riavvio. Chiave per chiamata, domanda di conferma come riga, invio dal server dopo la conferma, id del messaggio restituito.
Dipende da: T3 di `lavori-programmati-in-topics`.

## E1 Posta in entrata: caselle dichiarate e ricezione senza buchi né doppioni
Regole P1, P2. Impostazioni delle caselle (una lista per ricevere e inviare), contratto dell'adattatore con la sua serie di prove, adattatore di riferimento per Gmail, giro di ricezione, `mail_messages`, avvisi.
Dipende da: E5.

## E2 Aspettare una mail: una riga, una sveglia, una scadenza
Regole P3, P4, P5. `mail_waits`, `wait_for_mail`, abbinamento nella transazione della ricezione, sveglia per card e per chat, scadenza, annullamento.
Dipende da: E1.

## E3 Si vede quale mail si sta aspettando, e si può annullare
Regola P6. Card, chat, elenco, stati. A vista.
Dipende da: E2.

## E4 Leggere la posta senza passare dalla shell
Regola P7. `read_mail`, `search_mail`, cornice.
Dipende da: E2.

## E6 Regole automatiche sulla posta: avviso, card, bozza
Regola P9. Regole per casella, tre azioni, storia delle azioni. A vista.
Dipende da: E2.

## Fuori da questo repo
- Capire perché il lavoro ricorrente di `mailwatch` è diventato «una volta sola» il 13/11 e impedirlo: una card su una board esterna a questo repo.
- Riaccendere l'avviso delle mail importanti: aspetta la scelta del proprietario.
- Dichiarare le caselle di questa installazione: aspetta la scelta del proprietario.
