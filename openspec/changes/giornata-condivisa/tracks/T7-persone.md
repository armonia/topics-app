# T7 - Condiviso con persone, non con dispositivi

**GOAL.** Si invita una persona per email, entra con un ruolo, vede chi altro
guarda, non vede segreti, e di cio' che ha fatto resta traccia attribuibile.

## Perche' ora

Le fondamenta sono quasi finite e inutilizzate. Su `origin/main`: `device-auth`
19/20, `sharing-orgs` 29/30, `relay` 18/24. Sul DB vivo: 3 persone, **0
amicizie, 0 follow, 3 grant, 1 task condiviso, 0 link creati**. A fronte di
`routes/people.ts` 616 righe e `Profile` 1.376 righe nel client.

Topics e' **oltre lo stato dell'arte** sul modello: link come capacita' con
chiave nel frammento, scadenza obbligatoria, revoca immediata, piu' severo del
default di Figma; `grants` read/comment/edit su device, person e org con deny
prioritario. Mancano cinque pezzi, ognuno con un fallimento nominabile.

1. **Non si puo' invitare.** `people.email` esiste, ma la migration 084 dice da
   se' che «invitare significa aspettare che il telefono altrui faccia
   pairing». Le due strade oggi sono «stagli accanto» o «un link anonimo che
   chiunque nella chat puo' aprire».
2. **Il link non porta un ruolo.** `share_links` ha `ref`, `key`,
   `resource_type`, `resource_id`, `expires_at`, `revoked_at`, `opened_count` e
   nessun livello, mentre la scala esiste su entrambi i lati (`guestLevel.ts`,
   `meetsLevel`). Quindi «guarda e commenta» e «leggi e basta» sono la stessa
   cosa.
3. **La presenza e' delle finestre, non delle persone.** `server/presence.ts`
   ricostruisce le finestre del proprietario. Si condivide un task, l'ospite lo
   apre, e nessuno dei due lo sa.
4. **L'ospite legge la riga grezza.** Un `read` su un task consegna cio' che
   l'agente ha stampato: variabili d'ambiente e token compresi.
5. **L'audit non esiste in pratica.** `activity_log` c'e' dalla 001 con un
   writer, ma `actor` e' TEXT libero senza FK a `people`. Dopo una revoca non si
   puo' rispondere a «chi ha fatto cosa».

## Cosa cambia

1. Un token d'invito legato a un'email che alla **prima** apertura lega il
   dispositivo a quella riga `people` e poi muore. Il link diventa un'identita'
   invece di restare una capacita' permanente.
2. Colonna `level` su `share_links` con lo stesso CHECK di `grants`, scelta nel
   cartello di creazione accanto a scadenza e revoca. Il grant che nasce dal
   link eredita quel livello via `via_type`/`via_id`, che esistono gia'.
3. Presenza delle persone sul canale effimero, non su quello durevole:
   coalescata, senza persistenza.
4. Il percorso di lettura dell'ospite restituisce una **proiezione**: scrub per
   pattern dei segreti noti, come fa gia' `push-guard`, piu' un marcatore
   «questo turno contiene un segreto e non e' nel link».
5. `person_id` e `device_id` con FK su `activity_log`, scritti negli otto punti
   dove si decide qualcosa: grant dato, grant revocato, link creato, link
   aperto, agente avviato da un ospite, strumento approvato.
6. Il testimone sul turno, deciso il 22/10: un
   solo scrittore per volta e passaggio esplicito, con il passaggio visibile.

## Barra

- Lo scenario 2 di `specs/acceptance.md`, con video: invito, lettura, scrittura
  nel ruolo, revoca entro un frame, e nessun segreto nel transcript visto.
- `level` sul link con il CHECK, e il grant che lo eredita.
- `activity_log` con le FK, e un test che conta le scritture negli otto punti.
- Mutazione: far scadere un link senza revocare il grant che ne nasce fa
  fallire lo scenario.

## Fuori

Account in cloud con password. Crittografia end-to-end dei permessi: Jazz v2 l'ha
spostata sul server perche' in crittografia non regge il prodotto.
