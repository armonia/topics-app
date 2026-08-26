# Change: primo-avvio

> **Stato: PROPOSTA, non approvata.** Nessuna riga di codice prima del tuo sì.
>
> I cinque bivi in fondo restano decisioni tue, ma non sono più domande a vuoto:
> per ognuno sono andato a cercare i fatti, e tre si sono chiusi da soli contro
> il codice. **Google** e **la chiave GitHub** erano già stati considerati e
> scartati, con la ragione scritta nei rispettivi file — non erano lacune, erano
> scelte. **I modelli** sono una guardia che ha già prodotto un difetto silenzioso
> quando è rimasta indietro, quindi aprirla è il contrario di una cura. Restano
> aperti per davvero solo il **quando compare** (1) e l'**installare dall'app**
> (2), che sono scelte di prodotto senza una risposta nel codice.
>
> Se sei d'accordo con le cinque raccomandazioni, basta un «vai» e passo alle
> spec.

## Why

Topics installata e aperta la prima volta mostra questo, e nient'altro:

```
                    [icona]
              Welcome to Topics
            Select a topic to start
              ⌘K Search   ⌘B Sidebar
```

`client/src/components/Layout/PanelGrid.tsx:2529-2645`. Un titolo, una riga, due
scorciatoie. **Niente su cui si possa cliccare.** Non c'è un wizard, un tour, un
primo avvio, nemmeno parziale o abbandonato: verificato con una sweep sul repo.

Il difetto non è l'assenza di una schermata: è che **le cose che servono per
lavorare esistono già tutte, e nessuna si presenta**.

- Gli agenti (Claude Code, Codex, opencode) sono CLI del fornitore, non roba
  nostra. Se non sono installati, la tab si apre vuota — su Windows senza
  nemmeno un «command not found», perché il processo non parte proprio.
  `server/lib/detect-agents.ts` sa già rispondere, e `GET /api/system/agents`
  (`server/routes/status.ts:257`) la espone. Il commento in cima a quel file dice
  a chi serve: *«first-run setup should be able to say "found Claude Code, did
  not find Codex" with the install command»*. Il consumatore non è mai stato
  scritto.
- Le chiavi API si mettono in Impostazioni → AI Providers
  (`AIProvidersSection.tsx`, con `ApiKeyForm` a :729), che è la pagina giusta
  per chi sa già di doverci andare. Al primo avvio nessuno lo sa.
- L'identità esiste: la migration 084 crea una persona `'Proprietario'` e la
  registra in `installation_owners`. Il nome è un segnaposto, e il commento della
  migration lo dice bene: *«inventare un nome da uno user-agent è l'unica cosa
  che una persona non perdona»*. Nessuno chiede mai come ti chiami.
- L'account remoto (`AccountSection.tsx`, `/api/auth/account`) è **facoltativo**
  e deve restarlo: `server/lib/account.ts:60` dice esplicitamente che il modello
  non è «login con Google».

Quindi: un utente nuovo apre Topics, vede una schermata vuota, e le sei cose che
gli servono sono ciascuna dietro una porta che non sa esistere.

## What Changes

**Una schermata, al primo avvio, che si può anche saltare.** Non un wizard
obbligatorio: quattro riquadri su una pagina, ognuno con uno stato già rilevato
e un'azione. Chi preme «Salta» ottiene l'app di oggi, e la schermata torna
raggiungibile da Impostazioni.

1. **Chi sei.** Un campo nome, precompilato con `'Proprietario'`. Scrive sulla
   persona già esistente (`PATCH /api/people/:id`), non ne crea una nuova.
   Nessuna email, nessuna password, nessun account: quello è il punto 4.
2. **Cosa c'è su questa macchina.** La lista da `GET /api/system/agents`: trovato
   / non trovato, con il percorso quando c'è e il comando di installazione quando
   manca. **Mostra, non installa** (vedi bivio 2).
3. **Con cosa risponde.** Se una chiave API è già nell'ambiente lo dice e non
   chiede niente. Altrimenti il campo che c'è già in `AIProvidersSection`,
   riusato, non riscritto.
4. **Da fuori casa (facoltativo, chiuso di default).** Una riga che spiega che
   Topics funziona senza account, e un link alla sezione Account per chi vuole
   raggiungerla da un altro dispositivo.

**Non cambia niente di ciò che esiste**: nessuna rotta nuova a parte quella che
ricorda se il primo avvio è stato fatto, nessuna modifica alle Impostazioni,
nessun campo nuovo nel DB a parte quel flag.

## Impact

- `openspec/specs/` — nuovo capability `first-run` (oggi non esiste).
- `client/` — un componente nuovo + il consumatore di `/api/system/agents`.
- `server/` — un flag in `app_settings` (`firstRunDoneAt`), niente altro.
- **Superficie di test**: e2e sul percorso «prima apertura → nome → salta» e
  «prima apertura → tutto compilato», più unit sul rilevamento. La barra è che
  un utente nuovo su una macchina senza CLI arrivi a mandare un messaggio, o
  sappia leggere perché non può.

## I bivi che non chiudo io

1. **Quando compare.** Alla primissima apertura, oppure solo quando manca
   qualcosa (nessuna chiave *e* nessun agente)?
   → *Consigliato: sempre alla prima apertura.* Una schermata che appare solo
   quando sei messo male è una schermata che vede solo chi è già in difficoltà,
   e nessuno la può provare: si rompe in silenzio, e se ne accorge esattamente
   la persona meno attrezzata per capirlo. Costa un «Salta» a chi ha già tutto.

   E «prima apertura» è già riconoscibile senza inventare niente: la migration
   084 crea `installation` con un `created_at`, e la persona proprietaria nasce
   col nome segnaposto `'Proprietario'`, che `GET /api/profile` già restituisce
   (`server/routes/profile.ts:43`). Quindi il flag `firstRunDoneAt` serve solo a
   ricordare che la schermata è stata VISTA — non a indovinare se l'installazione
   è nuova.

2. **Installare gli agenti da dentro l'app.** Il riquadro 2 può mostrare
   `npm i -g @openai/codex` da copiare, oppure avere un bottone «Installa» che
   lo esegue.
   → *Consigliato: solo mostrare, per ora.* Eseguire un install globale a nome
   dell'utente è irreversibile, chiede la rete e a volte i permessi, e fallisce
   in modi che non sappiamo ancora raccontare. Il bottone si aggiunge dopo, se
   la copia-incolla si rivela un attrito vero.

   *Verificato sul Windows 11 reale il 2026-08-26*, chiamando l'endpoint dal
   binario compilato: risponde `Claude Code installato=true` con il percorso
   assoluto `C:\Users\zorah\.local\bin\claude.exe`, e `Codex`, `opencode`,
   `Gemini CLI` a `false` con `path: null`. Cioè il riquadro 2 ha già tutti i
   dati che gli servono — nome, presenza, percorso, comando di installazione,
   URL — e non serve scrivere niente lato server per disegnarlo.

3. **Login con Google.** L'avevi nominato, e non è che nessuno ci abbia pensato:
   è stato considerato e scartato, con la ragione scritta in
   `server/lib/account.ts`. Il codice via email è stato scelto contro DUE
   alternative: non passkey (*«serve un autenticatore, e lega l'identità a un
   ferro — che è esattamente ciò che questo modello smette di fare»*) e non
   Google (*«un terzo che viene a sapere che questa installazione esiste, il
   contrario di ORG-08»*).

   Nello stesso file: l'account non è un cancello, e la lettura del suo stato non
   tocca la rete — *«un account collegato resta collegato mentre la rete non
   c'è»*, e non esiste una funzione che ri-validi un collegamento contro il
   servizio, perché *«una revalidazione è, per costruzione, un modo in cui un
   servizio giù ti declassa»*.

   → *Consigliato: FUORI, e la barra per rientrare è alta.* Aggiungere Google non
   è aggiungere un bottone: è aggiungere un terzo che impara dell'esistenza di
   ogni installazione, cioè ribaltare la proprietà su cui l'account è stato
   costruito. Se lo vuoi lo stesso, va discusso come cambio di ORG-08, non come
   riquadro di una schermata di benvenuto.

4. **La chiave GitHub.** L'avevi nominata. Sono andato a vedere dove Topics
   tocca GitHub, e i posti sono due, nessuno dei quali la vuole:
   - `server/lib/github-profile.ts` legge il **profilo pubblico** di un login
     (`GET /users/:login`), e il commento in cima è esplicito: *«NESSUN TOKEN, e
     volutamente: qui si legge solo ciò che è pubblico. Chiedere all'utente un
     personal access token per mostrare un avatar sarebbe chiedere una
     credenziale in cambio di una decorazione.»* Il limite di 60 richieste/ora
     senza autenticazione è già coperto da una cache a 6 ore che ricorda anche i
     fallimenti.
   - `git push` (`server/routes/tasks.ts`) usa il **git della macchina**, con
     `GIT_TERMINAL_PROMPT=0` perché un push che avrebbe bisogno di credenziali
     fallisca subito invece di appendere la richiesta. Le credenziali sono
     quelle che l'utente ha già: SSH, il credential manager, `gh auth`.

   → *Consigliato: FUORI, e non è un rinvio.* Non esiste oggi un punto dove una
   chiave GitHub farebbe funzionare qualcosa che adesso non funziona. Chiederla
   al primo avvio sarebbe raccogliere una credenziale potente «per dopo»: il
   costo è concreto (un segreto da custodire, revocare, spiegare) e il beneficio
   ancora ipotetico. Se il caso vero è «clonare repo privati dall'app», quello
   e' un lavoro suo, con la sua superficie di sicurezza — e allora la strada
   probabile non e' un PAT incollato in un campo, ma appoggiarsi al `git` che
   sulla macchina e' gia' autenticato, esattamente come fa il push oggi.

5. **I modelli del provider Topics.** Sono una lista dichiarata a mano
   (`server/providers/native/provider.ts:149`), e sono andato a leggere perché.
   Due ragioni, entrambe documentate lì:
   - **L'API non ha un catalogo da interrogare** sull'endpoint OAuth, e chiedere
     `/v1/models` con credenziali da abbonamento darebbe una lista che non
     corrisponde a ciò che l'abbonamento copre davvero.
   - **Quella lista è una GUARDIA, non una vetrina.** `routes/chat.ts` scarta i
     modelli che non vi compaiono. Quando è rimasta indietro di una generazione,
     ogni card che chiedeva `claude-opus-5` è girata in silenzio su
     `claude-sonnet-4-6`: il picker diceva Opus 5, la barra diceva Opus 5, e il
     turno era Sonnet. Gli id attuali sono *provati* uno per uno con una
     richiesta da 1 token (19/08/2026), non dedotti.

   → *Consigliato: lasciarli dichiarati, e fuori da questo change.* Il rilevamento
   automatico qui non toglie lavoro: sostituisce una lista verificata con una
   dedotta, sullo stesso punto che ha già prodotto un difetto silenzioso. Il
   problema vero — «la lista invecchia e nessuno se ne accorge» — si risolve con
   un controllo che AVVISA quando un id non risponde più, non aprendo la guardia.
