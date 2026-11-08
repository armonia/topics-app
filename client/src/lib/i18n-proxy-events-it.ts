/**
 * client/src/lib/i18n-proxy-events-it.ts - the Claude proxy's activity log, in
 * Italian: the sentences of the hub's Activity page (usage-hub
 * public/switchboard-tabs.js) that the bell's History now shows, and the
 * notes the account rows of «Now» add under their title. A fragment because
 * only the bell panel reads these: they come with its chunk (`addCatalogue`
 * in BellRows.tsx), not with the entry.
 */
import type { Dict } from './i18n-types';

const PROXY_EVENTS_IT: Dict = {
  'proxy.event.autoSwitch': 'Cambio automatico da {from} a {to}',
  'proxy.event.reason': 'errore {code}',
  'proxy.event.proactiveSwitch': 'Cambio in anticipo da {from} a {to}',
  'proxy.event.proactiveSwitchTo': 'Cambio in anticipo a {to}',
  'proxy.event.manualSwitch': 'Cambio manuale a {to}',
  'proxy.event.rateLimited': '{account} al limite di richieste',
  'proxy.event.minutes': 'per {n} min',
  'proxy.event.balanceCooldown': '{account} in pausa per non sforare',
  'proxy.event.balanceOverflow': '{account} oltre la sua parte di richieste in parallelo',
  'proxy.event.maxParallel': 'massimo {n}',
  'proxy.event.modelLimited': '{account} al limite per {model}',
  'proxy.event.modelRecovered': '{account} di nuovo disponibile per {model}',
  'proxy.event.capHold': 'Tutti gli account sono al tetto: le richieste aspettano invece di fallire',
  'proxy.event.capExhausted': 'Tetto raggiunto su tutti gli account',
  'proxy.event.allExhausted': 'Tutti gli account esauriti',
  'proxy.event.authExpired': '{account}: accesso scaduto',
  'proxy.event.permissionBlocked': '{account}: richiesta rifiutata per permessi',
  'proxy.event.badRequest': '{account}: richiesta rifiutata come non valida',
  'proxy.event.inARow': '{n} di fila',
  'proxy.event.mcpSchema': '{account} rifiuta lo schema di uno strumento MCP',
  'proxy.event.upstreamRetry': 'Nuovo tentativo su {account}',
  'proxy.event.afterError': "dopo l'errore {code}",
  'proxy.event.inbandRetry': 'Nuovo tentativo su {account} dopo un errore a metà risposta',
  'proxy.event.overloaded': 'Server di Claude sovraccarico su {account}',
  'proxy.event.apiError': 'Errore del server di Claude su {account}',
  'proxy.event.attempt': 'tentativo {n}',
  'proxy.event.discovered': 'Trovato {account}',
  'proxy.event.renamed': '{account} rinominato in {label}',
  'proxy.event.enabled': '{account} riacceso',
  'proxy.event.disabled': '{account} spento: escluso dalla rotazione',
  'proxy.event.removed': '{account} rimosso',
  'proxy.event.priority': '{account}: priorità impostata a {n}',
  'proxy.event.accountCap': '{account}: tetto cambiato',
  'proxy.event.capNone': 'senza tetto',
  'proxy.event.capBoth': '{five}% sulle 5 ore, {week}% sulla settimana',
  'proxy.event.capFive': '{n}% sulle 5 ore',
  'proxy.event.capWeek': '{n}% sulla settimana',
  'proxy.event.settings': 'Impostazioni del proxy cambiate',
  'proxy.event.refreshFailed': '{account}: rinnovo fallito',
  'proxy.event.tokenRefreshed': '{account}: token rinnovato',
  'proxy.event.upgrade': 'Proxy aggiornato a {version}',
  'proxy.event.unknown': 'Evento del proxy ({type})',
  'proxy.tone.ok': 'a posto',
  'proxy.tone.info': 'notizia',
  'proxy.tone.warn': 'avviso',
  'proxy.tone.bad': 'problema',
  'proxy.tone.muted': 'modifica',
  'proxy.who': 'Proxy Claude',
  'proxy.note.auto': 'automatico',
  'proxy.note.proactive': 'in anticipo',
  'proxy.note.manual': 'manuale',
  'bell.account.cap': 'Tetto raggiunto: tutti gli account',
  'bell.account.history': 'Tutti gli eventi degli account',
  'bell.history.accounts': 'Account Claude',
};

export default PROXY_EVENTS_IT;
