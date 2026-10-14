# daily-driver: Topics come software principale del team, meglio dell'app di Claude Code

## Da decidere

Eseguire il piano costa: sessioni cloud, quota degli agenti e revisioni. Il credito cloud rimasto,
51,81 $, scade il 05/11.

1. **Partire con D0, D4·B1 e D8·R1 (consigliata).**
   - D0 dà le misure senza cui le altre barre non esistono, e parte subito.
   - B1 e R1 chiudono le due cose che oggi rompono il browser condiviso: il mirror che non regge
     le pagine vere, e il problema di sicurezza più grave.
   - B1 e R1 partono appena l'altra sessione fonde il suo ramo sul browser.
   - Le tracce di codice usano il credito cloud prima che scada.
2. **Solo B1 e R1 adesso**, il resto quando il credito si rinnova.

## Perché

Il proprietario vuole usare Topics come software principale per tutti, al posto dell'app nativa di
Claude Code. Deve consumare meno, essere istantanea e non degradare. Tre fonti dicono dove siamo.

**1. Le misure del 14/10 (`baseline.md`).**
- `git/status`: 6.008 chiamate al giorno, p95 385 ms.
- Socket: un client fermo riceve 6,9 KB/s di payload; ad agosto erano 2,7 KB in cinque minuti.
- Webview: da 0,6 a 1,7 GB in 7,5 minuti, CPU al 28% con l'app in background.
- 499 fetch git falliti al giorno: corretto il 14/10 nella #317.

**2. L'audit del browser.**
- Il disegno del co-browse è buono, ma il primo frame del mirror pesa da 2,1 a 4,8 MB sulle pagine
  vere, contro un limite di 1 MiB del socket.
- Un riavvio o uno sleep fanno perdere stato.
- Il Mac non dice chi sta guardando.
- Ci sono problemi di sicurezza, descritti in privato.

**3. Lo studio di 31 concorrenti (`docs/competitors/`).**
- Nessuno ha il co-browse fra dispositivi.
- L'app di Claude Code resta il metro di paragone.
- Altri hanno cose che a noi mancano:
  - automazioni a calendario, in 17 concorrenti su 31, compresa l'app di Claude Code;
  - commenti sul diff mandati all'agente;
  - worktree pronte con script e porte;
  - controlli della CI prima del merge;
  - un selettore di elemento per l'agente;
  - budget di performance dichiarati.

## Cosa cambia

| Traccia | In una riga |
|---|---|
| D0 misure | ogni numero dell'«istantaneo» diventa un cancello che esce non-zero |
| D1 server | letture dalla memoria, frame solo a chi guarda, `external-sessions` come differenza |
| D2 webview | in background si dorme, liste virtualizzate, niente che cresce col tempo |
| D3 Rust | git e visita dei file senza processi (gix, ignore), solo se la misura lo chiede |
| D4 browser | mirror a pezzi e compresso, stato sul Mac, riavvii e sleep innocui, selettore di elemento |
| D5 sessioni e board | card a calendario, commenti sul diff, worktree pronte, controlli prima del land, domanda a lato |
| D6 per tutti | primo avvio, relay col QR, pagina di stato, installazione provata su 3 sistemi |
| D7 affidabilità | card e client sopravvivono al SIGTERM, test instabili a zero |
| D8 sicurezza | le correzioni dell'audit, con i dettagli privati finché non sono chiuse |

## Barra

`specs/acceptance.md`:
- i comandi che escono non-zero;
- quattro scenari con video, dalla «giornata tipo» al riavvio a metà turno;
- sei mutazioni che devono far fallire i loro test.

## Fuori

- Il motore nativo e le credenziali che usa: escluso dal proprietario il 14/10.
- Riscrivere la UI o il server in un altro linguaggio.
- Un'app mobile nativa, e account in cloud con password.

## Deciso da me

- **Rust solo dove la misura lo chiede.** D3 ha un cancello d'ingresso. Il PTY ha già il suo bridge
  in Rust; la UI e la logica del server restano dove sono.
- **Le misure si aggiungono ai cancelli che ci sono** (`check:route-latency`, `check:bundle`,
  `check:growth`), non a un banco nuovo.
- **Le change aperte che servono al piano si portano a termine con le loro barre, non si
  riscrivono:** `primo-avvio`, `relay`, `device-auth`, `sharing-orgs`,
  `pane-store-server-authoritative`.
- **Lo studio dei concorrenti è pubblico**, in `docs/competitors/`: analisi originale, citazioni
  brevi, nessun dato personale. Le parti di sicurezza dell'audit restano private.
- **D4·B1 e D8·R1 aspettano il merge del ramo dell'altra sessione sul browser,** perché toccano gli
  stessi file.
