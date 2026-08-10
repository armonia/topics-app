# Licenze — la chiave, dove vive, come si conia

Questo documento risponde a una domanda sola: **dove sta il segreto con cui
firmiamo le licenze, e cosa succede a chi paga se lo perdiamo o lo lasciamo
uscire.**

## La coppia

Le licenze sono gettoni Ed25519. La coppia è nata il 2026-08-10, `kid`
`armonia-1`.

- **La pubblica** è nel sorgente, in `server/lib/licenza.ts` → `CHIAVI_INTEGRATE`.
  Ci sta perché è pubblica: serve solo a *controllare* una firma, non a farla.
  Finché quella lista è vuota, `verificaGettone` risponde `no_verification_key`
  prima ancora di guardare la firma, e **ogni installazione spedita resta sul
  piano gratuito qualunque gettone le si dia** — un'app che non vende.
- **La privata** non è in questo repository, in nessuna forma, mai. Non è nemmeno
  nella cronologia: `scripts/licenza.ts chiavi` la stampa a schermo e non la
  scrive da nessuna parte apposta.

## Dove vive la privata

Due copie, e nessuna delle due è un file nel repo.

1. **La copia durevole: il gestore di password** (1Password, voce «Topics —
   chiave licenze `armonia-1`»). È quella che sopravvive a un disco che muore, e
   l'unica che vale se un giorno la macchina di chi conia non è più questa.
2. **La copia di lavoro: `~/.topics/signing/licenza-privata.key`**, permessi
   `0600`, accanto al certificato di firma dell'app (`topics-signing.p12`) — che
   è già il posto dove vivono i segreti di rilascio di questo progetto, e quindi
   non ne inventa uno nuovo. È comodità, non archivio: se sparisce si rimette dal
   punto 1.

Cosa NON è un posto dove vive: un `.env` del progetto, una variabile in CI, un
allegato su una board, un messaggio. `TOPICS_LICENSE_PRIVKEY` esiste per passarla
al comando che conia — si legge dal file al momento (`$(cat …)`) e non si scrive
in nessun profilo di shell.

Chi ha la privata può emettere una licenza `team` per qualunque installazione.
Non c'è revoca: un gettone emesso vale fino alla sua scadenza. È per questo che
la scadenza è obbligatoria nel formato — un gettone senza scadenza sopravvive
alla fine dell'abbonamento *e a chi l'ha emesso*.

## Coniare una licenza

Il cliente legge il proprio identificativo in **Impostazioni → Piano**
(«Installazione»), oppure da terminale sulla sua macchina:

```
curl -sk https://127.0.0.1:3333/api/license
```

Poi, sulla macchina che ha la chiave:

```
TOPICS_LICENSE_PRIVKEY="$(cat ~/.topics/signing/licenza-privata.key)" \
  bun scripts/licenza.ts conia <installationId> <posti> <giorni>
```

Il gettone che esce vale **solo** per quella installazione: copiato altrove dà
`other_installation`. Si installa da Impostazioni → Piano incollandolo nel campo,
o con `PUT /api/license`.

Per rispondere a «cosa ho mandato a quel cliente?» senza avere la chiave
sottomano: `bun scripts/licenza.ts ispeziona <gettone>` (legge, non convalida).

## Ruotare la chiave

Serve se la privata è uscita, o quando si passa a un servizio che firma da solo.

1. `bun scripts/licenza.ts chiavi` con `TOPICS_LICENSE_KID=armonia-2`.
2. **Aggiungere** la nuova pubblica in coda a `CHIAVI_INTEGRATE`, senza togliere
   la vecchia: chi verifica prova tutte le chiavi, quindi i gettoni già emessi
   continuano a valere. Toglierla subito significa spegnere le licenze dei
   clienti che hanno pagato.
3. Riconiare i gettoni ancora vivi con la nuova chiave e spedirli.
4. Togliere `armonia-1` solo quando l'ultimo gettone che ha firmato è scaduto.

C'è un test che tiene onesto questo giro: `server/lib/licenza.test.ts` verifica
un **gettone testimone** — coniato una volta con la privata vera, per
l'installazione `000000000000000000000000` che non esiste — con la sola chiave
integrata. Se qualcuno sostituisce la pubblica senza avere la privata, o fa una
rotazione a metà, quel caso diventa rosso subito, invece che alla prima licenza
venduta (dove il sintomo sarebbe `bad_signature` su un gettone emesso da noi).

## Il verso in cui si sbaglia

Nessun esito di licenza spegne una macchina: gettone assente, storto, di un
altro, scaduto, o nessuna chiave con cui controllarlo — si finisce sul piano
gratuito con un motivo leggibile, e l'uso locale resta intero. È una proprietà
fissata da `server/lib/licenza.test.ts`, non una buona intenzione.
