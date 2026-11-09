/**
 * client/src/lib/i18n-consumption-it.ts - the words of the per-session
 * consumption (load screen, Processes view, card drawer); in Italian, the
 * mirror of `i18n-consumption-en.ts`.
 */
import type { Dict } from './i18n-types';

const CONSUMPTION_IT: Dict = {
  'consumption.title': 'Sessioni',
  'consumption.live': '{n} al lavoro',
  'consumption.none': 'Nessuna sessione al lavoro',
  'consumption.reading': 'Lettura in corso',
  'consumption.unread': 'Sessioni non lette: il server non risponde',
  'consumption.tokens': 'Token',
  'consumption.tokensTitle': 'ingresso {input} · uscita {output} · cache letta {cacheRead} · cache scritta {cacheWrite}',
  'consumption.tokensTotalOnly': 'Solo il totale: questa fonte non lo scompone',
  'consumption.tokensNone': 'Token non letti per questa sessione',
  'consumption.tps': 'Token/s',
  'consumption.tpsTitle': 'Token di uscita al secondo, media sugli ultimi {s} s',
  'consumption.tpsNone': 'Velocità non misurabile: manca il conteggio dei token di uscita o la lettura è troppo recente',
  'consumption.time': 'Tempo',
  'consumption.cpu': 'CPU',
  'consumption.memory': 'Memoria',
  'consumption.memoryShared': 'di cui {mb} condivisi',
  'consumption.memoryRemote': 'Gira su {name}: qui non si misura',
  'consumption.shareLine': '{what}: 1/{of} di {total}',
  'consumption.root.server': 'server di Topics',
  'consumption.root.pty-bridge': 'ponte dei terminali',
  'consumption.root.ai-bridge': 'ponte AI',
  'consumption.root.webrtc-bridge': 'ponte WebRTC',
  'consumption.rule': 'Un processo che usano più sessioni è diviso in parti uguali fra chi lo usa',
  'consumption.procs': 'Processi',
  'consumption.procsCount': '{name} ×{n}',
  'consumption.remote': 'Su un\'altra macchina · {what}',
  'consumption.remoteOn': 'Su {name} · {what}',
  'consumption.cpuTitle': 'Percentuale dell\'intera macchina, non di un solo core',
  'consumption.cpuNote': 'della macchina',
  'consumption.cpuNoteOf': 'del {name}',
  'consumption.remoteShare': '1/{of}',
  'consumption.remoteSince': 'in corso da {time}',
  'consumption.on': 'su {name}',
  'consumption.from': 'da {who}',
  'consumption.idle': '{n} sessioni aperte e ferme · {mem}',
  'consumption.unattributed': 'Fuori da ogni sessione · {mem}',
  'consumption.more': 'e altre {n} al lavoro',
  'consumption.drawer': 'Consumo della sessione',
  'consumption.drawerNone': 'Nessuna lettura: la card non ha una sessione al lavoro',
  'consumption.details': 'Dettaglio',
};

export default CONSUMPTION_IT;
