import type { Topic } from '../../types';

/**
 * COSA C'E' A SISTEMA, detto prima di scrivere e non dopo.
 *
 * Un topic porta addosso scelte che decidono come rispondera': quale modello,
 * quanto effort, se puo' agire da solo, quali file si porta dentro, se vede gli
 * strumenti globali o solo quelli di Topics. Fino al 16/08 nel vuoto non se ne
 * vedeva NESSUNA — si leggeva il nome e si scriveva al buio, e la differenza
 * fra una chat che chiede prima di toccare i file e una che non chiede si
 * scopriva dopo averle scritto.
 *
 * Si mostra solo cio' che e' stato SCELTO: un campo assente vuol dire «il
 * default», e stampare «modello: auto, effort: auto, autonomia: ask» sarebbe
 * rumore che si impara a non leggere, invece di informazione. Per lo stesso
 * motivo `mcpPolicy` compare solo quando RESTRINGE: e' una limitazione, e le
 * limitazioni vanno dette; la larghezza normale no.
 */
export function contextBits(topic: Topic, t: (k: string, v?: Record<string, string | number>) => string): string[] {
  const bits: string[] = [];
  if (topic.projectPath) {
    const nome = topic.projectPath.split('/').filter(Boolean).pop();
    if (nome) bits.push(t('chat.empty.project', { name: nome }));
  }
  if (topic.model) bits.push(t('chat.empty.model', { model: topic.model }));
  if (topic.effort) bits.push(t('chat.empty.effort', { effort: topic.effort }));
  if (topic.provider) bits.push(t('chat.empty.provider', { provider: topic.provider }));
  if (topic.autonomyLevel === 'ask') bits.push(t('chat.empty.autonomyAsk'));
  else if (topic.autonomyLevel === 'auto-apply') bits.push(t('chat.empty.autonomyAutoApply'));
  else if (topic.autonomyLevel === 'yolo') bits.push(t('chat.empty.autonomyYolo'));
  const n = topic.contextFiles?.length ?? 0;
  if (n > 0) bits.push(t('chat.empty.contextFiles', { n }));
  if (topic.mcpPolicy === 'bridge-only') bits.push(t('chat.empty.mcpBridge'));
  return bits;
}

