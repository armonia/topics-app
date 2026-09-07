/**
 * client/src/lib/i18n-chat-it.ts - the CHAT SURFACE strings, in Italian.
 *
 * WHAT IS IN HERE: what the chat says around the messages. The composer and its
 * add menu, the voice call and dictation banners, the message action toolbar,
 * the provider/model picker, the mention menu, and the few tool cards whose
 * labels are chrome rather than agent output.
 *
 * WHY A FRAGMENT AND NOT A BLOCK IN `i18n-it.ts`: the same reason
 * `i18n-spend-it.ts` exists. Both catalogues sit a handful of lines under their
 * `check:bloat` ceiling, and this sweep adds around ninety keys at once. The
 * pair spreads into the two catalogues, so `t()` and the catalogue tests see
 * exactly what they saw before.
 *
 * WHY IT WAS WORTH A SWEEP: the default locale is `it` (`resolveLocale`), and
 * these strings were written straight into the JSX, so the language selector
 * did not govern the single surface people look at all day.
 */
import type { Dict } from './i18n-types';

const CHAT_IT: Dict = {
  // Empty state: the invitation and the starter chips. The chip carries two
  // strings, the label you read and the message it drops in the composer.
  'chat.empty.systemPrompt': 'Prompt di sistema personalizzato attivo',
  'chat.empty.start': 'Comincia una conversazione',
  'chat.empty.starter.describe': 'Descrivi questo progetto',
  'chat.empty.starter.describeMsg': 'Dammi una panoramica breve di questo progetto: cosa fa, lo stack tecnico e i file principali.',
  'chat.empty.starter.changes': 'Modifiche recenti',
  'chat.empty.starter.changesMsg': 'Mostrami le modifiche git recenti di questo progetto e riassumi cosa è cambiato.',
  'chat.empty.starter.issues': 'Trova i problemi',
  'chat.empty.starter.issuesMsg': 'Rivedi questo progetto: bug possibili, codice che puzza, cose da migliorare.',
  'chat.empty.starter.brainstorm': 'Butta giù delle idee',
  'chat.empty.starter.brainstormMsg': 'Aiutami a buttare giù qualche idea.',
  'chat.empty.starter.write': 'Scrivi qualcosa',
  'chat.empty.starter.writeMsg': 'Aiutami a scrivere ',
  'chat.empty.starter.research': 'Fai una ricerca',
  'chat.empty.starter.researchMsg': 'Fai una ricerca su ',
  'chat.empty.hint.commands': 'comandi',
  'chat.empty.hint.slash': 'comandi slash',
  'chat.empty.hint.mention': 'cita un file',
  'chat.empty.hint.shortcuts': 'tutte le scorciatoie',

  // Composer: the add menu, the text field, the export.
  'chat.composer.addMenu': 'Allega, strumenti e comandi',
  'chat.composer.addMenuAria': 'Strumenti e comandi',
  'chat.composer.attachFile': 'Allega un file',
  'chat.composer.export': 'Esporta la conversazione',
  'chat.composer.inputAria': 'Campo del messaggio per {name}',
  'chat.composer.placeholder': 'Messaggio…',
  'chat.composer.placeholderProject': 'Messaggio… (@ per citare un file)',
  'chat.composer.placeholderReply': 'Rispondi…',
  'chat.composer.hint': 'Invio per mandare il messaggio, Shift+Invio per andare a capo. Scrivi / per i comandi.',

  // Voice call: the menu entry and the banner with its three states.
  'chat.call.start': 'Chiamata vocale',
  'chat.call.end': 'Chiudi la chiamata',
  'chat.call.active': 'Chiamata vocale attiva',
  'chat.call.listening': 'In ascolto… parla pure',
  'chat.call.processing': 'Sto elaborando il messaggio…',
  'chat.call.speaking': 'Sto rispondendo a voce…',
  'chat.call.endButton': 'Chiudi',

  'chat.tts.stop': 'Smetti di parlare',
  'chat.tts.autoOn': 'Voce automatica (accesa)',
  'chat.tts.auto': 'Voce automatica',

  'chat.recording.label': 'Registrazione',
  'chat.recording.stop': 'Ferma',
  'chat.recording.startVoice': 'Registra la voce',
  'chat.recording.stopVoice': 'Ferma la registrazione',

  'chat.attachment.pastedImage': 'Immagine incollata',
  'chat.attachment.tooLarge': 'Allegato troppo grande per sopravvivere a un ricaricamento: mandalo adesso, o lo perdi se aggiorni la pagina.',

  'chat.edit.editing': 'Stai modificando il messaggio',
  'chat.edit.cancel': 'Annulla la modifica',
  'chat.reply.toYourself': 'Rispondi a te stesso',
  'chat.reply.toAssistant': "Rispondi all'assistente",

  // The one button on the right of the composer, in its four states.
  'chat.send.stopStreaming': 'Ferma la risposta',
  'chat.send.queueTitle': 'Metti in coda (Invio)',
  'chat.send.sendTitle': 'Invia (Invio)',
  'chat.send.queue': 'Metti il messaggio in coda',
  'chat.send.send': 'Invia il messaggio',
  'chat.fastMode.toggle': 'Accendi o spegni la modalità veloce',
  'chat.contextInspector.toggle': 'Apri o chiudi il pannello del contesto',

  // Message toolbar: title and accessible name differ on purpose, the first is
  // a hint on hover and the second has to say WHAT it acts on.
  'chat.message.edit': 'Modifica',
  'chat.message.editAria': 'Modifica il messaggio',
  'chat.message.reply': 'Rispondi',
  'chat.message.copy': 'Copia',
  'chat.message.copyAria': 'Copia il messaggio',
  'chat.message.pin': 'Appunta',
  'chat.message.pinAria': 'Appunta il messaggio',
  'chat.message.remember': 'Ricorda questo',
  'chat.message.rememberAria': 'Salva nella memoria',
  'chat.message.regenerate': 'Rigenera',
  'chat.message.regenerateAria': 'Rigenera la risposta',
  'chat.message.delete': 'Elimina',
  'chat.message.deleteArmed': 'Tocca di nuovo per eliminare',
  'chat.message.deleteAria': 'Elimina il messaggio',
  'chat.message.deleteConfirmAria': "Conferma l'eliminazione",
  'chat.message.deleteQuestion': 'Elimino?',
  'chat.branch.previous': 'Ramo precedente',
  'chat.branch.next': 'Ramo successivo',

  // Provider and model picker.
  'chat.picker.title': 'Provider e modello',
  'chat.picker.search': 'Cerca un provider o un modello',
  'chat.picker.clearSearch': 'Svuota la ricerca',
  'chat.picker.refresh': 'Aggiorna lo stato dei provider',
  'chat.picker.loadFailed': 'Non sono riuscito a caricare i provider.',
  'chat.picker.retry': 'Riprova',
  'chat.picker.noneReady': 'Nessun provider pronto.',
  'chat.picker.openSettings': 'Apri le impostazioni',
  'chat.picker.noMatches': 'Nessuna corrispondenza.',
  'chat.picker.resetDefault': 'Torna al default',
  'chat.picker.defaultIs': 'Default: {name}',
  'chat.picker.noneConfigured': 'Nessun provider configurato',

  'chat.mention.header': 'File',
  'chat.mention.loading': 'Carico i file…',
  'chat.mention.empty': 'Nessun file trovato',

  'chat.command.readingFile': 'Leggo il file…',
  'chat.command.openingBrowser': 'Apro il browser → {url}',
  'chat.compaction.title': 'Contesto compattato',
  'chat.config.reasoningEffort': 'Sforzo di ragionamento',

  // Tool cards: only the labels the app writes itself. What the agent produced
  // stays in the language the agent wrote it in.
  'chat.tool.subAgentStarting': 'Sotto-agente in partenza…',
  'chat.tool.noActivity': 'Nessuna attività registrata.',
  'chat.tool.activityOne': 'Attività · 1 passo',
  'chat.tool.activityMany': 'Attività · {n} passi',
  'chat.tool.finalResult': 'Risultato finale',
  'chat.tool.skillInstructions': 'Istruzioni caricate',
  'chat.tool.noSessionContext': "L'agente sta chiedendo una risposta, ma questa vista non ha il contesto della sessione. Ricarica per rispondere.",
};

export default CHAT_IT;
