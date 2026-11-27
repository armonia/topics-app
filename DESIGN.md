---
version: alpha
name: Topics
description: "App di lavoro di Attilio con gli agenti: chat, board dei task, browser, terminali e tray. Densa, calma, si usa tutto il giorno."
colors:
  primary: "#0066ff"
  primary-hover: "#0052cc"
  primary-ink: "#1447e6"
  background: "hsl(220 5.6% 96%)"
  surface: "#ffffff"
  surface-elevated: "hsl(220 4.9% 98.1%)"
  chrome: "hsl(220 5.6% 93%)"
  border: "hsl(220 4.9% 91.4%)"
  text: "hsl(220 3.5% 10.6%)"
  text-secondary: "hsl(220 2.8% 36.4%)"
  text-muted: "hsl(220 2.8% 42.5%)"
  success: "#10b981"
  warning: "#f59e0b"
  on-primary: "#ffffff"
typography:
  mini:
    fontFamily: system-ui
    fontSize: 11px
    lineHeight: 1.4
  compact:
    fontFamily: system-ui
    fontSize: 12px
    lineHeight: 1.4
  prose:
    fontFamily: system-ui
    fontSize: 13px
    lineHeight: 1.55
  title:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.3
  headline:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
  display:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "\"tnum\""
  mono:
    fontFamily: JetBrains Mono
    fontSize: 12px
    lineHeight: 1.5
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary-ink}"
    textColor: "{colors.on-primary}"
    typography: "{typography.compact}"
    rounded: "{rounded.sm}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.mini}"
  chrome-bar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
---

# Topics

I valori veri stanno in `client/src/index.css` (`:root` per il chiaro, il blocco scuro subito
sotto), con la scala dei testi commentata riga per riga e `client/src/styles/contrast-tokens.test.ts`
come barra del contrasto. Se questo file e il CSS non coincidono, vince il CSS e questo file si
riallinea. I componenti stanno in `client/src/ui/`, la galleria in `client/src/ui-gallery/`.

## Overview

Uno strumento da tenere aperto tutto il giorno, non una vetrina: denso, sobrio, veloce. Le
superfici sono grigie e neutre, il blu dice «questo si può fare» e niente altro. Chi lo usa deve
capire a colpo d'occhio cosa sta succedendo e perché, senza aprire un log.

## Colors

Grigi neutri leggermente freddi (tinta 220) su tre piani: chrome della finestra, sfondo,
superfici. Un accento solo, il blu; verde e ambra solo per stati (riuscito, attenzione). Il tema
scuro ha gli stessi ruoli con valori suoi, mai il chiaro invertito.

## Typography

Font di sistema, un solo mono (JetBrains Mono) per codice e terminali. La dimensione di default
dell'interfaccia è 11 px (righe, etichette, menu, chip); 13 px per la prosa dei messaggi. Ogni
dimensione ha un ruolo scritto nel CSS: un valore fuori scala si aggiunge lì, mai a mano.

## Layout

Sidebar, pannelli affiancati e tab; sul telefono una colonna con la barra in basso. Ogni
pannello si apre già al suo primo frame giusto, senza salti.

## Elevation & Depth

Piatta: bordi sottili e piani di grigio. Ombra solo su menu, popover e modali.

## Shapes

Raggio 8 px per pannelli e card, 6 px per bottoni e campi, 4 px per chip piccoli.

## Components

Righe dense di lista, card della board, chip di stato, tab, tendine, modali, la tray della
barra dei menu.

## Do's and Don'ts

- Do: ogni funzione ha la sua interfaccia, interruttore più stato (cosa fa adesso e perché).
- Do: ogni numero ha accanto il valore e una frase; lo calcola un posto solo e ogni superficie
  lo legge da lì.
- Do: i nomi visibili (sessioni, card, righe della tray, cron) dicono il lavoro in parole
  semplici.
- Do: ciò che Attilio deve giudicare si vede dentro Topics, nel task, con immagini grandi.
- Don't: id, nomi di file o comandi nei titoli.
- Don't: una funzione che esiste solo come variabile d'ambiente o riga di log.
- Don't: rifare ciò che non è stato segnalato.
- Don't: hover e fondi scritti a mano (`hover:bg-black/5 dark:hover:bg-white/5`) dove c'è il token
  (`hover:bg-app-hover`, `bg-app-inset`); raggi solo dalla scala (`rounded` 8px pannelli,
  `rounded-sm` 6px controlli, `rounded-xs` 4px chip); l'avviso è `amber-500`, cioè `warning`.
  Corretto più volte, l'ultima il 25/11.

## Riferimenti

- Micro-interazioni e componenti: Bruno Delorence (<https://brunodelorence.com/components>).
- Lo studio di 31 concorrenti in `docs/competitors/`, per i flussi.

## Approvato, non toccare

- La barra della tray («perfetta», 23/10): si lavora solo sul menu a tendina se segnalato.
- La scala dei testi e i token del CSS: si aggiungono ruoli, non si spostano valori.
- Il chip di Jarvis sulla card (avatar blu con l'iniziale e il nome, 15/11 «Jarvis resta com'è»):
  ora è il chip del proprietario quando l'agente è Jarvis, stesso aspetto.
- La Board del 20/11 («va bene così»): barra «Il mio lavoro | Tutto» con i chip dei proprietari e il
  menu dei canali, chip proprietario e canale sulla card, slider del dettaglio, viste «Kanban, Lista,
  Chi la segue, Workflow» con icone; etichette e campo di ricerca seguono la larghezza della board.
- La finestra di un progetto con le tab di lato (25/11 «Sì, va bene»): solo il titolo, che al
  passaggio prende il fondo della tab e si trascina nello split; i comandi del progetto a destra
  sulla stessa riga; nessun «+» lì, resta quello sulla riga del progetto nella colonna.
- Il titolo come tab vera e le isole del progetto (25/11 «Va bene», #1684): con le tab di lato il
  titolo è la tab in primo piano (icona, menu, X col conto alla rovescia, badge, indirizzo intero
  del browser) e la striscia non torna nemmeno a colonna chiusa; i comandi del progetto restano sul
  titolo con la colonna aperta, badge interi; File, Git e Processi sono tre card arrotondate.
- La vista Tabella della board del 25/11 («Sì, unisci» sulle foto a 375, 768, 1440 e 3440): stato,
  poi progetto con la sua icona (il nome accanto da pannello largo), titolo, chip di chi la segue;
  intestazione e righe in un solo riquadro con l'intestazione su `inset`, hover `app-hover` e anello
  di focus sulle righe.
- La tab del browser nel titolo e la grammatica delle righe (26/11 «Approvato», #1688 e #1695):
  dentro un progetto il browser in primo piano è il titolo, alto una riga e largo quanto la tab
  attiva della striscia (300 il browser, 150 le altre) con l'indirizzo, e la sua pagina è un'isola
  coi quattro angoli; righe, intestazioni delle isole e piede della colonna alti 34 e senza fondo a
  riposo; ogni tab, anche chiusa, prende il fondo al passaggio.
- La testata della colonna (26/11 «Approvato», #1695): semafori, «Topics» (sparisce intera quando
  non ci sta), interruttore della colonna, campanella, poi cerca e «+»; i quattro tasti a misura di
  tab (34, 44 sotto 768) senza fondo a riposo; l'interruttore del contenuto compare solo a colonna
  chiusa.
- La prima riga della colonna sul telefono (27/11 «Sì, va bene», #1731): a riposo sta un passo (6)
  sotto la riga compatta del titolo, mai dietro il suo velo; il velo serve solo alle righe che
  scorrono sotto.

## Feedback di Attilio

- 04/08 «così come tutto, deve avere interfaccia di gestione / abilitazione ad hoc con ottima
  UI/UX» → interruttore più stato, calcolato dallo stesso codice del comportamento.
- 23/10 «se questo è il criterio con cui migliora c'è da preoccuparsi» (rifatta la barra della
  tray che era perfetta) → due liste: segnalato e approvato.
- 24/10 «non è spiegato, non c'è nulla… avevo chiesto che fosse consistente e sensato» → tray e
  hub con gli stessi numeri, colori e frasi, più un valore complessivo.
- 24/10 sui nomi nella tray («auto-2» nell'hub) → i nomi dicono il lavoro.
- 11/11 «non dovresti farla tu ma dovrei vederla da topics» → la consegna è il task di Topics,
  non un prototipo o foto in chat; se Topics non le mostra bene, quello è il primo lavoro.
- 12/11 tray bocciata dopo un «prima/dopo» identico → due immagini uguali vogliono dire che la
  versione nuova non è stata catturata.
- 20/11 «dalla Board devo poter comprendere facilmente ciò che vedo», «tutto questo rumore in
  ogni direzione va sistemato» → ogni card dice di chi è (tu, la board, l'agente per nome, una
  sessione, una programmata) e da quale canale; la Board si apre sul lavoro che segui tu.
- 20/11 «la modalità card non ha senso» → ogni vista ha un nome che dice cosa mostra e un'icona
  chiara («Chi la segue», «Workflow»), mai un nome generico.
- 22/11 «la configurazione non dovrebbe essere direttamente sulla pagina dell'agente» → la pagina
  di un agente mostra cosa fa; la configurazione ha una pagina sua, a sezioni con un indirizzo
  ciascuna, e ciò che viene dal sistema è segnato «ereditato».
- 22/11 «agli agenti nella pagina Agenti non vengono mostrate le icone dei canali, come nel resto
  del design system» → ovunque compare un canale si usa il suo marchio (`CHANNEL_MARKS`), mai il
  nome del canale scritto come testo.
- 22/11 «nel sistema non ci dovrebbe essere nulla di nascosto in termini di UI» → ogni guasto di
  sistema ha una riga in una vista Salute unica, col link a dove si sistema.
- 24/11 «non ha senso che ci sia sia tab sopra che tab sul lato.. si dovrebbe poter scegliere» →
  ogni tab sta in un posto solo, e quale lo sceglie chi usa la app (Vista → Tab: di lato | in
  alto); con la sidebar chiusa tornano in alto, mai in nessun posto.
- 24/11 «tutte le tab sono in realtà fissate di default (toglilo come concetto, semplicemente
  possono riordinarselo, ma quelle aperte invece hanno lo sfondo come quelle pinnate» → le righe
  della colonna stanno nell'ordine dato trascinandole, e una tab aperta ha lo sfondo della
  tessera fissata; una riga chiusa non ce l'ha.
- 24/11 «una volta chiusa poi si spunta "fatto" quindi va chiusa due volte» → un gesto, un
  effetto: il cerchio di una tab aperta la chiude, quello di una chiusa la archivia.
- 24/11 «le fissate non si possono chiudere [...] hanno tutte 3 stati aperto-chiuso-archiviato
  (è disabilitabile anche questo dalle opzioni)» e «tutti i tipologie di tab dovrebbero avere il
  triplo stato» → chat, progetti, terminali, browser e pagine di utilità hanno aperta, chiusa,
  archiviata; le fissate si aprono da sole e non si chiudono. Due interruttori in Vista
  rimettono il comportamento di prima.
- 24/11 «assicurati anche di non perdere comportamenti utili delle tabbar» → senza la barra in
  alto, la riga del titolo porta il foglio della tab con Disposizione e il «+»; righe di
  terminale e browser si trascinano nella griglia come le chat.
- 24/11 «rivediamo anche completamente da 0 tutto il sistema di split, conservando tutte le
  possibilità di split ma rivedendo completamente la UI UX che era rotta» → un vocabolario su
  ogni superficie e da ogni sorgente (bordo = dividi, centro = apri qui, bordo della superficie
  = riga intera), l'anteprima è l'impronta col nome, una cella divisa dice cosa contiene e chi
  ha il fuoco, tutto si fa anche da menu e da tastiera.
- 25/11 «se premo la chiusura di una tab non sembra succedere nulla e non riesco a distinguere
  i due stati» e «dovrei vedere con sfondo solo le tab effettivamente aperte» → anche dentro un
  progetto (albero o fascia di una fissata) la riga aperta ha lo sfondo e la chiusa no; la fascia
  di una fissata non dipinge un riquadro sotto le sue righe.
- 25/11 «l'accordion sotto agenti non dovrebbe essere una riga sotto la tab ma direttamente la
  tab stessa» → i sotto-agenti si aprono dal chevron della riga che li ha lanciati, senza una
  riga d'intestazione in più.
- 25/11 «stai attento a tab di un progetto, non sembrano avere spaziature corretta» → le righe
  dentro un progetto hanno lo stesso passo e lo stesso rientro, nell'albero e nella fascia.
- 25/11 «c'è ancora la tabbar progetto. va bene solo il titolo e tenere la tab all'hover sul
  titolo, così da sfruttarlo per il dnd dello split» → con le tab di lato la finestra di un
  progetto non ha barra sua: il titolo è la tab (fondo al passaggio, si trascina nello split) e
  i comandi del progetto stanno a destra del titolo. Il «+» lì no («ma il + serve ancora la?»):
  c'è già sulla riga del progetto nella colonna.
- 25/11 «le icone tipo di attivazione sidebar file git etc, dovrebbero restare anche se aperte» →
  i comandi del progetto restano sul titolo anche a colonna aperta, e la colonna non ripete nome e
  chiusura in testa. «le notifiche delle icone sono tagliate» → il badge pende dentro la riga intera.
  «se chiudo la sidebar vedo che spunta ancora la tabbar, ma è o una o l'altra» → con le tab di lato
  la barra in alto non torna mai. «se premo archivia non si vede il progresso», «si perdono tutte le
  funzionalità della tab browser» → il titolo è la tab vera (`PaneTabBar` in variante titolo), non
  una scritta che ne copia una parte, e chiudendo la tab davanti il titolo resta su di lei col conto
  alla rovescia finché non scade (prima saltava subito alla tab dopo e il progresso spariva). «gli accordion della sidebar progetto … singole isole come se
  fosse una loro card» → File, Git e Processi sono card a sé, la colonna non ha più fondo né filo.
- 25/11 «nella tabella il progetto dovrebbe andare prima del titolo e mostrare anche icona..
  così come il resto dovrebbe seguire il design system ovunque fatto bene.. e parecchie volte
  che nn segui i design system» → nella tabella della board il progetto (icona, poi nome dove
  c'è posto) viene prima del titolo, come nella riga di gruppo; ogni colore, raggio, hover e
  focus della tabella viene dai token, niente valori a mano.
- 25/11 «le tab non hanno lo stesso design system, all'hover lo sfondo non dovrebbe apparire per
  tutte?», «la tab messa nella topbar dovrebbe essere più grande, ora è piccolissima», «il tasto
  per aprire e chiudere dovrebbe essere prima dell'icona delle notifiche», «tutti i tasti delle
  notifiche e della sidebar [devono] avere il comportamento e dimensioni e colori delle tab» →
  ogni tab prende lo stesso fondo al passaggio, anche chiusa (a riposo resta senza); la tab del
  titolo ha la misura di una tab della colonna; l'interruttore della colonna sta prima della
  campanella; campanella, cerca, nuova e interruttore sono tasti a misura di tab: niente fondo a
  riposo, il fondo delle tab al passaggio, quello di una tab aperta mentre il loro pannello è
  aperto.
- 26/11 «vedo che il sistema di tab non segue bene la spaziatura: le icone tipo sidebar ricerca
  aggiunta della sidebar superiorre, ma anche la tab del progetto aperta, non hanno spaziature fra
  di loro e ai lati coerenti su tutti e 4 i lati» → con le tab di lato la riga in alto è una tab e
  un passo sopra e sotto (34 + 6 + 6 = 46), testata della colonna e riga del titolo uguali: 6 sopra,
  sotto, fra un tasto e l'altro e dall'ultimo al bordo; i comandi del progetto, quelli della cella,
  il «+» e la parola «Topics» sono alti quanto una tab; i semafori si centrano sulla riga che hanno
  sotto. Con le tab in alto la riga resta quella della striscia, 40.
- 26/11 «quando sto archiviando una tab non c'è nessuna animazione ancora» → archiviare una riga
  si vede come chiuderla: lo stesso conto alla rovescia (anche per terminali, browser, pagine e
  progetti chiusi, col cerchio che resta acceso), poi la riga esce scivolando verso il bordo e
  sfumando, e solo dopo quelle sotto risalgono (in due tempi, come una lista nativa: insieme, i
  due nomi si sovrapponevano per qualche fotogramma); ferma con il movimento ridotto.
- 26/11 «se si chiudono tutti i menu a tendina della sidebar progetto, si può chiudere anche la
  sidebar progetto» → chiusa l'ultima isola aperta (File, Git, Processi; Git conta solo quando ha
  qualcosa da mostrare) si chiude anche la colonna del progetto; riaprendola torna l'isola chiusa
  per ultima, con lo stesso scorrimento e ciò che c'era dentro.
