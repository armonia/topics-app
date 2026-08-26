# Change: primo-avvio

> **Stato: PROPOSTA, non approvata.** Ci sono cinque bivi di prodotto che non
> tocca a me chiudere; stanno in fondo, numerati, con la mia raccomandazione.
> Nessuna riga di codice prima del tuo sì.

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
   e nessuno la può provare. Costa un «Salta» a chi ha tutto.

2. **Installare gli agenti da dentro l'app.** Il riquadro 2 può mostrare
   `npm i -g @openai/codex` da copiare, oppure avere un bottone «Installa» che
   lo esegue.
   → *Consigliato: solo mostrare, per ora.* Eseguire un install globale a nome
   dell'utente è irreversibile, chiede la rete e a volte i permessi, e fallisce
   in modi che non sappiamo ancora raccontare. Il bottone si aggiunge dopo, se
   la copia-incolla si rivela un attrito vero.

3. **Login con Google.** L'avevi nominato. Oggi `server/lib/account.ts:60` dice
   esplicitamente che il modello **non** è Google, e l'account è un aggancio
   facoltativo via email + codice.
   → *Consigliato: fuori da questo change.* Non è una schermata, è un fornitore
   di identità in più con la sua superficie di sicurezza. Se lo vuoi, è una
   change sua e viene dopo che il primo avvio esiste.

4. **La chiave GitHub.** L'avevi nominata, e non ho trovato dove Topics la usi
   oggi: c'è `github_login` sul profilo (migration 084) e un `profiloGitHub`,
   che sono il *profilo* pubblico, non una chiave di lavoro.
   → *Consigliato: dimmi a cosa serve.* Se è per clonare repo privati è una cosa,
   se è per il profilo è già lì. È l'unico punto dove non ho abbastanza fatti
   per raccomandare.

5. **I modelli del provider Topics.** Oggi sono una lista dichiarata a mano, e il
   commento dice che è deliberato.
   → *Consigliato: lasciarli lì.* Non è un problema di primo avvio, e mescolare
   le due cose fa un change che non si riesce a rifiutare in un pezzo solo.
