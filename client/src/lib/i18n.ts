/**
 * Le stringhe dell'interfaccia, in più lingue.
 *
 * ── Perché un dizionario e non una traduzione a tappeto ──────────────────────
 * Oggi l'interfaccia è mescolata: ~98 stringhe in italiano e ~91 in inglese
 * (misurate il 04/08). Tradurle tutte in un colpo solo significherebbe cambiare
 * ~190 testi visibili in una volta — e la suite e2e ANCORA quei testi («Chiudi
 * ora», «Dividi a destra», «Rimuovi dai Fissati»). Il risultato sarebbe decine
 * di rossi tutti insieme, in cui un errore vero è indistinguibile da una stringa
 * spostata. Quindi: prima il meccanismo, poi una superficie alla volta, con i
 * suoi test aggiornati insieme. Chi arriva dopo aggiunge chiavi, non riscrive.
 *
 * ── Perché non una libreria ──────────────────────────────────────────────────
 * Serve questo: una chiave, due lingue, l'interpolazione di qualche valore. Una
 * libreria porterebbe plurali per lingue slave, caricamento asincrono dei
 * bundle, contesti e namespace — e un peso e una configurazione che non
 * ripagano finché le lingue sono due.
 *
 * ── Il ripiego è deliberato ──────────────────────────────────────────────────
 * Una chiave mancante nella lingua scelta cade sull'ALTRA lingua, non sulla
 * chiave nuda: un testo nella lingua sbagliata è brutto, `board.night.title` in
 * mezzo alla pagina è rotto. In sviluppo la mancanza si vede comunque, perché
 * `missingKeys()` la elenca e un test la può leggere.
 */

export type Locale = 'it' | 'en';

/** La preferenza dell'utente: `auto` segue il browser. */
export type LocalePreference = Locale | 'auto';

type Dict = Record<string, string>;

/**
 * Le stringhe. Le chiavi sono `superficie.cosa`, e la superficie è quella
 * dell'interfaccia (non del file): chi cerca «dov'è questo testo» parte da ciò
 * che vede.
 */
const IT: Dict = {
  'board.night.title': 'Modalità notturna',
  'board.night.blurb':
    "Mentre sei via, la coda parte solo a macchina libera — e si spegne da sola all'orario di fine, invece di restare armata addosso a chi lavora.",
  'board.night.until': 'Si ferma alle',
  'board.night.state.off': 'Spenta',
  'board.night.state.off.detail': 'La board dispaccia come sempre, senza guardare il carico.',
  'board.night.state.go': 'Sta dispacciando',
  'board.night.state.go.detail': 'Macchina libera: i task in coda partono.',
  'board.night.state.wait': 'In attesa',
  'board.night.state.expired': 'Scaduta',
  'board.night.state.expired.detail': "Orario di fine raggiunto: si spegne al prossimo giro.",
  'board.night.state.checking': 'Controllo…',
  'board.night.state.unknown': 'Stato non disponibile',
  'board.night.state.unknown.detail': 'Il server non ha risposto: riprovo fra poco.',
  'board.night.load': 'Carico',
  'board.night.cores': '{n} core',
  'board.night.nobodyAttached': 'Nessuno attaccato a una sessione',
  'board.night.sessions.one': '1 sessione attiva',
  'board.night.sessions.many': '{n} sessioni attive',
  'board.night.endsIn': 'Si spegne fra {t}',
  'time.lessThanAMinute': 'meno di un minuto',
  'time.minutes': '{n} min',
  'time.hours': '{n}h',
  'time.hoursMinutes': '{h}h {m}min',
  'tab.menu.rename': 'Rinomina',
  'tab.menu.copyUrl': 'Copia URL della pagina',
  'tab.menu.closeNow': 'Chiudi ora',
  'tab.menu.closeCountdown': 'Chiudi (con conto alla rovescia)',
  'tab.menu.closeOthers': 'Chiudi le altre',
  'tab.menu.splitRight': 'Dividi a destra',
  'tab.menu.splitDown': 'Dividi in basso',
  'tab.menu.pin': 'Fissa',
  'tab.menu.unpin': 'Rimuovi dai Fissati',
  'board.task.movedToReviewBySystem': 'Portato in review dal sistema.',
  'board.task.reject': 'Rifiuta',
  'board.task.openChat': 'Apri la chat',
  'board.task.loadingDiff': 'carico il diff…',
  'board.task.diffUnreadable': 'Diff non leggibile.',
  'board.task.noChanges': 'Nessuna modifica da mostrare.',
  'board.task.noComments': 'Nessun commento.',
  'board.task.moveTo': 'Sposta in…',
  'board.task.options': 'Opzioni task',
  'board.task.planFirst': 'Piano prima',
  'board.task.reuseBlockerContext': 'Riusa il contesto del bloccante',
  'board.task.addSubtask': 'Aggiungi sottotask',
  'board.task.notOnMain': 'non su main',
  'board.task.openProject': 'Apri progetto',
  'board.task.priority': 'Priorità',
  'board.task.agentModel': 'Modello agent',
  'board.task.blockedBy': 'Bloccato da…',
  'common.none': 'Nessuno',
  'board.task.noOtherTasks': 'Nessun altro task su questa board.',
  'board.task.deliveredFiles': 'File consegnati',
  'board.task.landOnMain': 'Landa su main',
  'board.task.proposedPlan': 'Piano proposto',
  'board.task.noPreviewForType': 'Nessuna anteprima per questo tipo di file.',
  'board.task.openInBrowser': 'Apri nel browser',
  'board.settings.autoDispatch': 'Auto-dispatch',
  'board.publish.toPublish': 'Da pubblicare — controlla i commit prima',
  'board.publish.nothing': 'Niente da pubblicare — tutto già su remoto.',
  'board.publish.diffTitle': 'Diff che verrà pubblicato',
  'board.publish.loadingDiff': 'Carico il diff…',
  'board.publish.diffError': 'Errore nel caricare il diff.',
  'board.dispatch.allBoards': 'Dispatch — tutte le board',
  'board.dispatch.parallelAuto': 'Agent in parallelo — auto',
  'board.dispatch.oneMachine': 'Vale su TUTTE le board (una sola macchina, un solo limite).',
  'board.filter.assignee': 'Assegnatario',
  'common.project': 'Progetto',
  'chat.turnStopped': 'Turno interrotto',
  'chat.turnStopped.detail': "L'hai fermato tu — il messaggio è ancora qui",
  'chat.noAnswer': 'Nessuna risposta',
  'chat.noAnswer.detail': 'La connessione può essersi interrotta',
  'git.noRepoInitialized': 'Nessun repository git inizializzato',
  'git.noRepo': 'Nessun repository git',
  'git.cleanTree': 'Albero di lavoro pulito',
  'git.folderUntracked': 'Questa cartella non è tracciata da git',
  'git.folderUntrackedIn': 'Non tracciata dal repo «{repo}»: il ramo qui accanto è suo, non di questa cartella.',
  'git.initHere': 'Crea un repository qui',
  'git.refreshAndFetch': 'Aggiorna (e sincronizza col remote)',
  'git.nothingToCommit': 'Niente da committare',
  'git.originalHead': 'Originale (HEAD)',
  'git.modifiedWorking': 'Modificato (in lavorazione)',
  'git.selectFile': 'Scegli un file modificato per vederne il diff',
  'git.discardWarning': 'Le modifiche non committate verranno buttate per sempre.',
  'git.discardUntrackedOnly': 'Non sono tracciati da git: li sposto nel cestino di sistema, da lì puoi rimetterli a posto.',
  'git.discardUntrackedSome': 'Di questi, {n} non sono tracciati da git: quelli vanno nel cestino di sistema.',
  'chat.panel.close': 'Chiudi il pannello',
  'chat.panel.contextInspector': 'Ispettore del contesto',
  'chat.panel.topicSettings': 'Impostazioni della chat',
  'chat.panel.moveToWindow': 'Sposta in una nuova finestra',
  'chat.panel.goToBrowser': 'Vai al browser',
  'chat.panel.goToBrowserTitle': 'Vai al browser aperto da questa chat',
  'chat.linkProject.question': 'Colleghi a un progetto?',
  'chat.linkProject.link': 'Collega',
  'chat.linkProject.skip': 'Salta',
  'project.sidebar.collapseAll': 'Chiudi tutto',
  'project.sidebar.expand': 'Espandi la barra',
  'project.sidebar.hide': 'Nascondi la barra',
  'project.sidebar.files': 'File',
  'project.sidebar.gitChanges': 'Modifiche git',
  'project.sidebar.processes': 'Processi',
  'project.sidebar.newFile': 'Nuovo file',
  'project.sidebar.newFolder': 'Nuova cartella',
  'project.sidebar.refresh': 'Aggiorna',
  'project.sidebar.resize': 'Trascina per ridimensionare · doppio click per la misura di partenza',
  'project.sidebar.changedFiles.one': '1 file modificato',
  'project.sidebar.changedFiles.many': '{n} file modificati',
  'project.sidebar.clean': 'Nessuna modifica',
  'project.sidebar.processesRunning.one': '1 processo in esecuzione',
  'project.sidebar.processesRunning.many': '{n} processi in esecuzione',
  'project.sidebar.processesFailed.one': '1 processo uscito con errore',
  'project.sidebar.processesFailed.many': '{n} processi usciti con errore',
  'processes.openFailedLog': 'Apri il log di questa uscita fallita',
  'sidebar.tree': 'Barra laterale',
  'sidebar.pinned': 'Fissato',
  'sidebar.moreOptions': 'Altre opzioni',
  // Il «+» della riga di progetto su touch. NON è «altre opzioni»: quel bottone
  // apre il menu di AGGIUNTA (nuova chat, terminale, browser…), non il menu
  // contestuale — che col dito si apre tenendo premuto. Portava l'etichetta
  // sbagliata insieme al glifo sbagliato.
  'sidebar.newInProject': 'Aggiungi nel progetto',
  'sidebar.restoreProject': 'Ripristina il progetto',
  'sidebar.markAllRead': 'Segna tutto come letto',
  'sidebar.openAsProject': 'Apri come progetto',
  // Trascinare una tessera sulla lista di solito la rimette in lista. Ma se il
  // pin era l'unica cosa che la teneva su, di riga non ne nasce nessuna: e
  // allora l'anteprima deve dire QUESTO, prima che si lasci il dito.
  'sidebar.unpinVanishes': '{nome} esce dai Fissati — in lista non resta',
  'sidebar.unpinnedGone': '{nome} non è più fissato, e non ha una riga in lista',
  'sidebar.undo': 'Annulla',
  // ── Persone e gruppi (Impostazioni → Identità).
  //
  // La parola «organizzazione» compare in UNA chiave sola, e solo nella riga
  // che si mostra quando i membri sono più di uno: ORG-07 dice di non nominare
  // il concetto a chi ha un gruppo di una persona. «Gruppo» invece si dice
  // sempre — nasconderlo del tutto voleva dire che non si vedeva, non si
  // rinominava, e chi lo cercava concludeva che non esistesse.
  'identity.title': 'Persone',
  'identity.blurb.solo': 'Per adesso ci sei solo tu. Aggiungi qualcuno per poter condividere con lui, anche prima che colleghi un suo dispositivo.',
  'identity.blurb.group': 'Condividere con l’organizzazione vale per tutti i suoi membri, senza rifarlo uno per uno.',
  'identity.groupNameLabel': 'Nome del gruppo',
  'identity.renameGroup': 'Cambia nome',
  'identity.installationGroup': 'Il gruppo di questa installazione: non si cancella',
  'identity.deleteGroup': 'Cancella {nome}',
  'identity.deleteGroupConfirm': 'Cancellare «{nome}»? Ciò che è stato condiviso con questo gruppo smette di essere visibile ai suoi membri.',
  'identity.newGroup': 'Nuovo gruppo',
  'identity.newGroupNameLabel': 'Nome del nuovo gruppo',
  'identity.create': 'Crea',
  'identity.notAdmin': 'Sei un membro di questo gruppo: possono cambiarlo solo i suoi amministratori.',
  'identity.roleOf': 'Ruolo di {nome}',
  'identity.role.owner': 'Proprietario',
  'identity.role.admin': 'Amministratore',
  'identity.role.member': 'Membro',
  'identity.save': 'Salva',
  'identity.cancel': 'Annulla',
  'identity.add': 'Aggiungi',
  'identity.addPerson': 'Aggiungi una persona',
  // Il rifiuto DICE cosa si può ancora fare, e non solo cosa no: condividere
  // con quella persona resta possibile sul piano gratuito — quello che serve
  // pagare è metterla nel GRUPPO, cioè condividere con tutti in un colpo.
  'identity.noSeats': 'Il piano gratuito ha un posto solo, e sei tu. Per mettere qualcuno nel gruppo serve un piano a pagamento — ma puoi già condividere con lui autorizzando un suo dispositivo.',
  'identity.addFailed': 'Non è riuscito. Riprova.',
  'identity.nameLabel': 'Nome',
  'identity.emailLabel': 'Email',
  'identity.emailPlaceholder': 'Email (facoltativa)',
  'identity.personName': 'Nome della persona',
  'identity.personEmail': 'Email della persona',
  'identity.editPerson': 'Cambia nome o email',
  'identity.you': 'tu',
  'identity.notConnectedYet': 'da collegare',
  'identity.devices.one': '1 dispositivo',
  'identity.devices.many': '{n} dispositivi',
  'identity.removePerson': 'Togli {nome}',
  'identity.footnote': 'Aggiungere una persona non le dà accesso a questa macchina: le dà un nome con cui condividere. Per entrare deve comunque collegare un suo dispositivo e tu approvarlo, e resterà un ospite — vedrà solo ciò che le hai condiviso. L’email è un’etichetta, non un accesso.',
  // Qui c'erano quattro `settings.language*`: nessuna superficie le ha mai
  // chiamate — il selettore della lingua in Impostazioni scrive le sue etichette
  // in chiaro, bilingui, perché è l'unico posto che si deve poter leggere anche
  // quando la lingua scelta è quella sbagliata. Chiavi che nessuno risolve non
  // sono un dizionario pronto: sono due traduzioni da tenere allineate a mano.
};

const EN: Dict = {
  'board.night.title': 'Night mode',
  'board.night.blurb':
    'While you are away, the queue only starts on an idle machine — and it switches itself off at the end time instead of staying armed over whoever is working.',
  'board.night.until': 'Stops at',
  'board.night.state.off': 'Off',
  'board.night.state.off.detail': 'The board dispatches as usual, ignoring machine load.',
  'board.night.state.go': 'Dispatching',
  'board.night.state.go.detail': 'Machine is idle: queued tasks start.',
  'board.night.state.wait': 'Waiting',
  'board.night.state.expired': 'Expired',
  'board.night.state.expired.detail': 'End time reached: it switches off on the next pass.',
  'board.night.state.checking': 'Checking…',
  'board.night.state.unknown': 'Status unavailable',
  'board.night.state.unknown.detail': 'The server did not answer: retrying shortly.',
  'board.night.load': 'Load',
  'board.night.cores': '{n} cores',
  'board.night.nobodyAttached': 'Nobody attached to a session',
  'board.night.sessions.one': '1 active session',
  'board.night.sessions.many': '{n} active sessions',
  'board.night.endsIn': 'Switches off in {t}',
  'time.lessThanAMinute': 'less than a minute',
  'time.minutes': '{n} min',
  'time.hours': '{n}h',
  'time.hoursMinutes': '{h}h {m}min',
  'tab.menu.rename': 'Rename',
  'tab.menu.copyUrl': 'Copy page URL',
  'tab.menu.closeNow': 'Close now',
  'tab.menu.closeCountdown': 'Close (with countdown)',
  'tab.menu.closeOthers': 'Close the others',
  'tab.menu.splitRight': 'Split right',
  'tab.menu.splitDown': 'Split down',
  'tab.menu.pin': 'Pin',
  'tab.menu.unpin': 'Unpin',
  'board.task.movedToReviewBySystem': 'Moved to review by the system.',
  'board.task.reject': 'Reject',
  'board.task.openChat': 'Open the chat',
  'board.task.loadingDiff': 'loading the diff…',
  'board.task.diffUnreadable': 'Diff not readable.',
  'board.task.noChanges': 'No changes to show.',
  'board.task.noComments': 'No comments.',
  'board.task.moveTo': 'Move to…',
  'board.task.options': 'Task options',
  'board.task.planFirst': 'Plan first',
  'board.task.reuseBlockerContext': "Reuse the blocker's context",
  'board.task.addSubtask': 'Add subtask',
  'board.task.notOnMain': 'not on main',
  'board.task.openProject': 'Open project',
  'board.task.priority': 'Priority',
  'board.task.agentModel': 'Agent model',
  'board.task.blockedBy': 'Blocked by…',
  'common.none': 'None',
  'board.task.noOtherTasks': 'No other task on this board.',
  'board.task.deliveredFiles': 'Delivered files',
  'board.task.landOnMain': 'Land on main',
  'board.task.proposedPlan': 'Proposed plan',
  'board.task.noPreviewForType': 'No preview for this file type.',
  'board.task.openInBrowser': 'Open in the browser',
  'board.settings.autoDispatch': 'Auto-dispatch',
  'board.publish.toPublish': 'To publish — check the commits first',
  'board.publish.nothing': 'Nothing to publish — everything is already on the remote.',
  'board.publish.diffTitle': 'Diff that will be published',
  'board.publish.loadingDiff': 'Loading the diff…',
  'board.publish.diffError': 'Could not load the diff.',
  'board.dispatch.allBoards': 'Dispatch — every board',
  'board.dispatch.parallelAuto': 'Agents in parallel — auto',
  'board.dispatch.oneMachine': 'Applies to EVERY board (one machine, one limit).',
  'board.filter.assignee': 'Assignee',
  'common.project': 'Project',
  'chat.turnStopped': 'Turn stopped',
  'chat.turnStopped.detail': 'You stopped it — the message is still here',
  'chat.noAnswer': 'No answer',
  'chat.noAnswer.detail': 'The connection may have dropped',
  'git.noRepoInitialized': 'No git repository initialized',
  'git.noRepo': 'No git repository',
  'git.cleanTree': 'Clean working tree',
  'git.folderUntracked': 'This folder is not tracked by git',
  'git.folderUntrackedIn': 'Not tracked by the «{repo}» repo: the branch shown belongs to it, not to this folder.',
  'git.initHere': 'Create a repository here',
  'git.refreshAndFetch': 'Refresh (and fetch from remote)',
  'git.nothingToCommit': 'No changes to commit',
  'git.originalHead': 'Original (HEAD)',
  'git.modifiedWorking': 'Modified (Working)',
  'git.selectFile': 'Select a changed file to view its diff',
  'git.discardWarning': 'This will permanently discard uncommitted changes.',
  'git.discardUntrackedOnly': 'These are not tracked by git, so they go to the system trash. You can put them back from there.',
  'git.discardUntrackedSome': '{n} of these are not tracked by git: those go to the system trash.',
  'chat.panel.close': 'Close panel',
  'chat.panel.contextInspector': 'Context Inspector',
  'chat.panel.topicSettings': 'Topic settings',
  'chat.panel.moveToWindow': 'Move to a new window',
  'chat.panel.goToBrowser': 'Go to the browser',
  'chat.panel.goToBrowserTitle': 'Go to the browser this chat opened',
  'chat.linkProject.question': 'Link to a project?',
  'chat.linkProject.link': 'Link',
  'chat.linkProject.skip': 'Skip',
  'project.sidebar.collapseAll': 'Collapse all',
  'project.sidebar.expand': 'Expand sidebar',
  'project.sidebar.hide': 'Hide sidebar',
  'project.sidebar.files': 'Files',
  'project.sidebar.gitChanges': 'Git changes',
  'project.sidebar.processes': 'Processes',
  'project.sidebar.newFile': 'New file',
  'project.sidebar.newFolder': 'New folder',
  'project.sidebar.refresh': 'Refresh',
  'project.sidebar.resize': 'Drag to resize · double-click to reset',
  'project.sidebar.changedFiles.one': '1 changed file',
  'project.sidebar.changedFiles.many': '{n} changed files',
  'project.sidebar.clean': 'No changes',
  'project.sidebar.processesRunning.one': '1 process running',
  'project.sidebar.processesRunning.many': '{n} processes running',
  'project.sidebar.processesFailed.one': '1 process exited with an error',
  'project.sidebar.processesFailed.many': '{n} processes exited with an error',
  'processes.openFailedLog': 'Open the log for this failed run',
  'sidebar.tree': 'Sidebar',
  'sidebar.pinned': 'Pinned',
  'sidebar.moreOptions': 'More options',
  'sidebar.newInProject': 'Add in project',
  'sidebar.restoreProject': 'Restore project',
  'sidebar.markAllRead': 'Mark all as read',
  'sidebar.openAsProject': 'Open as project',
  'sidebar.unpinVanishes': '{nome} leaves Pinned — no row in the list',
  'sidebar.unpinnedGone': '{nome} is no longer pinned, and has no row in the list',
  'sidebar.undo': 'Undo',
  'identity.title': 'People',
  'identity.blurb.solo': 'For now it’s just you. Add someone to be able to share with them, even before they connect a device of their own.',
  'identity.blurb.group': 'Sharing with the organization reaches every member, without doing it one by one.',
  'identity.groupNameLabel': 'Group name',
  'identity.renameGroup': 'Rename',
  'identity.installationGroup': 'This installation’s group: it cannot be deleted',
  'identity.deleteGroup': 'Delete {nome}',
  'identity.deleteGroupConfirm': 'Delete “{nome}”? Whatever was shared with this group stops being visible to its members.',
  'identity.newGroup': 'New group',
  'identity.newGroupNameLabel': 'Name of the new group',
  'identity.create': 'Create',
  'identity.notAdmin': 'You are a member of this group: only its admins can change it.',
  'identity.roleOf': 'Role of {nome}',
  'identity.role.owner': 'Owner',
  'identity.role.admin': 'Admin',
  'identity.role.member': 'Member',
  'identity.save': 'Save',
  'identity.cancel': 'Cancel',
  'identity.add': 'Add',
  'identity.addPerson': 'Add a person',
  'identity.noSeats': 'The free plan has one seat, and it is yours. Putting someone in the group needs a paid plan — but you can already share with them by authorising one of their devices.',
  'identity.addFailed': 'That did not work. Try again.',
  'identity.nameLabel': 'Name',
  'identity.emailLabel': 'Email',
  'identity.emailPlaceholder': 'Email (optional)',
  'identity.personName': 'Person’s name',
  'identity.personEmail': 'Person’s email',
  'identity.editPerson': 'Change name or email',
  'identity.you': 'you',
  'identity.notConnectedYet': 'not connected yet',
  'identity.devices.one': '1 device',
  'identity.devices.many': '{n} devices',
  'identity.removePerson': 'Remove {nome}',
  'identity.footnote': 'Adding a person does not give them access to this machine: it gives them a name to share with. To get in they still have to connect a device of their own and you have to approve it, and they stay a guest — they see only what you shared with them. The email is a label, not a login.',
};

const DICTS: Record<Locale, Dict> = { it: IT, en: EN };

/** La lingua di ripiego: quella in cui le chiavi esistono per prime. */
export const FALLBACK_LOCALE: Locale = 'it';

/**
 * Risolve la preferenza in una lingua vera. `auto` guarda il browser e ricade
 * sull'italiano — che è la lingua di questa casa, non un default universale.
 */
export function resolveLocale(pref: LocalePreference | undefined, navigatorLanguage?: string): Locale {
  if (pref === 'it' || pref === 'en') return pref;
  const lang = (navigatorLanguage ?? '').toLowerCase();
  if (lang.startsWith('en')) return 'en';
  return FALLBACK_LOCALE;
}

/** Sostituisce `{nome}` con i valori passati. Un segnaposto senza valore resta com'è. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * La stringa per una chiave. Ripiega sull'altra lingua prima che sulla chiave:
 * un testo nella lingua sbagliata è brutto, una chiave a schermo è rotta.
 */
export function t(key: string, locale: Locale, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale]?.[key] ?? DICTS[FALLBACK_LOCALE]?.[key] ?? key;
  return interpolate(raw, vars);
}

/**
 * Le chiavi che una lingua non ha. Serve a un test: una lingua incompleta è un
 * fatto che si scopre in fretta, non guardando l'interfaccia a caso.
 */
export function missingKeys(locale: Locale): string[] {
  const all = new Set([...Object.keys(IT), ...Object.keys(EN)]);
  return [...all].filter((k) => !(k in (DICTS[locale] ?? {}))).sort();
}

// ───────────────────────────────────────────────────────────────────────────
// La stessa scelta, dall'altra parte del filo
// ───────────────────────────────────────────────────────────────────────────

/**
 * «Lingua» è UNA preferenza sola: governa le stringhe qui sopra E la lingua in
 * cui il modello risponde. Ma i due lati hanno bisogni incompatibili — `t()` è
 * SINCRONA e deve dipingere il primo frame senza aspettare la rete, quindi la
 * copia dell'interfaccia vive in localStorage; il server invece deve poterla
 * leggere quando costruisce un prompt, e localStorage non ce l'ha.
 *
 * Da qui le due scritture: `AppSettings.language` (localStorage + `ui_state`,
 * per la UI) e la riga `app_settings.output_language` (migration 087, per il
 * modello). La verità è la seconda: è quella che chat, terminale, kanban e
 * contesto assemblato leggono.
 *
 * Non passa da `appSettingsApi` per una ragione sola e temporanea: quel modulo
 * non è nella proprietà di questa modifica, quindi il tipo `AppBehaviorSettings`
 * non conosce ancora `outputLanguage`. La chiamata è identica a quella che
 * farebbe `request()` (stessa base `/api`, stesso verbo, stesso corpo) — quando
 * il campo entrerà nel tipo, queste due funzioni diventano due righe che
 * chiamano `appSettingsApi`.
 */
/**
 * Cosa dice il server sulla lingua. TRE stati e non due, perché due non
 * bastano: «la riga è vuota» e «non sono riuscito a leggerla» portano a
 * decisioni opposte. Chi riallinea i due depositi scrive la preferenza locale
 * SOLO sul primo — trattare un errore di rete come «vuoto» significherebbe
 * sovrascrivere con il localStorage di questa finestra una scelta appena fatta
 * da un'altra, proprio nel momento in cui non se ne sa niente.
 */
export type ServerLanguage =
  | { known: true; value: LocalePreference | null }
  | { known: false };

export async function fetchOutputLanguage(): Promise<ServerLanguage> {
  try {
    const res = await fetch('/api/app-settings');
    if (!res.ok) return { known: false };
    const body = (await res.json()) as { settings?: { outputLanguage?: string | null } };
    const raw = body.settings?.outputLanguage;
    if (raw === 'it' || raw === 'en' || raw === 'auto') return { known: true, value: raw };
    if (raw == null) return { known: true, value: null };
    // Valore fuori scala (riga scritta a mano, DB di un'altra versione): il
    // server c'è e ha risposto, ma quello che dice non si sa leggere.
    return { known: false };
  } catch {
    return { known: false };
  }
}

/** Scrive la scelta nella riga `app_settings`. Best-effort: un fallimento non
 *  deve poter bloccare il selettore, che ha già aggiornato la UI. */
export async function pushOutputLanguage(pref: LocalePreference): Promise<void> {
  try {
    await fetch('/api/app-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputLanguage: pref }),
    });
  } catch {
    /* la UI resta com'è: la prossima scelta riprova */
  }
}
