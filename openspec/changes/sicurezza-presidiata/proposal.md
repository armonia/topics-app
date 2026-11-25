## Da decidere

Niente da decidere: è la tua richiesta del 21/11, le scelte tecniche sotto le ho prese io.
Oscurare da qui in avanti (T5) non ripara un segreto già uscito: quello si ruota, ed è un gesto fuori da questa change.

---

# Sicurezza presidiata: Topics guarda ogni server e nodo, lo mostra dove stanno, e chiama qualcuno quando diventa rosso

## Perché

Topics misura già la sicurezza di ogni macchina (MACHINE-05: aggiornamenti, disco, accessi e porte a rischio, antivirus, più l'esposizione vista da fuori) e `check:security` controlla segreti e dipendenze in CI. Tre buchi rendono quella misura una vetrina e non un presidio:

1. **Nessuno la vede dove servirebbe.** Lo stato finisce in `~/.topics/machines-health.json` e lo legge solo la tray. Nell'app le righe dei nodi (Dispositivi, Impostazioni → Macchine) mostrano il pallino online e basta: il client non riceve lo stato di sicurezza.
2. **Nessuno viene avvisato.** Un check che diventa `problem` resta nel file. Il 21/11 il Mac ha un aggiornamento di sicurezza in attesa da 11 giorni e nessuna card lo dice.
3. **Gli avvisi nuovi non arrivano.** `bun audit` gira solo quando qualcuno pusha: una vulnerabilità pubblicata stanotte su codice fermo resta invisibile fino al prossimo push. E un server che non è un nodo Topics non è misurato affatto.

In più un buco vero nel prodotto: **i segreti passati negli argomenti di un comando vengono salvati nel DB e rimandati al modello** (visto il 14/09 con `sshpass -p`). In `server/` non esiste nessuna oscuratura.

## Cosa cambia

- **T1 · Vista.** Il server espone l'ultimo giro di MACHINE-05 al client. Ogni nodo, nel menu Dispositivi e in Impostazioni → Macchine, ha accanto il suo segno di sicurezza (scudo colorato dal peggiore dei check, con l'età della misura) e nel suo menu i quattro check con la loro frase. MACHINE-09.
- **T2 · Avviso.** Un check che passa a `problem`, o resta `warn` oltre 24 ore, apre UNA card per (macchina, check) con chiave stabile, sulla board scelta nelle impostazioni; la card si chiude da sola quando il check torna `ok`. Niente doppioni, niente card per `unknown`. MACHINE-07.
- **T3 · Server senza Topics.** Un server registrato nelle impostazioni (host, utente SSH; nessun nome nel codice) viene misurato via SSH in sola lettura con gli stessi parser di MACHINE-05. MACHINE-08.
- **T4 · Aggiornato da solo.** Un giro quotidiano rilancia l'audit delle dipendenze su main anche senza push; un avviso nuovo, non accettato nella baseline, fa rosso e apre la card come T2. Sui server Linux, `reboot-required` presente da oltre 24 ore è `warn` (l'autopatch non ha riavviato). SEC-01.
- **T5 · Segreti oscurati.** Argomenti e output dei tool vengono oscurati PRIMA di essere salvati e rimandati al modello (password in `sshpass -p`, `--password`, `Authorization: Bearer`, chiavi private, token noti). Le righe già salvate si ripuliscono una volta, dopo un backup del DB. SEC-02.
- **solido** ha la parola «Sicuro» con la sua prova (fatto il 21/11, commit `b22b7ea` in `~/.claude`).

## Barra

`specs/acceptance.md`: un comando per traccia che esce non zero, lo scenario spec-flow con video per T1 e T2, una mutazione sul punto critico di T2 e T5. Ciò che è verde resta verde (`check:security`, `check:deadcode`, `check:bloat`).

## Fuori

Scansioni attive o intrusive (nmap aggressivo, exploit), antivirus nuovi, modifiche automatiche alla configurazione dei server (l'autopatch esiste già e resta com'è), notifiche fuori da Topics oltre alla card e alla «Ti aspetta» per ciò che solo una persona può fare, la rotazione delle password.

## Deciso da me

- Card e non notifica come avviso di base: la card ha chi la lavora e si chiude da sola; «Ti aspetta» solo se serve un gesto umano (un login, un riavvio di una macchina fisica).
- SSH in sola lettura per i server senza Topics, invece di installare Topics su ogni server: zero software nuovo sui server che non sono nodi.
- Oscuratura con un elenco di regole chiuso e testato (stile gitleaks), non un modello: deterministica e misurabile.

## Non ancora specificato

- Se e come vedere la sicurezza dei telefoni accoppiati (oggi non hanno sonde).
- Una fonte di avvisi per il software di sistema dei server oltre ai pacchetti della distribuzione (es. Bun, OpenSSH compilati a mano): oggi non so dire se esista un caso reale.
