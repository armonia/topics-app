## Da decidere

Menu utente e Impostazioni: 5 scelte prima del codice.
1. Aspetto, Notifiche, Vista e Dispositivi diventano controlli diretti dentro il menu utente (interruttori, segmenti, passi, applicati subito); nel pannello Impostazioni restano solo i moduli da compilare (provider AI, strumenti MCP, calendario, piano, computer remoti), perché chiavi API, URL e token non si scrivono bene in un livello largo 288 px (o: tutto nel menu, anche i moduli, in livelli lunghi che scorrono).
2. Quel che resta si chiama ancora Impostazioni, si apre con ⌘, o dall'ultima riga del menu ed è sempre la finestra sopra l'app, perché si apre poche volte e ⌘, è l'abitudine di ogni app Mac (o: diventa una tab come Profilo, da tenere accanto alla chat mentre provi un provider).
3. Chi sei sta in un posto solo, la tab Profilo: dalle Impostazioni escono Profilo, Seguaci e Organizzazione (oggi doppioni della tab), Discord e «pubblica il costo» entrano nel menu Privacy della tab, e accedi/esci resta solo in cima al menu utente, perché oggi profilo, account, amici e gruppi si cambiano da due o tre porte con nomi diversi (o: il contrario, l'identità resta nelle Impostazioni e la tab Profilo torna solo da leggere).
4. I dispositivi si gestiscono nel loro livello del menu: rinomina e revoca sulla riga con conferma in linea, i revocati in un livello sotto, perché oggi l'elenco è disegnato due volte e il gesto che conta sta dietro «Gestisci», che apre l'altra copia (o: il livello resta un elenco da leggere e «Gestisci» continua ad aprire le Impostazioni).
5. L'ingranaggio del campanello apre il menu utente sul livello Notifiche, unica casa di quelle preferenze, perché tutte le preferenze stanno così nello stesso menu (o: le preferenze delle notifiche vivono nel pannello del campanello, accanto alla cronologia, e il menu utente non le ha).
Compreso, senza scelta: «Riga della board» passa da Aspetto a Vista, perché dice cosa mostra la colonna; in Vista «Archiviati» diventa un interruttore e l'ordine un segmento a due che mostra quello attivo (oggi la voce dice il modo successivo); l'anteprima di Aspetto sparisce, perché il menu non copre la chat e ogni cambio si vede dal vivo; Aspetto e Notifiche scrivono in coda alla riga come stanno, come già fa Vista; la pill «Theme» della palette dice il tema attuale e i suoi tre stati (oggi cicla tre stati con un'icona a due); `voiceMode`, che nessun controllo scrive, esce da `AppSettings`; i siti «tieni sempre attivo» si vedono e si tolgono da Sistema, Prestazioni (oggi si aggiungono e non si tolgono da nessuna parte); ogni etichetta nuova passa dal dizionario in italiano e inglese (oggi «Font Size», «Theme», «Play sound» sono inglese scritto a mano accanto a «Ricevi su questo dispositivo»); il primo livello del menu impara le frecce, che oggi ha solo nei sottolivelli; sul telefono gli stessi livelli Aspetto e Notifiche nel menu del titolo, come foglio dal basso; il movimento è quello condiviso del lavoro sull'animazione (entrata e uscita in 90 ms, niente con «riduci movimento»), più il pallino degli interruttori e l'indicatore dei segmenti che scorrono nello stesso tempo.
Fuori: il contenuto di Provider AI, Strumenti, Calendario e Piano (si spostano, non si ridisegnano); le preferenze di una singola chat (silenzia, autonomia, effort nel composer); le scorciatoie rimappabili (change `remappable-shortcuts`); l'animazione degli altri menu dell'app (è il lavoro sull'animazione); qualsiasi migration: ogni preferenza resta salvata dove sta oggi.
ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `USERMENU-01`, `USERMENU-06`; design §1 |
| 2 | `USERMENU-06`; design §5 |
| 3 | `USERMENU-05`, `SETORG-01`, `APPSET-03`, `APPSET-05` (modificati); design §4 |
| 4 | `USERMENU-04`; design §3 |
| 5 | `USERMENU-03`; design §2 |

Mockup di oggi e della proposta, chiaro e scuro: `mockup.html`. Screenshot di
oggi (WebKit, server di test isolato): `screenshots/`.

---

# Il menu utente diventa il posto delle preferenze, e le Impostazioni tengono solo i moduli

Richiesta di Attilio del 01/10 (testo in `.openspec.yaml`).

## Why

Il menu utente (la card in fondo alla colonna, `ProfileMenu.tsx`) ha già quasi
tutto: account, amici, gruppi, dispositivi, Vista, Pannelli, Cronologia, stato
della macchina, versione, riavvio. Le preferenze no: la riga «Impostazioni»
(`TopicsMenuItems.tsx:257-265`) apre una finestra con dieci voci
(`Settings/sections.ts:50-70`), e quattro di quelle voci ridisegnano cose che il
menu o la tab Profilo hanno già.

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
| Notifiche su questo dispositivo (push) | Notifiche `NotificationsSection.tsx:422`; banner `PushEnrollPrompt` | 2 porte, stesso gesto | non misurato (per dispositivo) |
| Progetti silenziati | menu del progetto `TopicTree.tsx:2254-2266` (metti/togli); Notifiche `NotificationsSection.tsx:426` (solo togli) | 2 porte | vuoto |
| Chat silenziata | impostazioni della chat `TopicSettingsModal.tsx:133` | no, è per chat | non misurato |
| Siti sempre attivi | scheda di pausa `useNativePanePause.ts:304-305` | **nessun posto per toglierli** | vuoto |
| `voiceMode` | nessun controllo; letto da `useVoiceLoop.ts:83` | **morto nella UI** | default (`off`) |
| Archiviati, ordine della colonna | menu utente, Vista `TopicsMenuItems.tsx:124-157`; stesso componente nel menu del telefono `App.tsx:2272-2283` | no (un componente, due host) | default |
| Reimposta / disponi pannelli | menu, Pannelli `TopicsMenuItems.tsx:162-202`; palette `CommandPalette.tsx:443-460` | comandi, doppione voluto per la tastiera | n/a |
| Apri Impostazioni | menu `TopicsMenuItems.tsx:257`; palette `CommandPalette.tsx:883`; ⌘, `useKeyboardShortcuts.ts:519`; `ProviderLimitNotice.tsx:68`; `AiExecutionMenuOptions.tsx:228,321` | 5 porte, una destinazione | n/a |
| Accedi / esci (account) | menu `AccountPanel.tsx:127-214`; Impostazioni, Profilo `IdentityPages.tsx:70` (`AccountSection`) | **sì, 2 copie** | non misurato |
| Nome, foto, bio | Impostazioni, Profilo `IdentityPages.tsx:65`; tab Profilo `SelfProfile.tsx:84-90` | **sì, lo stesso `ProfileHeader` due volte** | non misurato |
| Pubblica il costo | Impostazioni, Profilo `ProfileStatsSection.tsx:395` | no | default (spento) |
| Presenza Discord | Impostazioni, Profilo `DiscordSection.tsx:172` | no | acceso, `detailed` |
| Privacy | tab Profilo, menu Privacy `PrivacySection.tsx:138` | no (la pagina doppia è già stata tolta) | non misurato |
| Amici e seguaci | Impostazioni, Seguaci `IdentityPages.tsx:76-86`; tab Profilo `SelfProfile.tsx:106-126`; menu, Amici (accetta/rifiuta) `ProfileMenu.tsx:259-303` | **sì, 3 posti** | non misurato |
| Organizzazione (membri, ruoli, progetti) | Impostazioni, Organizzazione `IdentityPages.tsx:100-116`; tab Profilo `ProfilePane.tsx:88` via menu, Gruppi, Gestisci `ProfileMenu.tsx:366` | **sì, la stessa pagina in 2 host** | non misurato |
| Dispositivi (rinomina, revoca) | Impostazioni, Dispositivi `DevicesSection.tsx:444,537`; menu, Dispositivi (solo elenco) `ProfileMenu.tsx:401-470` con «Gestisci» verso le Impostazioni `App.tsx:1964` | **sì, l'elenco 2 volte** | non misurato |
| Computer remoti (richieste di esecuzione) | Impostazioni, Dispositivi `DevicesSection.tsx:566` | no | non misurato |
| Provider AI (predefinito, modello, effort, attivazione, approvazione) | Impostazioni, Provider AI `AIProvidersSection.tsx:508-600` | effort per chat nel composer (EFFORTUI-01): default contro per chat, non doppione | `claude-code`, `high` |
| Esecuzione, endpoint diretti, CLI locali | Provider AI, Avanzate `AIProvidersSection.tsx:233,258-271` | no | non misurato |
| Strumenti MCP e permessi | Impostazioni, Strumenti `ToolsSection.tsx:8-10` | no | non misurato |
| Calendario | Impostazioni, Calendario `CalendarSection.tsx` | no | non misurato |
| Piano e licenza | Impostazioni, Piano `PlanSection.tsx` | no | non misurato |
| Versione, riavvio | menu `SidebarSystemMenu.tsx:399-449` | no | n/a |

### Ripetizioni e cose ridondanti

- **Quattro voci delle Impostazioni sono copie.** Profilo (stesso
  `ProfileHeader` della tab), Seguaci (la tab ha amici, seguaci e seguiti; il
  menu ha amici con accetta/rifiuta), Organizzazione (lo stesso
  `OrganizationPage` che la tab apre da «Gestisci»), Dispositivi (l'elenco che
  il livello del menu disegna già, in grande).
- **L'account due volte**: `AccountPanel` in cima al menu e `AccountSection`
  nella pagina Profilo, con testi diversi per lo stesso gesto
  (`statusBar.account.signIn` contro `account.sendCode`).
- **Righe che portano altrove**: «Gestisci» dei Dispositivi apre la copia nelle
  Impostazioni; l'ingranaggio del campanello apre la sezione Notifiche; la riga
  «Impostazioni» apre una finestra dove si sceglie di nuovo.
- **Stato detto al contrario**: la voce dell'ordine in Vista dice il modo
  *successivo* (`TopicsMenuItems.tsx:113-117`), «Archiviati» si legge solo dal
  colore del testo; la pill «Theme» mostra la luna anche quando il clic porta
  a «Sistema».
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

Il menu utente, dall'alto (desktop; sul telefono il menu del titolo ha le
stesse righe da Aspetto in giù):

- **Account** come oggi. È l'unica casa di accedi/esci.
- **Amici, Gruppi** come oggi. **Dispositivi**: rinomina e revoca sulla riga,
  conferma in linea, «Revocati» in un livello sotto; niente più «Gestisci».
- **Aspetto** (nuovo livello, in coda «Sistema · 13 px»): Tema (segmento a tre
  con icone), Testo (passo da 12 a 18), Larghezza chat (passo, «Piena» in
  fondo), Densità (segmento a due), Finestre fluttuanti (interruttore, solo
  desktop), Lingua (`Select` dell'app), e in fondo il rimando alle scorciatoie.
- **Notifiche** (nuovo livello, in coda «Attive» o «Spente»): notifiche,
  suono, anche sulla chat aperta, questo dispositivo (stato e «Attiva»),
  progetti silenziati con «Riattiva» (solo se ce ne sono).
- **Vista**: Archiviati (interruttore), Ordine (segmento Cronologico / Per
  stato), Riga della board (interruttore, da Aspetto).
- **Pannelli, Cronologia** come oggi.
- **Impostazioni** ⌘, : Provider AI, Strumenti, Calendario, Piano, Computer
  remoti. Nient'altro.
- **Sistema, Versione, Riavvia** come oggi; Sistema, Prestazioni guadagna i
  siti sempre attivi con «Togli».

Le preferenze nuove nel menu scrivono con le stesse funzioni di oggi
(`saveSettings`, `setTheme`, `pushOutputLanguage`, le route dei dispositivi):
cambia la superficie, non il deposito.

## Non-goals

- Ridisegnare le pagine che restano nelle Impostazioni.
- Spostare preferenze di una singola chat nel menu.
- Una ricerca dentro le preferenze: sono 14 controlli in tre livelli.
- Animare gli altri menu dell'app (lavoro sull'animazione, in corso a parte).
- Toccare `app_settings`, `ui_state` o lo schema.

## Impact

Client: `client/src/components/Sidebar/ProfileMenu.tsx` (Dispositivi in linea),
`TopicsMenuItems.tsx` (Aspetto, Notifiche, Vista nuova), nuovi
`Sidebar/AppearanceLevel.tsx`, `Sidebar/NotificationsLevel.tsx`,
`Shared/Segmented.tsx`, `Shared/Stepper.tsx`;
`Sidebar/PresencePopover.tsx` (frecce sul primo livello);
`Sidebar/SidebarSystemMenu.tsx` (siti sempre attivi);
`Sidebar/NotificationHistoryButton.tsx` (ingranaggio); `Settings/sections.ts`,
`Settings/GlobalSettings.tsx`, `Settings/IdentityPages.tsx` (voci tolte);
`Profile/PrivacySection.tsx` (Discord, costo, `Shared/Switch`);
`Shared/CommandPalette.tsx` (pill del tema); `lib/openSettings.ts` (le sezioni
tolte reindirizzano); `types/index.ts`, `lib/settings.ts` (`voiceMode`);
`hooks/useVoiceLoop.ts`; i18n `client/src/lib/i18n-it.ts`, `i18n-en.ts`.

Server: nessuno.

Specs: `settings` (USERMENU-01…08 aggiunti; SETORG-01, APPSET-03, APPSET-05
modificati).
