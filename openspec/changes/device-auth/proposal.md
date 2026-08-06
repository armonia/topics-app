# Change: device-auth

## Why

Da stamattina Topics non ha **nessuna** autenticazione: la change
`lan-open-same-origin` ha rimosso il pairing token, e resta solo la difesa CSRF
same-origin — che non dice *chi sei*, impedisce solo a un sito web di pilotare il
server. Chiunque raggiunga `:3333` esegue comandi, legge e scrive file, apre
terminali.

Non è teorico. Verificato il 2026-08-06: il server ascolta su `::`, cioè su **ogni
interfaccia**, e sulla macchina ne esiste una seconda oltre alla LAN di casa. Da
quell'indirizzo, `GET /preview/<path assoluto>` risponde `200`. Il server non sa
distinguere chi bussa perché non ha nessun concetto di identità: nel DB non esiste
alcuna tabella di utenti o dispositivi.

**La lezione, che decide il progetto**: difendersi elencando *quali reti sono
buone* è una lista che marcisce. Le interfacce di una macchina non si possono
enumerare in anticipo — oggi è una VPN, domani il wifi di un bar o la rete ospiti
di un cliente. L'identità non marcisce.

## Dove: nel server, non al bordo

Deciso dopo aver misurato le alternative. Tre vincoli, ognuno sufficiente:

1. **Il traffico non passa dal bordo, e non può.** Il caso reale è un telefono
   sulla stessa wifi: quel pacchetto resta dentro lo switch di casa. Per farlo
   passare da un edge bisognerebbe chiudere la LAN e far uscire e rientrare da
   Internet il traffico fra due dispositivi a un metro — negare la richiesta per
   poterla soddisfare.
2. **Un tunnel inverte la fiducia invece di rinforzarla.** Termina sulla macchina
   e inoltra a loopback, quindi ogni richiesta da Internet si presenta al server
   come `127.0.0.1` — qui la classe **più fidata**, l'unica che apre
   `/__daemon/*`. Lo dice già `server/routes/remote.ts:16-19`.
3. **Topics è un prodotto distribuito** (repo pubblico, MIT, installer per tre
   piattaforme, updater firmato). Chi lo installa non può dover comprare un
   dominio e aprire un account di terze parti per usare il proprio telefono in
   casa propria — e il sito online vende `account: None` come differenziatore
   numero uno (`landing/src/data/compare.ts`).

## What changes

**Identità per DISPOSITIVO, non account con password.** Il proprietario è uno; ciò
che serve è distinguere *quale dispositivo* e poterlo revocare. Nessuna
registrazione, nessuna password, nessun servizio esterno.

**Il verso dell'approvazione: approva il Mac, non indovina il telefono.**
Il dispositivo nuovo mostra un codice; la macchina che già possiede la sessione lo
conferma. È deliberato e non estetico: uno schema in cui il telefono *inserisce* un
PIN richiede un rate limiter contro il brute-force, e in questo server non ne
esiste nessuno (zero `429` in tutto il repo). Invertendo il verso, il pezzo
rischioso non serve.

**Il trasporto è un cookie**, non un header. Il browser lo attacca da solo a tutte
le ~94 fetch `/api` e a tutti e 4 i WebSocket. Un header richiederebbe di
riattivare `installNetShim` fuori da Tauri (oggi `if (!isTauri) return`, quindi sul
telefono non si installa affatto), più il query param per i WS, più un terzo
percorso per SSE. Il guscio Tauri resta fuori dal cookie — è cross-origin — e usa
il token del daemon, che ha già.

**Il gate cambia forma, e questo è il punto che decide se l'auth è vera o
decorativa.** Oggi `evaluateAuth` esce ad `allow` per ogni metodo non mutante
*prima* di qualunque altro controllo (`auth-gate.ts:201`). Innestare l'identità
dopo lascerebbe **tutte le GET aperte a `curl`** — `/preview` compreso, che è
esattamente la falla misurata. L'asse dell'identità va valutato **per primo**;
quello dell'origine resta dopo, perché continua a servire contro il CSRF.

**L'identità si vede.** Sopra la status bar compare la sessione corrente — il nome
del dispositivo quando è appaiato, «non appaiato» quando no. Un'autenticazione che
non si vede è indistinguibile dalla sua assenza, ed è esattamente l'errore del
pairing precedente: funzionava, ma nulla a schermo lo diceva.

## Impact

- **Specs (delta)**: `remote-access/` — AGGIUNTE `AUTH-01` (identità per
  dispositivo, valutata prima dell'origine), `AUTH-02` (appaiamento approvato dal
  Mac), `AUTH-03` (revoca), `AUTH-04` (l'identità è visibile).
- **DB**: migration `080` — tabella `devices`. Nessun dato esistente toccato.
- **Server**: `lib/auth-gate.ts` (ordine degli assi), `lib/device-auth.ts` (nuovo,
  puro), `routes/auth.ts` (nuovo), `server.ts` (call site + cookie).
- **Client**: schermata di appaiamento, pannello di approvazione, elenco
  dispositivi, identità in `SidebarStatusBar.tsx`.
- **Docs**: `SECURITY.md` e `README.md` tornano a poter dire che un'autenticazione
  c'è — ma solo dopo che c'è.

## Out of scope

- **Account multi-utente.** Il backlog ha già un'idea di «amicizia» per vedere le
  sessioni di altri: è un'altra cosa e arriva dopo, sopra questo strato.
- **Il sandboxing di `/preview`.** L'auth chiude la porta; non rende sicuro il
  file server per chi è dentro. Resta il task separato, e va fatto comunque.
- **L'accesso da fuori casa.** È trasporto, non identità: un tunnel semmai
  trasporta questa auth, non la sostituisce.

## Risks

1. **Chiudersi fuori.** Se il flusso di approvazione si rompe, il proprietario
   perde l'accesso. Mitigazione: il loopback resta fidato per definizione — dal
   Mac si entra sempre — e `TOPICS_AUTH_OFF=1` resta la botola.
2. **Il cookie non copre il guscio Tauri** (cross-origin, e
   `Access-Control-Allow-Credentials` non è mai emesso in tutto il repo). Il
   guscio passa dal suo proxy loopback ed è fidato per trasporto: nessun
   cambiamento per l'utente desktop, ma è un secondo percorso da tenere in vita.
2. **Le GET diventano gated per i peer remoti.** È il punto: oggi non lo sono. Ogni
   `<img>`/`<video>` che punta a `/media` o `/preview` deve funzionare col cookie —
   il browser lo attacca anche su quelle, ma va verificato dal dispositivo, non
   dedotto.
