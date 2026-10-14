# D7 · Affidabilità: nessun lavoro perso per un riavvio, uno sleep o un test instabile

Regole comuni: `tracks/_comuni.md`. Indipendente dalle altre tracce.

**GOAL.** Un riavvio del server, uno sleep del Mac o un crash del client non tagliano un turno e non
perdono una pane. Un test rosso vuol dire un difetto, non sfortuna.

## Da dove si parte

- **Riavvii.** Il server si riavvia spesso, con SIGTERM: almeno 12 riavvii dall'8 al 14/10 nel log di
  produzione.
- **Turni persi.** Il dispatcher scrive «spegnimento (SIGTERM): 1 card tagliata a meta' turno» due
  volte nello stesso periodo.
- **Già fatto, si protegge.** I turni della chat sopravvivono grazie al daemon staccato (ai-bridge).
  `chat-claude-code-parity` lo chiede come requisito protetto (punto 5, «Broker survival»).
- **Test instabili.** Le tracce T11 e T21 di `cloud-quality-pass` ne hanno censiti e curati due giri.
- **Pane.** `pane-store-server-authoritative` (6 compiti su 36 spuntati, ultimo commit 10/08)
  risolve le pane che riappaiono e quelle che spariscono.
  - Misurato là: una tab chiusa il 23/07 era ancora aperta su un telefono.

## Cosa si fa

1. **Card che sopravvivono al SIGTERM.**
   - Al riavvio, il dispatcher si riattacca al turno in corso invece di tagliarlo, come fa la chat.
   - Se riattaccarsi non si può, la card torna in coda con il motivo scritto. Non resta ferma a metà.
2. **Il client dopo un riavvio.**
   - Riconnessione e risincronizzazione senza ricaricare la pagina.
   - Lo stato delle pane segue `pane-store-server-authoritative`, che questa traccia porta a termine.
3. **Sleep e risveglio.**
   - Watcher, socket e bridge si riprendono da soli.
   - Si simula con SIGSTOP per 60 s, poi SIGCONT, sul server e sul bridge.
4. **Test instabili a zero.**
   - Stesso metodo di T11: la causa provata, non il retry.
   - Il censimento si rifà sulla CI degli ultimi 30 giorni.

## Barra

- **e2e con video (card).** SIGTERM al server mentre una card è a metà turno: dopo il riavvio il
  turno continua e la card arriva in review.
- **e2e con video (client).** SIGTERM al server con l'app aperta su un topic in streaming: il client
  si riconnette, il testo arrivato nel frattempo compare, nessuna pane cambia.
- **Mutazione.** In una copia si toglie la riattaccatura: l'e2e della card deve fallire.
- **Test instabili.**
  - Le spec censite girano 20 volte di fila in CI, con `--repeat-each=20 --retries=0`, e sono verdi
    20 su 20.
  - Il censimento dei rossi sulla CI degli ultimi 30 giorni non mostra nessun test rosso e poi verde
    sullo stesso commit.
- **Le barre di `pane-store-server-authoritative`**, così come sono scritte là.

## Fuori

Cambiare il modo in cui il server si riavvia: il riavvio frequente è un fatto, e la traccia lo
rende innocuo.
