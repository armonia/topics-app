# Design: sidebar-menu-settings

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`; qui quelle tecniche, e il perché delle alternative scartate.

## 1. Quale preferenza va nel menu: tre criteri, non un gusto

Una preferenza entra nel menu come controllo diretto se vale tutto questo:

- **sta in una riga** di 288 px (il pavimento del menu, `ProfileMenu.tsx:106`)
  senza andare a capo: un interruttore, un segmento fino a tre voci, un passo,
  una `Select` dell'app;
- **si applica subito** e si annulla con lo stesso gesto: niente «Salva»,
  niente prova di connessione;
- **non chiede di scrivere** una chiave, un URL, un token, un nome lungo.

| Preferenza | Controllo nel menu | Livello |
|---|---|---|
| Tema | segmento a tre (Sun, Moon, Monitor) | Aspetto |
| Testo | passo 12…18 px | Aspetto |
| Larghezza chat | passo 600…1300 a 20 px, «Piena» a un estremo | Aspetto |
| Densità | segmento a due | Aspetto |
| Finestre fluttuanti | interruttore, solo desktop, «Beta» | Aspetto |
| Lingua | `Select` (foglio dal basso sul telefono) | Aspetto |
| Notifiche, suono, anche a fuoco | interruttori, gli ultimi due spenti se il primo è spento | Notifiche |
| Questo dispositivo (push) | riga di stato + «Attiva» solo se serve | Notifiche |
| Progetti silenziati | righe con «Riattiva» | Notifiche |
| Archiviati, riga della board | interruttori | Vista |
| Ordine | segmento Cronologico / Per stato | Vista |
| Dispositivi | riga con matita e cestino, conferma in linea | Dispositivi |
| Siti sempre attivi | righe con «Togli» | Sistema, Prestazioni |

Restano nel pannello: Provider AI (chiavi, prova, endpoint, CLI),
Strumenti (MCP, permessi), Calendario (URL del feed), Piano (token), Computer
remoti (cartella e identità da scegliere per ogni richiesta).

Scartata senza scelta la variante «accordion dentro il menu»: il file stesso la
racconta come il difetto che i livelli hanno tolto (`ProfileMenu.tsx:20-30`,
test `profile-menu.spec.ts` che misura che il menu non cresce).

## 2. Notifiche: un livello, e il campanello ci porta

`NotificationHistoryButton` oggi chiama `onOpenSettings` con la sezione
`notifications` (`App.tsx:1805,1816`). Con la scelta 5 chiama
`openUserMenu({ level: 'notifications' })`:

- un evento di finestra `topics:open-user-menu` con `detail.level`, nello stesso
  stile di `topics:open-utility` e `OPEN_SETTINGS_EVENT` (`lib/openSettings.ts`);
- `IdentityBlock` (desktop) apre la card; il menu del titolo lo apre sul telefono;
- `SubmenuItem` guadagna `defaultOpen` (aperto al montaggio, come un clic):
  oggi apre solo su gesto (`SubmenuItem.tsx:28-40`).

Il campanello resta il posto della **cronologia**; le **preferenze** sono nel
menu. Due pannelli con due mestieri, non due copie.

## 3. Dispositivi in linea

Il livello usa già `/api/auth/devices` (`ProfileMenu.tsx:401-470`). Aggiunge le
due mutazioni che oggi vivono solo in `Settings/DevicesSection.tsx`: rinomina
(`devices.rename`, `:444`) e revoca con conferma (`:518-540`). Le funzioni di
chiamata si estraggono in `lib/devicesApi.ts` e le usano i due posti finché la
pagina esiste; poi la pagina perde l'elenco.

- Rinomina: la matita trasforma il nome in un campo nella stessa riga; Invio
  salva, Esc annulla. È l'unico campo di testo del menu ed è corto.
- Revoca: il cestino sostituisce la riga con «Revocare {nome}? Revoca /
  Annulla», fuoco su Annulla, nessuna modale (stessa forma della striscia di
  conferma di `chat-inline-command-run`).
- Il computer su cui gira il server non ha né matita né cestino (non si revoca,
  `ProfileMenu.tsx:68-75`).
- «Revocati (n)» è un livello figlio, solo se n > 0.
- Le richieste dei computer remoti, se ce ne sono, compaiono in cima al livello
  come una riga «n richieste da altri computer» che apre Impostazioni, Computer
  remoti: lì si sceglie cartella e identità, che nel menu non stanno.

## 4. L'identità in un posto: la tab Profilo

`SETTINGS_SECTIONS` perde `profile`, `followers`, `organization`, `devices`
(che diventa `remote-computers`, solo `RemoteNodeRequests`).

- `ProfileHeader`, amici, seguaci, privacy, organizzazione: già nella tab
  (`SelfProfile.tsx:84-126`, `ProfilePane.tsx:88`).
- `DiscordSection` e il «pubblica il costo» di `ProfileStatsSection` entrano nel
  menu Privacy della tab, sotto un titoletto «Fuori da Topics»: sono le due
  cose che decidono cosa vede chi non è qui, che è la domanda della privacy.
- `AccountSection` sparisce: `AccountPanel` in cima al menu fa gli stessi due
  passi (`useAccountLink`) e resta l'unica porta.
- `openSettings('profile' | 'followers' | 'organization')` diventa
  `apriProfilo(...)` con la stessa pagina; `openSettings('devices')` apre il
  menu sul livello Dispositivi. Nessun chiamante rimane con un id che non esiste:
  `SettingsPanelSection` si restringe e `tsc` trova il resto.
- `PrivacySection` passa a `Shared/Switch` invece del suo interruttore privato.

Questo modifica tre requisiti esistenti (delta in `specs/settings/spec.md`):
SETORG-01 («i gruppi si trovano dalle impostazioni» diventa «dal menu utente e
dalla tab Profilo»), APPSET-03 (le due voci distinte ora sono due superfici
distinte), APPSET-05 (le pagine dell'identità sono di primo livello nella tab,
non nel pannello).

## 5. Le Impostazioni che restano

Stessa finestra (`GlobalSettings.tsx`), stessa forma a due colonne, cinque voci:
Provider AI, Strumenti, Calendario, Piano, Computer remoti. Si apre da ⌘,, dalla
pill della palette, dalla riga del menu, dai rimandi del composer e
dall'avviso dei limiti, come oggi. Il titolo «Settings» scritto a mano
(`GlobalSettings.tsx:132`) passa dal dizionario.

L'alternativa della scelta 2 (una tab) costerebbe un tipo di pane nuovo con il
suo ciclo di vita (residenza, ripristino, chiusura), per una superficie che
si apre poche volte: si fa solo se la scegli.

## 6. Tastiera

- Primo livello: frecce su e giù, Home, End sulle righe, come `useMenuKeyboard`
  fa già per i livelli (`Menu.tsx:24`). `PresencePopover` oggi ha Esc e il
  ritorno del fuoco, non le frecce.
- Livelli: → o Invio apre, ← chiude (`SubmenuItem.tsx:246-261`), invariato.
- Dentro un livello di preferenze: Tab scorre i controlli; il segmento è un
  `radiogroup` (frecce sinistra e destra cambiano e applicano, come il gruppo
  di radio nativo); il passo è uno `spinbutton` (frecce su e giù, PagSu e PagGiù
  di 4 passi); l'interruttore è `role="switch"` con Spazio.
- ⌘, apre le Impostazioni come oggi; nessuna scorciatoia nuova.

## 7. Telefono

Sotto 768 px il menu è il foglio del titolo (`App.tsx:2255-2290`), senza
account né persone (stanno nella porta Profilo della barra in basso,
`MobileChromeBar.tsx:333`). Le righe Aspetto, Notifiche e Vista arrivano lì
perché sono in `TopicsMenuItems`, il componente montato in entrambi i posti.
Il livello si apre come foglio sopra il foglio, con «Indietro»; i controlli
alti 44 px (`coarse:`). Finestre fluttuanti non c'è (solo desktop, come oggi).

## 8. Movimento

Il meccanismo è quello condiviso, non uno nuovo:

- entrata del pannello e dei livelli: `.popover-enter`, 90 ms in dissolvenza
  (`index.css:2810-2818`, `MOTION.instant` in `lib/motion.ts`);
- uscita: la copia di `lib/exitGhost.ts`, 90 ms, scala 0,97;
- pallino dell'interruttore e indicatore del segmento: `transform` in
  `--motion-instant` con `--ease-standard`;
- passo: il numero cambia senza animazione (un numero che scorre si legge
  peggio);
- `prefers-reduced-motion` e `.anims-paused`: nessuna animazione, come oggi
  (`exitGhost.ts`, `index.css:2894`).

Se il lavoro sull'animazione cambia questi token, i controlli nuovi li seguono
senza codice loro: leggono le variabili, non numeri.

## 9. Lingua delle etichette

Ogni etichetta nuova o spostata passa da `useT` con le due voci in
`i18n-it.ts` e `i18n-en.ts`; `check:ui-language` è la barra. Le stringhe
inglesi scritte a mano in `AppearanceSection.tsx` e `NotificationsSection.tsx`
spariscono con i file che le contengono, o si convertono se il file resta.
