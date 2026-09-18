# Proposal: posta-e-google

## Da decidere

Topics impara a mandare posta e a leggere e scrivere su Google. Tre scelte prima del codice.

1. Un invio di un agente parte solo con la tua approvazione sulla card, una per messaggio (consigliata) · oppure libero verso una lista bianca di indirizzi.
2. La capacita' vive come strumenti per gli agenti delle card: `send_mail` e `google_call` (consigliata) · oppure anche un digest della board per posta, e allora dimmi ogni quanto.
3. Google passa da una porta sola `google_call <servizio> <risorsa> <metodo>` sopra `gws` (consigliata) · oppure strumenti separati per Calendario, Drive, Fogli.

«ok» = tutte le consigliate.

## Why

Il proprietario ha gia' messo la configurazione in `~/.topics-server-env` (non tracciato, sorgiato da
`start-prod.sh`): CLI della posta e account, mittente, la casella Exchange, e per Google la CLI, la
cartella di configurazione e il client OAuth gia' esistente, di tipo installed con redirect su
localhost. Il trasporto e' deciso e non si riapre: si passa dalla CLI `gws-mail` via shell, niente
SMTP e nessun servizio terzo, perche' la CLI e' gia' autenticata sui tre account, funziona
nell'ambiente minimo di launchd, il mittente resta un indirizzo vero e non aggiunge spesa.

Oggi un agente che lavora una card non puo' ne' mandare un messaggio ne' leggere un calendario: ogni
cosa che esce da Topics passa da una persona che copia e incolla.

## What Changes

1. **Configurazione solo da `process.env`.** Nessun indirizzo, account o percorso scritto nel codice:
   il repo e' pubblico e GATE-07 (`tests/unit/no-third-party-emails.test.ts`) blocca un indirizzo su
   dominio pubblico in un file tracciato. Variabile mancante = errore che dice quale manca e dove si
   scrive, mai un ripiego silenzioso su un account diverso da quello voluto.
2. **`send_mail`**: destinatario, oggetto, corpo, account scelto fra quelli dichiarati in
   `TOPICS_MAIL_ACCOUNTS` (compresa la casella Exchange, che ha una CLI sua), allegati dal workspace
   della card. Passa dalla CLI, con l'ambiente del server. I nomi degli account non si scrivono qui:
   il repo e' pubblico e uno di quelli e' il nome utente della macchina.
3. **`google_call`**: una porta sopra `gws` per Drive, Calendario, Fogli, Documenti, Attivita' e
   Contatti, con i parametri come JSON e la risposta come JSON.
4. **La traccia sulla card.** Ogni invio e ogni scrittura su Google lasciano un commento di servizio
   con chi, cosa, a chi e l'esito: un'azione che esce da questa macchina non puo' vivere solo in un log.

## Non-Goals

- SMTP, Resend, SendGrid o qualunque altro trasporto: deciso, chiuso.
- Un client OAuth nuovo: quello che c'e' e' della forma giusta e si riusa.
- Il login Google degli utenti dentro Topics: e' un'altra change, e oggi nessuna card lo chiede.
