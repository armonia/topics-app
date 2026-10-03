# Design: sidebar-menu-settings

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`; qui quelle tecniche, e il perché delle alternative scartate.

## 1. Ogni cosa dove si usa: controlli diretti nel menu, moduli accanto alla loro cosa

Dal 03/10 (scelta 1 cambiata la seconda volta: «smistiamo tutto») il menu
utente tiene solo chi sei e com'è l'app. Una preferenza entra nel menu come
controllo diretto se vale tutto questo:

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
| Permesso dei banner di sistema | riga di stato + tasto «Consenti» o «Apri Impostazioni di Sistema», solo se fa qualcosa (NOTIF-PERM-01) | Notifiche |
| Accesso al disco per «Non disturbare» | riga + «Concedi», solo quando il cancello è bloccato | Notifiche |
| Questo dispositivo (push) | riga di stato che apre un livello: «Attiva» se non iscritto; da iscritto «Ricevi qui» (interruttore), «Quando Topics è già aperto» (segmento a due), «Disattiva qui» | Notifiche › Questo dispositivo |
| Altri dispositivi (push) | un interruttore per dispositivo, solo se ce ne sono | Notifiche › Altri dispositivi |
| Progetti silenziati | righe con «Riattiva» | Notifiche |
| Archiviati, riga della board | interruttori | Vista |
| Ordine | segmento Cronologico / Per stato | Vista |
| Dispositivi | riga con matita e cestino, conferma in linea | Dispositivi |
| Di chi è un dispositivo | livello della riga con le persone come radio, solo se sono più di una | Dispositivi › riga |
| Siti sempre attivi | righe con «Togli» | Sistema, Prestazioni |

Il resto è un modulo. Due moduli SONO l'account e le sue macchine e restano
nel menu come **livelli con un modulo** (`FormLevel`): Piano (gettone), sotto
l'account; Macchine (indirizzo del nodo, codice da approvare sull'altra
macchina ed esito, MACHINE-02; le richieste da altri computer con cartella e
identità), come livello in fondo a Dispositivi, perché anche quelle sono
computer. Gli altri tre vanno **dove si usano** (SETHOME-01):

| Modulo | Casa | Porta | Coda |
|---|---|---|---|
| Provider e chiavi (`ProvidersLevelBody`: piano Claude in cima, poi `AIProvidersSection`) | il selettore del modello | ultima riga di `AiExecutionMenuOptions`, quindi di ogni selettore: composer della chat, composer e cassetto della card, predefiniti della board; più «Provider e chiavi» dell'avviso dei limiti | «3 pronti», o in ambra «Nessuno pronto» / «Codex non pronto» quando non lo è quello scelto |
| Strumenti MCP (`ToolsSection`) | il composer della chat | riga «Strumenti» del «+» (`ComposerToolsRow`) | «2 attivi», «Spenti», letta con `?peek=1` all'apertura del «+» |
| Calendario (`CalendarSection`) | la tessera fissata di una pagina di calendario | riga «Calendario» del menu della tessera (`CalendarMenuRow`) | «Collegato», «In pausa», «Non collegato» |

Un selettore che si ridisegna (proposta `docs/model-selector-1002`, non ancora
approvata) mette in CIMA una fascia «Esegui in Topics»: la porta dei provider
sta in FONDO apposta, così le due convivono. Il piano Claude sta anche nel
selettore, come riga compatta sopra i modelli di Claude Code e di Topics
(«Max 20x · 5 h al 42%», ambra oltre `PLAN_USAGE_WARN_AT`).

**Il composer della card non ha un «+»** (`FloatingTaskComposer`: allegato,
progetto, modello, priorità, avvio), quindi non ha una riga Strumenti: un
«+» nuovo solo per quella riga sarebbe un menu in più per una cosa che la card
non usa a ogni invio. Il suo selettore del modello ha però la riga dei
provider, come tutti.

**Il calendario senza tessera fissata non ha una porta nella colonna.** Si è
guardato il «+» della colonna (`PaneAddMenu`, `addMenuItems.ts`: è l'elenco
delle cose da CREARE, e un modulo di impostazione lì sarebbe la sola voce che
non crea niente) e i vuoti della colonna (i Fissati non hanno uno stato vuoto
con dei suggerimenti). Chi non vuole un calendario non deve vederlo: la porta
è la palette, «Calendario», che apre il modulo come foglio al centro; chi
fissa la pagina del suo calendario trova la riga nel menu della tessera.

UN SOLO OSPITE per i tre pannelli, perché le case non sono sempre montate
(nessuna chat aperta, nessun selettore): `Settings/HomePanelHost` ascolta
`topics:open-home` (`lib/openHome.ts`) e decide la forma.

- **ancorato** sul desktop quando la porta passa un elemento (il trigger del
  selettore, che le righe trovano con `useMenuAnchor`, il «+», la tessera,
  l'avviso) o quando la casa è a schermo (`data-home-anchor`, per la palette):
  il primitivo `Menu` con `role="dialog"`, largo 420 px e mai più della
  finestra meno i margini, corpo che scorre sotto `min(70vh, 560px)`;
- **al centro** sul desktop senza nessuno dei due: un dialogo modale
  (`useModalDialog`), dove Escape si ascolta in risalita, così una `Select`
  aperta dentro si chiude per prima;
- **dal basso** sul telefono, sempre: il foglio di `Menu`.

Prima di aprire, l'ospite chiude ogni popover (il selettore che ospitava la
porta ha per trigger proprio l'ancora, e il registro avrebbe preso il pannello
per un suo figlio) e mette il fuoco sull'ancora, così alla chiusura il fuoco
torna lì. La cornice del modulo è la stessa dei livelli (`FormPanelFrame`:
intestazione fissa, Tab che gira dentro, rete d'errore); le domande chieste da
dentro restano nel pannello (`ConfirmInsidePopoverContext`).

Le richieste per Piano, Macchine, Aspetto e Notifiche passano dallo stesso
evento e l'ospite le gira a `openUserMenu`: la palette ha UNA porta per tutti i
comandi per nome.

Ogni livello e ogni pannello porta:

- **i tasti al campo**: `useMenuKeyboard` non muove il fuoco quando il tasto
  viene da un campo, `SubmenuItem` non chiude il livello con freccia sinistra
  da un campo, Tab gira dentro (`nextTrapFocus`), Escape chiude il livello o
  il pannello e basta (il contratto di `useDismissable`, figlio prima del
  padre); il contenuto ha `role="dialog"`, perché un campo dentro
  `role="menu"` si annuncia come voce di menu;
- **le domande restano**: `ConfirmInsidePopoverContext` e
  `popoverRegistry.shelterOpenPopovers`;
- **una coda che dice come sta** (USERMENU-10), scritta da funzioni pure
  (`Sidebar/formLevelTails.ts`) e letta solo a superficie aperta: montare È
  aprire, e ogni coda si rilegge quando il suo livello si chiude.

L'abbonamento Claude viene dalle credenziali della
CLI, che il server legge già per il runtime nativo
(`server/providers/native/auth.ts`). Esce solo come due etichette nella riga
`claude-code` e nella riga `topics` dello snapshot dei provider (il runtime
predefinito entra con le stesse credenziali; `subscription: { type, tier }`),
filtrate da un elenco di due nomi ammessi e da una forma (`[a-z0-9_]{1,48}`):
un domani la CLI può aggiungere campi accanto ai token senza che uno arrivi al
client (`server/providers/claude/subscription.ts`, test sul file di credenziali
vero e sullo snapshot serializzato). La coda di Strumenti chiede
`/api/mcp/fleet?peek=1`, che risponde con quel che è montato senza montare:
aprire un composer o il suo «+» non deve avviare una flotta di processi MCP.

Restano fuori dal menu anche le cose dell'identità che non sono preferenze
dell'app ma il tuo profilo: vanno nella tab Profilo (§4).

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

Il livello contiene TUTTO quel che oggi sta in `NotificationsSection`, non solo
gli interruttori; i pezzi si spostano come componenti, non si riscrivono:

- `NativeBannerStatus` (`NotificationsSection.tsx:33-66`): stato vero della
  catena dei banner e il tasto che lo stato consente. NOTIF-PERM-01 resta
  com'è nel comportamento; cambia solo la superficie che nomina (delta in
  `specs/notifications/spec.md`). Dopo il tasto il livello rilegge lo stato,
  come oggi il pannello.
- `FocusGateStatus` (`:123-152`): compare solo quando il cancello di «Non
  disturbare» è bloccato, con «Concedi» verso Accesso completo al disco.
- `PushDevices` (`:235-363`) si divide in due livelli figli, perché in 288 px
  non sta in un livello solo: «Questo dispositivo» (stato, «Attiva», «Ricevi
  qui», «Quando Topics è già aperto» con le due voci di oggi come segmento,
  «Disattiva qui») e «Altri dispositivi» (un interruttore per ciascuno,
  presente solo se l'elenco non è vuoto). I `data-testid` di oggi
  (`push-subscribe`, `push-when-open-*`, `push-unsubscribe`,
  `push-device-*`) restano, così `push-phone-enroll.spec.ts` cambia porta e
  non asserzione.
- `MutedProjects` (`:176-232`) come oggi, con «Riattiva».

## 3. Dispositivi in linea

Il livello usa già `/api/auth/devices` (`ProfileMenu.tsx:401-470`). Aggiunge le
tre mutazioni che oggi vivono solo in `Settings/DevicesSection.tsx`: rinomina
(`devices.rename`, `:444`), revoca con conferma (`:518-540`) e «di chi è»
(`:476-513`). Le funzioni di chiamata si estraggono in `lib/devicesApi.ts` e le
usano i due posti finché la pagina esiste; poi la pagina perde l'elenco e
resta solo il riquadro Nodi, che diventa la voce Nodi (§4).

- Rinomina: la matita trasforma il nome in un campo nella stessa riga; Invio
  salva, Esc annulla. È l'unico campo di testo del menu ed è corto.
- Revoca: il cestino sostituisce la riga con «Revocare {nome}? Revoca /
  Annulla», fuoco su Annulla, nessuna modale (stessa forma della striscia di
  conferma di `chat-inline-command-run`).
- Il computer su cui gira il server non ha né matita né cestino (non si revoca,
  `ProfileMenu.tsx:68-75`).
- «Di chi è» (`DevicesSection.tsx:476-513`, la correzione dell'attribuzione
  fatta dalla migration 084): con più di una persona la riga ha un terzo
  tasto (icona `Users`) che apre un livello con le persone come radio; la
  scelta chiama la stessa route di oggi e chiude il livello. Con una persona
  sola il tasto non c'è, come oggi il link.
- «Revocati (n)» è un livello figlio, solo se n > 0.
- Le richieste dei computer remoti, se ce ne sono, compaiono in cima al livello
  come una riga «n richieste da altri computer» che apre Impostazioni, Nodi:
  lì si sceglie cartella e identità, che nel menu non stanno.
- Il livello è lo stesso sul desktop e sul telefono (§7): oggi sul telefono
  rinomina e revoca esistono solo nelle Impostazioni, e togliere la pagina
  senza portare il livello lì le toglierebbe.

## 4. L'identità in un posto: la tab Profilo

`SETTINGS_SECTIONS` perde `appearance`, `notifications` (vanno nel menu),
`profile`, `followers`, `organization` (vanno nella tab) e `devices`, che
diventa `nodes`: il riquadro Nodi di oggi (`DevicesSection.tsx:568-640`,
`settings-node-pair`) più `RemoteNodeRequests`, in un nuovo
`Settings/NodesSection.tsx`. Etichetta «Nodi» (la chiave
`settings.machines.pair.title` esiste già).

Ogni pezzo che oggi sta solo nelle voci tolte ha una casa nella tab, misurato
pezzo per pezzo e non per voce:

- `ProfileHeader`, amici, seguaci, seguiti, privacy, organizzazione: già nella
  tab (`SelfProfile.tsx:84-126`, `ProfilePane.tsx:88`).
- **Persone** (`FollowersSection.tsx:82,122-124`, chi c'è da seguire): oggi
  solo nelle Impostazioni. `ProfilePanel` guadagna `people`, con lo stesso
  `PeopleList` e lo stesso `data-testid="list-people"`; si apre da un tasto
  «Persone» accanto ai contatori seguaci e seguiti.
- **Fuori da Topics**: `ProfilePanel` guadagna `outside`, un tasto accanto a
  Privacy. Dentro, `ProfileStatsSection` intero (cifre, banner, pagina
  pubblica con Pubblica, Apri, Copia, Revoca e il costo come sua
  sotto-opzione) e `DiscordSection`. Stanno insieme perché sono la stessa
  domanda: cosa vede di te chi non è qui. Non vanno dentro Privacy: Privacy è
  un menu di interruttori, la pagina pubblica ha un URL, due tasti e un
  errore da mostrare accanto (APPSET-07), che in un menu stretto si perdono.
  APPSET-07 non cambia: stesso componente, stessi `data-testid`
  (`profile-public-*`), `refused-gestures.spec.ts` cambia porta.
- Le cifre di `ProfileStatsSection` (sessioni, task, ore, spesa) NON sono le
  stesse di `ProfileTopicsStats` (prompt e token, `ProfileHeader.tsx:288`):
  restano due blocchi, uno nella pagina e uno nel pannello di ciò che si
  pubblica, perché quelle sono le cifre che il banner e la pagina pubblica
  mostrano.
- `AccountSection` sparisce solo perché `AccountPanel` arriva anche sul
  telefono (§7): fa gli stessi due passi (`useAccountLink`) e resta l'unica
  porta su tutti e due gli schermi. Senza §7 questa riga non si fa.
- `openSettings('profile' | 'followers' | 'organization')` diventa
  `apriProfilo(...)` con la stessa pagina; `openSettings('devices')` apre il
  menu sul livello Dispositivi; `openSettings('notifications' | 'appearance')`
  apre il menu sul livello omonimo. Nessun chiamante rimane con un id che non
  esiste: `SettingsPanelSection` si restringe e `tsc` trova il resto.
- `PrivacySection` passa a `Shared/Switch` invece del suo interruttore privato.

Questo modifica tre requisiti esistenti (delta in `specs/settings/spec.md`):
SETORG-01 («i gruppi si trovano dalle impostazioni» diventa «dal menu utente e
dalla tab Profilo»), APPSET-03 (le due voci distinte ora sono due superfici
distinte), APPSET-05 (le pagine dell'identità sono di primo livello nella tab,
non nel pannello). E uno in `specs/notifications/spec.md`: NOTIF-PERM-01.

## 5. Niente finestra Impostazioni: le porte

Dal 02/10 `GlobalSettings.tsx`, `Settings/sections.ts`, `lib/openSettings.ts`
e l'evento `topics:open-settings` sono usciti, con lo stato `showSettings` di
`App`. Dal 03/10 escono anche i livelli Provider AI, Strumenti e Calendario
del menu (e da `openUserMenu` i loro nomi), la pill «Impostazioni» della
palette e il «Apri impostazioni» del selettore:

| Porta | 02/10 | Ora |
|---|---|---|
| ⌘, (`useKeyboardShortcuts`) | il menu, fuoco sulla prima riga | uguale; col menu già aperto non lo rimonta |
| pill «Impostazioni» della palette | il menu | non c'è più: comandi per nome («Provider e chiavi», «Strumenti MCP», «Calendario», «Piano», «Macchine», «Aspetto», «Notifiche») |
| avviso dei limiti del piano, «Provider e chiavi» | livello Provider AI | pannello Provider e chiavi, ancorato all'avviso |
| selettore del modello, «Apri impostazioni» | livello Provider AI | la riga in fondo «Provider e chiavi», ancorata al selettore |
| riga delle richieste nei Dispositivi | livello Nodi | livello Macchine, dentro Dispositivi |
| ingranaggio del campanello | livello Notifiche | uguale |

Un livello aperto da una richiesta si apre come un clic (`defaultOpen`); una
richiesta senza livello (⌘,) mette il fuoco sulla prima riga, così Invio
agisce e le frecce partono da lì. Sul telefono risponde il menu del titolo,
con gli stessi livelli come fogli.

Restano dove sono le impostazioni della board (`KanbanBoardPane`,
`DispatchLoadGauge`) e quelle della singola chat (`TopicSettingsModal`): sono
un'altra cosa, di un'altra superficie.

## 6. Tastiera

- Primo livello: frecce su e giù, Home, End sulle righe, come `useMenuKeyboard`
  fa già per i livelli (`Menu.tsx:24`). `PresencePopover` oggi ha Esc e il
  ritorno del fuoco, non le frecce.
- Livelli: → o Invio apre, ← chiude (`SubmenuItem.tsx:246-261`), invariato.
- Dentro un livello di preferenze: Tab scorre i controlli; il segmento è un
  `radiogroup` (frecce sinistra e destra cambiano e applicano, come il gruppo
  di radio nativo); il passo è uno `spinbutton` (frecce su e giù, PagSu e PagGiù
  di 4 passi); l'interruttore è `role="switch"` con Spazio.
- ⌘, apre il menu utente col fuoco sulla prima riga (§5); nessuna scorciatoia
  nuova.

## 7. Telefono

Sotto 768 px il menu utente oggi NON c'è: `ProfileMenu` si monta dentro
`SidebarStatusBar`, che sta sotto `{!isMobile && …}` (`App.tsx:1959-1961`).
Il menu del titolo ha solo `TopicsMenuItems` e `SidebarSystemMenu`
(`App.tsx:2272-2294`), e la porta Profilo della barra in basso
(`MobileChromeBar.tsx:333`) apre la tab Profilo (`App.tsx:2032`), che non ha
account né dispositivi. Quindi sul telefono accedi/esci, rinomina e revoca
esistono oggi una volta sola, nelle Impostazioni.

Per questo il blocco dell'identità di `ProfileMenu` (`AccountPanel`, Amici,
Gruppi, Dispositivi, oggi `ProfileMenu.tsx:158-182`) si estrae in
`Sidebar/IdentityMenuItems.tsx` e si monta in cima al menu del titolo del
telefono, come `TopicsMenuItems` già fa per le righe dei comandi: un
componente, due host. I dati (sessione, dispositivi, gruppi, amici) oggi li
legge `IdentityBlock` (`IdentityBlock.tsx:77-78,204-224`); diventano un hook che
usano i due host, letto solo quando il menu è aperto.

Le righe Aspetto, Notifiche e Vista arrivano lì perché sono in
`TopicsMenuItems`. Il livello si apre come foglio sopra il foglio, con
«Indietro»; i controlli alti 44 px (`coarse:`). Finestre fluttuanti non c'è
(solo desktop, come oggi).

Prima di togliere `AccountSection` e la pagina Dispositivi, un E2E a 390x844
prova che dal menu del titolo si accede, si esce, si rinomina e si revoca
(tasks 1.8). Se quel test non è verde, le due pagine restano.

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
