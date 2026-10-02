## Da decidere

Menu utente e Impostazioni: 5 scelte prima del codice.
1. Tutto nel menu, anche i moduli (scelta cambiata il 02/10, testo in `.openspec.yaml`, `modifiche`): Aspetto, Notifiche, Vista e Dispositivi sono controlli diretti, applicati subito; Provider AI, Strumenti, Calendario, Piano e Nodi sono livelli più larghi (400 px) con l'intestazione fissa e il corpo che scorre, perché ogni impostazione ha così una casa sola e la si trova dove si guarda già; ogni riga dice in coda come sta (Piano «Gratuito», Provider AI «Topics · Max 20x»), così la domanda di tutti i giorni ha risposta senza aprire niente (o, la scelta del 01/10: i cinque moduli in una finestra Impostazioni a parte, perché chiavi e URL si scrivono meglio in una finestra larga).
2. Niente riga Impostazioni e niente finestra: ⌘, e la pill della palette aprono il menu utente col fuoco sulla prima riga, e ogni rimando che portava a una pagina del pannello (avviso dei limiti, selettore del modello, richieste dai Dispositivi) apre il livello giusto, perché un tasto che porta a un secondo elenco è il doppione che la richiesta chiede di togliere (o, la scelta del 01/10: Impostazioni resta la finestra sopra l'app, aperta da ⌘, e dall'ultima riga del menu).
3. Chi sei sta in un posto solo, la tab Profilo: dalle Impostazioni escono Profilo, Seguaci e Organizzazione, e la tab prende anche quel che oggi c'è solo lì (la scheda Persone per trovare chi seguire; un pannello «Fuori da Topics» con cifre, banner, pagina pubblica con Pubblica, Revoca e costo, presenza Discord); accedi/esci resta solo in cima al menu utente, che sul telefono entra in cima al menu del titolo con amici, gruppi e dispositivi, perché oggi le stesse cose si cambiano da due o tre porte con nomi diversi e sul telefono account e dispositivi stanno solo nelle Impostazioni (o: il contrario, l'identità resta nelle Impostazioni e la tab Profilo torna solo da leggere).
4. I dispositivi si gestiscono nel loro livello del menu, su desktop e telefono: rinomina e revoca sulla riga con conferma in linea, «di chi è» in un livello della riga (solo se le persone sono più di una), i revocati in un livello sotto, perché oggi l'elenco è disegnato due volte e il gesto che conta sta dietro «Gestisci», che apre l'altra copia (o: il livello resta un elenco da leggere e «Gestisci» continua ad aprire le Impostazioni).
5. L'ingranaggio del campanello apre il menu utente sul livello Notifiche, unica casa di tutte le preferenze delle notifiche (i tre interruttori, il permesso dei banner di sistema col suo tasto, l'accesso al disco per «Non disturbare», questo dispositivo con ricevi, «quando Topics è già aperto» e disattiva qui, gli altri dispositivi, i progetti silenziati), perché tutte le preferenze stanno così nello stesso menu (o: vivono nel pannello del campanello, accanto alla cronologia, e il menu utente non le ha).
Compreso, senza scelta: «Riga della board» passa da Aspetto a Vista, perché dice cosa mostra la colonna; in Vista «Archiviati» diventa un interruttore e l'ordine un segmento a due che mostra quello attivo (oggi la voce dice il modo successivo); l'anteprima di Aspetto sparisce, perché il menu non copre la chat e ogni cambio si vede dal vivo; Aspetto e Notifiche scrivono in coda alla riga come stanno, come già fa Vista; la pill «Theme» della palette dice il tema attuale e i suoi tre stati (oggi tre stati e due icone: il sole solo su Scuro, la luna sia su Chiaro sia su Sistema, quindi non dice né dove sei né dove vai); `voiceMode`, che nessun controllo scrive, esce da `AppSettings`; i siti «tieni sempre attivo» si vedono e si tolgono da Sistema, Prestazioni (oggi si aggiungono e non si tolgono da nessuna parte); ogni etichetta nuova passa dal dizionario in italiano e inglese (oggi «Font Size», «Theme», «Play sound» sono inglese scritto a mano accanto a «Ricevi su questo dispositivo»); il primo livello del menu impara le frecce, che oggi ha solo nei sottolivelli; sul telefono il menu del titolo ha gli stessi livelli del menu utente, aperti come foglio dal basso; il movimento è quello condiviso del lavoro sull'animazione (entrata e uscita in 90 ms, niente con «riduci movimento»), più il pallino degli interruttori e l'indicatore dei segmenti che scorrono nello stesso tempo.
Fuori: il contenuto di Provider AI, Strumenti, Calendario, Piano e Nodi (si spostano, non si ridisegnano); le preferenze di una singola chat (silenzia, autonomia, effort nel composer); le scorciatoie rimappabili (change `remappable-shortcuts`); l'animazione degli altri menu dell'app (è il lavoro sull'animazione); qualsiasi migration: ogni preferenza resta salvata dove sta oggi.
ok / ok ma 2 no

---

# Il menu utente diventa il posto di ogni impostazione

Richiesta di Attilio del 01/10 (testo in `.openspec.yaml`). Il 02/10 ha
cambiato le scelte 1 e 2: anche i moduli entrano nel menu, e la riga e la
finestra Impostazioni spariscono (`modifiche` in `.openspec.yaml`; sotto,
«Modifica del 02/10»). Il resto di questa pagina racconta la proposta del
01/10 com'era: dove dice «pannello Impostazioni», oggi c'è un livello del menu.

## Dove cambiarla

| # | Dove cambiarla |
|---|----------------|
| 1 | `USERMENU-01`, `USERMENU-06`, `USERMENU-10`; design §1 |
| 2 | `USERMENU-06`; design §5 |
| 3 | `USERMENU-05`, `USERMENU-09`; `SETORG-01`, `APPSET-03`, `APPSET-05` (modificati); design §4, §7 |
| 4 | `USERMENU-04`, `USERMENU-09`; design §3, §7 |
| 5 | `USERMENU-03`, `NOTIF-PERM-01` (modificato); design §2 |

Mockup di oggi e della proposta, chiaro e scuro: `mockup.html`. Screenshot di
oggi (WebKit, server di test isolato): `screenshots/`.

## Why

Il menu utente (la card in fondo alla colonna, `ProfileMenu.tsx`) ha già quasi
tutto: account, amici, gruppi, dispositivi, Vista, Pannelli, Cronologia, stato
della macchina, versione, riavvio. Le preferenze no: la riga «Impostazioni»
(`TopicsMenuItems.tsx:257-265`) apre una finestra con dieci voci
(`Settings/sections.ts:50-70`), e quattro di quelle voci ridisegnano in parte
cose che il menu o la tab Profilo hanno già sul desktop. In parte: ognuna ha
anche un pezzo che esiste solo lì, e sul telefono il menu utente non c'è
(sotto, «Ripetizioni»).

### Inventario: ogni impostazione e ogni porta

Frequenza d'uso: **non misurata**. L'app non registra i cambi di preferenza
(`ui_state` tiene solo l'ultimo valore, `app_settings` una riga sola). Misurato
invece, su una copia del backup del DB vivo del 29/09 (cestinata dopo), quali
valori sono diversi dal default (`client/src/lib/settings.ts`): delle 12
preferenze locali solo `floatingSplits` (acceso); tema `system` (default);
colonna `timeline`, archiviati spenti (default); sul server provider
`claude-code`, effort `high`, Discord acceso, costo non pubblicato.

| Impostazione | Dove si cambia (file:riga) | Doppioni | Stato al 29/09 |
|---|---|---|---|
| Tema | Impostazioni, Aspetto `AppearanceSection.tsx:101-128`; pill «Theme» della palette `CommandPalette.tsx:884-889` | sì, 2 porte; la pill cicla 3 stati (`useTheme.ts:134-140`) con icona sole/luna | default (`system`) |
| Dimensione testo | Aspetto `AppearanceSection.tsx:36-64` | vicino a zoom ⌘= ⌘- ⌘0 (`shared/shortcuts.ts:194-196`), che è un'altra cosa | default (13) |
| Larghezza chat | Aspetto `AppearanceSection.tsx:71-98` | no | default (820) |
| Densità messaggi | Aspetto `AppearanceSection.tsx:131-168` | no | default |
| Anteprima | Aspetto `AppearanceSection.tsx:171-193` | non è un'impostazione | n/a |
| Finestre fluttuanti (Beta, desktop) | Aspetto `AppearanceSection.tsx:199-221` | no | **cambiata** (acceso) |
| Riga della board in colonna | Aspetto `AppearanceSection.tsx:229-240` | sta in Aspetto ma dice cosa mostra la colonna | default |
| Lingua | Aspetto `AppearanceSection.tsx:252-255` | no | default (`auto`) |
| Scorciatoie (rimando) | Aspetto `AppearanceSection.tsx:266-278`; ⌘/ | rimando, non impostazione | n/a |
| Notifiche, suono, anche a fuoco | Notifiche `NotificationsSection.tsx:394-415`; ingranaggio del campanello porta qui `NotificationHistoryButton.tsx:173`, `App.tsx:1805,1816` | porta verso la sezione | default |
| Permesso dei banner di sistema (stato e tasto che lo chiede o apre Impostazioni di Sistema) | Notifiche `NativeBannerStatus`, `NotificationsSection.tsx:33-66`, montato a `:391`; requisito NOTIF-PERM-01 (`openspec/specs/notifications/spec.md:715-743`) | no | non misurato (per macchina) |
| Accesso completo al disco per rispettare «Non disturbare» | Notifiche `FocusGateStatus`, `NotificationsSection.tsx:123-152`, montato a `:392`, solo quando il cancello è bloccato | no | non misurato (per macchina) |
| Notifiche su questo dispositivo (iscrizione push) | Notifiche `PushDevices`, `NotificationsSection.tsx:422`; banner `PushEnrollPrompt` | 2 porte, stesso gesto | non misurato (per dispositivo) |
| Ricevi qui, «Quando Topics è già aperto» (notifica di sistema o banner in Topics), «Disattiva qui» | Notifiche `NotificationsSection.tsx:289-333` (`push-when-open`, `push-unsubscribe`) | no | non misurato (per dispositivo) |
| Push degli altri dispositivi (acceso/spento per ciascuno) | Notifiche `NotificationsSection.tsx:336-361` | no | non misurato |
| Progetti silenziati | menu del progetto `TopicTree.tsx:2254-2266` (metti/togli); Notifiche `NotificationsSection.tsx:426` (solo togli) | 2 porte | vuoto |
| Chat silenziata | impostazioni della chat `TopicSettingsModal.tsx:133` | no, è per chat | non misurato |
| Siti sempre attivi | scheda di pausa `useNativePanePause.ts:304-305` | **nessun posto per toglierli** | vuoto |
| `voiceMode` | nessun controllo; letto da `useVoiceLoop.ts:83` | **morto nella UI** | default (`off`) |
| Archiviati, ordine della colonna | menu utente, Vista `TopicsMenuItems.tsx:124-157`; stesso componente nel menu del telefono `App.tsx:2272-2283` | no (un componente, due host) | default |
| Reimposta / disponi pannelli | menu, Pannelli `TopicsMenuItems.tsx:162-202`; palette `CommandPalette.tsx:443-460` | comandi, doppione voluto per la tastiera | n/a |
| Apri Impostazioni | menu `TopicsMenuItems.tsx:257`; palette `CommandPalette.tsx:883`; ⌘, `useKeyboardShortcuts.ts:519`; `ProviderLimitNotice.tsx:68`; `AiExecutionMenuOptions.tsx:228,321` | 5 porte, una destinazione | n/a |
| Accedi / esci (account) | menu `AccountPanel.tsx:127-214`, **solo desktop** (`ProfileMenu` si monta con `!isMobile`, `App.tsx:1959-1961`); Impostazioni, Profilo `IdentityPages.tsx:70` (`AccountSection`) | desktop 2 copie; **telefono 1, solo nelle Impostazioni** (la porta Profilo apre la tab, `App.tsx:2032`, che non ha account) | non misurato |
| Nome, foto, bio | Impostazioni, Profilo `IdentityPages.tsx:65`; tab Profilo `SelfProfile.tsx:84-90` | **sì, lo stesso `ProfileHeader` due volte** | non misurato |
| Cifre di Topics (sessioni, task, token, ore, progetti, spesa) | Impostazioni, Profilo `ProfileStatsSection.tsx:198-250` | no: la tab Profilo ha altre cifre (`ProfileTopicsStats`, prompt e token, `ProfileHeader.tsx:288`) | n/a |
| Banner da incollare in un documento | Impostazioni, Profilo `ProfileStatsSection.tsx:254-311` | no | n/a |
| Pagina pubblica (Pubblica, Apri, Copia, Revoca) | Impostazioni, Profilo `ProfileStatsSection.tsx:313-380`; requisito APPSET-07 (`openspec/specs/settings/spec.md:274`) | no: `ProfileStatsSection` si monta solo in `IdentityPages.tsx:66` | non pubblicata |
| Pubblica il costo (sotto-opzione della pagina pubblica) | Impostazioni, Profilo `ProfileStatsSection.tsx:395-400` | no | default (spento) |
| Presenza Discord | Impostazioni, Profilo `DiscordSection.tsx:172` | no | acceso, `detailed` |
| Privacy | tab Profilo, menu Privacy `PrivacySection.tsx:138` | no (la pagina doppia è già stata tolta) | non misurato |
| Amici e seguaci | Impostazioni, Seguaci `IdentityPages.tsx:76-86`; tab Profilo `SelfProfile.tsx:106-126`; menu, Amici (accetta/rifiuta) `ProfileMenu.tsx:259-303` | **sì, 3 posti** | non misurato |
| Persone (chi c'è da seguire) | Impostazioni, Seguaci, scheda «Persone» `FollowersSection.tsx:82,122-124` | no: la tab Profilo ha solo amici, seguaci, seguiti e privacy (`ProfilePanel`, `SelfProfile.tsx:41`) | non misurato |
| Organizzazione (membri, ruoli, progetti) | Impostazioni, Organizzazione `IdentityPages.tsx:100-116`; tab Profilo `ProfilePane.tsx:88` via menu, Gruppi, Gestisci `ProfileMenu.tsx:366` | **sì, la stessa pagina in 2 host** | non misurato |
| Dispositivi (rinomina, revoca) | Impostazioni, Dispositivi `DevicesSection.tsx:444,537`; menu, Dispositivi (solo elenco) `ProfileMenu.tsx:401-470` con «Gestisci» verso le Impostazioni `App.tsx:1964`, **solo desktop** | desktop l'elenco 2 volte; **telefono 1, solo nelle Impostazioni** | non misurato |
| Di chi è un dispositivo (sposta su un'altra persona) | Impostazioni, Dispositivi `DevicesSection.tsx:476-513` (`device-move-person`), solo con più di una persona | no | non misurato |
| Nodi: aggiungere una macchina (indirizzo, codice, esito; MACHINE-02) | Impostazioni, Dispositivi `DevicesSection.tsx:568-640` (`settings-node-pair`) | no | non misurato |
| Richieste da altri computer (cartella e identità da scegliere) | Impostazioni, Dispositivi `DevicesSection.tsx:566` (`RemoteNodeRequests`) | no | non misurato |
| Provider AI (predefinito, modello, effort, attivazione, approvazione) | Impostazioni, Provider AI `AIProvidersSection.tsx:508-600` | effort per chat nel composer (EFFORTUI-01): default contro per chat, non doppione | `claude-code`, `high` |
| Esecuzione, endpoint diretti, CLI locali | Provider AI, Avanzate `AIProvidersSection.tsx:233,258-271` | no | non misurato |
| Strumenti MCP e permessi | Impostazioni, Strumenti `ToolsSection.tsx:8-10` | no | non misurato |
| Calendario | Impostazioni, Calendario `CalendarSection.tsx` | no | non misurato |
| Piano e licenza | Impostazioni, Piano `PlanSection.tsx` | no | non misurato |
| Versione, riavvio | menu `SidebarSystemMenu.tsx:399-449` | no | n/a |

### Ripetizioni e cose ridondanti

- **Quattro voci delle Impostazioni sono copie in parte, e ognuna ha un pezzo
  che sta solo lì.** Misurato sul desktop e sul telefono, non solo sul primo:
  - Profilo: il `ProfileHeader` è lo stesso della tab, ma cifre, banner,
    pagina pubblica (Pubblica, Revoca, costo) e Discord stanno solo qui
    (`ProfileStatsSection` è montato solo in `IdentityPages.tsx:66`).
  - Seguaci: amici, seguaci e seguiti sono anche nella tab; la scheda
    «Persone», da cui trovi chi seguire, sta solo qui
    (`FollowersSection.tsx:82,122-124`).
  - Organizzazione: lo stesso `OrganizationPage` che la tab apre da
    «Gestisci». Questa sì, copia intera.
  - Dispositivi: l'elenco è anche nel livello del menu, ma «di chi è»
    (`DevicesSection.tsx:476-513`), i Nodi (`:568-640`) e le richieste da altri
    computer (`:566`) stanno solo qui.
- **L'account due volte sul desktop, una sola sul telefono.** Sul desktop
  `AccountPanel` in cima al menu e `AccountSection` nella pagina Profilo, con
  testi diversi per lo stesso gesto (`statusBar.account.signIn` contro
  `account.sendCode`). Sul telefono il menu utente non c'è (`App.tsx:1959-1961`):
  il menu del titolo ha solo `TopicsMenuItems` e `SidebarSystemMenu`
  (`App.tsx:2272-2294`), la porta Profilo apre la tab (`App.tsx:2032`) e la tab
  non ha account. Lì accedi/esci, rinomina e revoca esistono solo nelle
  Impostazioni: toglierle da lì senza dar loro una casa sul telefono le
  toglierebbe del tutto.
- **Righe che portano altrove**: «Gestisci» dei Dispositivi apre la copia nelle
  Impostazioni; l'ingranaggio del campanello apre la sezione Notifiche; la riga
  «Impostazioni» apre una finestra dove si sceglie di nuovo.
- **Stato detto al contrario**: la voce dell'ordine in Vista dice il modo
  *successivo* (`TopicsMenuItems.tsx:113-117`), «Archiviati» si legge solo dal
  colore del testo; la pill «Theme» ha due icone per tre stati
  (`CommandPalette.tsx:886`, ciclo chiaro → scuro → sistema in
  `useTheme.ts:134-140`): il sole solo su Scuro, dove il clic porta a Sistema,
  la luna sia su Chiaro (il clic porta a Scuro) sia su Sistema (il clic porta a
  Chiaro). L'icona non dice né il tema di adesso né quello dopo.
- **Preferenze senza casa**: `keepLiveSites` si aggiunge e non si toglie;
  `voiceMode` non ha controllo.
- **Lingue mescolate** nel pannello: «Settings», «Font Size», «Message
  Density», «Preview», «Play sound» scritti a mano in inglese accanto a
  «Ricevi su questo dispositivo», «Modello di default», contro SETORG-01.
- **Tre interruttori**: `Shared/Switch`, `ToggleRow` (che lo usa) e uno
  privato in `PrivacySection.tsx:43`.

### Screenshot di oggi

WebKit, server di test isolato, 1400x900 e 390x844, in `screenshots/`:
`today-menu-{light,dark}.png`, `today-menu-view-level-{light,dark}.png`,
`today-settings-<sezione>-light.png` per le dieci voci,
`today-settings-{appearance,notifications}-dark.png`,
`today-phone-menu-light.png`.

## What changes

Il menu utente, dall'alto. Sul desktop è la card in fondo alla colonna; sul
telefono è il menu del titolo, che guadagna in cima lo stesso blocco
dell'identità (un componente, due host, come già `TopicsMenuItems`):

- **Account** come oggi, anche sul telefono. È l'unica casa di accedi/esci.
- **Amici, Gruppi** come oggi, anche sul telefono. **Dispositivi**: rinomina e
  revoca sulla riga, conferma in linea; «Di chi è» in un livello della riga,
  solo se le persone sono più di una; «Revocati» in un livello sotto; niente
  più «Gestisci».
- **Aspetto** (nuovo livello, in coda «Sistema · 13 px»): Tema (segmento a tre
  con icone), Testo (passo da 12 a 18), Larghezza chat (passo, «Piena» in
  fondo), Densità (segmento a due), Finestre fluttuanti (interruttore, solo
  desktop), Lingua (`Select` dell'app), e in fondo il rimando alle scorciatoie.
- **Notifiche** (nuovo livello, in coda «Attive» o «Spente»): notifiche, suono,
  anche sulla chat aperta; il permesso dei banner di sistema con il tasto che
  lo chiede o apre Impostazioni di Sistema (NOTIF-PERM-01, solo quando il tasto
  fa qualcosa); l'accesso al disco per «Non disturbare» (solo quando manca);
  «Questo dispositivo», livello con iscrizione, ricevi qui, «Quando Topics è
  già aperto» (segmento: notifica di sistema / banner in Topics) e «Disattiva
  qui»; «Altri dispositivi», livello con un interruttore per ciascuno (solo se
  ce ne sono); progetti silenziati con «Riattiva» (solo se ce ne sono).
- **Vista**: Archiviati (interruttore), Ordine (segmento Cronologico / Per
  stato), Riga della board (interruttore, da Aspetto).
- **Pannelli, Cronologia** come oggi.
- **Impostazioni** ⌘, : Provider AI, Strumenti, Calendario, Piano, Nodi
  (aggiungi un nodo con indirizzo e codice, MACHINE-02; le richieste da altri
  computer). Nient'altro. *Superato il 02/10: questi cinque sono livelli del
  menu e la riga non c'è più (sotto).*
- **Sistema, Versione, Riavvia** come oggi; Sistema, Prestazioni guadagna i
  siti sempre attivi con «Togli».

La tab Profilo prende quel che oggi sta solo nelle Impostazioni: la scheda
**Persone** accanto a seguaci, seguiti e amici; un pannello **Fuori da Topics**
accanto a Privacy, con le cifre, il banner, la pagina pubblica (Pubblica, Apri,
Copia, Revoca, e il costo come sua sotto-opzione, APPSET-07 invariato) e la
presenza Discord.

Le preferenze nuove nel menu scrivono con le stesse funzioni di oggi
(`saveSettings`, `setTheme`, `pushOutputLanguage`, le route dei dispositivi):
cambia la superficie, non il deposito.

## Non-goals

- Ridisegnare le pagine che restano nelle Impostazioni.
- Spostare preferenze di una singola chat nel menu.
- Una ricerca dentro le preferenze: sono una ventina di controlli in quattro
  livelli.
- Animare gli altri menu dell'app (lavoro sull'animazione, in corso a parte).
- Toccare `app_settings`, `ui_state` o lo schema.

## Impact

Client: `client/src/components/Sidebar/ProfileMenu.tsx` (Dispositivi in linea,
blocco dell'identità estratto in un nuovo `Sidebar/IdentityMenuItems.tsx`),
`client/src/App.tsx` (il menu del titolo del telefono monta
`IdentityMenuItems`; `onOpenDevices` sparisce), `Sidebar/IdentityBlock.tsx`
(i dati del blocco diventano un hook che usano i due host),
`TopicsMenuItems.tsx` (Aspetto, Notifiche, Vista nuova), nuovi
`Sidebar/AppearanceLevel.tsx`, `Sidebar/NotificationsLevel.tsx`,
`Shared/Segmented.tsx`, `Shared/Stepper.tsx`;
`Sidebar/PresencePopover.tsx` (frecce sul primo livello);
`Sidebar/SidebarSystemMenu.tsx` (siti sempre attivi);
`Sidebar/NotificationHistoryButton.tsx` (ingranaggio); `Settings/sections.ts`,
`Settings/GlobalSettings.tsx`, `Settings/IdentityPages.tsx` (voci tolte);
`Settings/NotificationsSection.tsx` (i pezzi `NativeBannerStatus`,
`FocusGateStatus`, `PushDevices`, `MutedProjects` passano al livello);
`Settings/DevicesSection.tsx` (diventa `Settings/NodesSection.tsx` con il
riquadro Nodi e `RemoteNodeRequests`; «di chi è», rinomina e revoca vanno al
menu); `Profile/SelfProfile.tsx` (pannelli `people` e `outside`),
`Settings/ProfileStatsSection.tsx` e `Settings/DiscordSection.tsx` (passano
sotto `Profile/`); `Profile/PrivacySection.tsx` (`Shared/Switch`);
`Shared/CommandPalette.tsx` (pill del tema); `lib/openSettings.ts` (le sezioni
tolte reindirizzano); `types/index.ts`, `lib/settings.ts` (`voiceMode`);
`hooks/useVoiceLoop.ts`; i18n `client/src/lib/i18n-it.ts`, `i18n-en.ts`.

E2E che entrano da una voce tolta e cambiano porta, non asserzione:
`settings-profile-devices`, `profile-followers`, `profile-discord`,
`refused-gestures`, `push-phone-enroll`, `settings-mobile`,
`settings-lingua-org`, `org-presence`, `org-projects-scope`, `profile-menu`.
Il riquadro Nodi oggi non ha un E2E: lo spostamento ne aggiunge uno.

Server: nessuno.

Specs: `settings` (USERMENU-01…09 aggiunti; SETORG-01, APPSET-03, APPSET-05
modificati); `notifications` (NOTIF-PERM-01 modificato: la casa del permesso
passa dal pannello Impostazioni al livello Notifiche, il comportamento resta).

## Modifica del 02/10: tutto nel menu

Richiesta: «vedo ancora cose che possono essere messe direttamente nel menu
utente, come provider, calendario etc.. meglio evitarlo proprio il tasto
secondo me. inoltre lavorare al top su ui ux, ad esempio su piano nel menu
utente si può mostrare direttamente il piano che ha anche l'utente.»

Il menu utente, dall'alto, separato in gruppi dalle linee sottili che ha già:

- **Account**, e subito sotto **Piano** («Gratuito», «Team · 5 posti»; a
  trenta giorni dalla scadenza «· scade tra 12 g» in ambra): cosa sei e cosa
  paghi.
- **Amici, Gruppi**, come prima.
- **Dispositivi**, poi **Nodi** («2 nodi», e un badge con le richieste da
  altri computer, che aspettano una risposta): le macchine insieme. La riga
  delle richieste nel livello Dispositivi apre il livello Nodi.
- **Provider AI** («Topics · Max 20x»), **Strumenti** («3 attivi»),
  **Calendario** («Collegato», «In pausa», «Non collegato»): su cosa gira
  l'app e cosa raggiunge. Dentro Provider AI, in cima, l'abbonamento Claude e
  la finestra di 5 ore già usata («al 42% · riparte alle 20:49»), letti
  insieme.
- **Aspetto, Notifiche, Vista, Pannelli, Cronologia**, poi Sistema, come
  prima.

I cinque moduli sono livelli larghi 400 px (mai più della finestra meno i
margini), con l'intestazione fissa (nome e chiudi) e il corpo che scorre sotto
la stessa altezza massima del menu; sul telefono sono fogli dal basso a tutta
larghezza. Dentro un livello un campo tiene ogni tasto (frecce, Home, End,
Invio), Escape in un campo chiude solo il livello, Tab resta nel livello, e
una conferma chiesta da lì («Togli la licenza?») o la lista di una `Select`
non chiudono il menu.

Le code si leggono solo a menu aperto, una volta per apertura e di nuovo
quando un livello si chiude (nessun polling a menu chiuso): `/api/license`,
lo snapshot dei provider (già tenuto vivo dal socket), `/api/mcp/fleet?peek=1`
(che non monta la flotta), `/api/app-settings`, `/api/machines` e le
richieste dei nodi. L'abbonamento Claude esce dal server come due etichette
(`subscriptionType`, `rateLimitTier`), mai la credenziale
(`server/providers/claude/subscription.ts`, con il test che lo prova).

Escono `GlobalSettings.tsx`, `Settings/sections.ts`, `lib/openSettings.ts` e
l'evento `topics:open-settings`; ⌘, apre il menu col fuoco sulla prima riga.
Restano come sono le impostazioni della board e quelle della singola chat.

Screenshot (WebKit, server di test isolato), chiaro e scuro:
`screenshots/proposal-menu-all-*.png`.
