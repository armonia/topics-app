/**
 * The `[1m]` suffix is not part of the model NAME: it is a MODE.
 *
 * The CLI exposes long-context variants as their own id — `claude-opus-5[1m]`
 * next to `claude-opus-5` — and the picker used to print them as-is inside a
 * `truncate` span. On a narrow pane the piece that got clipped was exactly the
 * tail, i.e. the only difference between a 200k and a 1M window: two identical
 * buttons, two different models.
 *
 * This module only PEELS the mode off the id; it does not decide how the rest
 * is displayed. `friendlyModelLabel` (below, and re-exported from
 * components/Board/format.ts for the callers that always used it there) owns that,
 * and it is safe to call on any provider's id: it now special-cases `codex`
 * and `gpt-` ids too, so `claude-opus-5` -> "Opus 5" and `gpt-5.4-mini` ->
 * "GPT-5.4-mini" render the same way here as on the board.
 */

import { bareModelId } from '../../../shared/modelMaker';
import { providerLabel } from '../../../shared/provider-labels';
import { taskModelSelection } from '../../../shared/task-coding-models';

export interface ModelIdParts {
  /** L'id senza il suffisso di modalità — resta la stringa esatta della CLI. */
  name: string;
  /** `true` se l'id portava `[1m]`: finestra di contesto lunga. */
  longContext: boolean;
}

/**
 * Separa la modalità dal nome. Non normalizza, non abbellisce, non cambia
 * maiuscole: `name` resta confrontabile con l'id che il server ha salvato,
 * a meno del suffisso.
 */
export function splitModelId(modelId: string): ModelIdParts {
  const m = /^(.*?)\[1m\]$/i.exec(modelId);
  if (!m) return { name: modelId, longContext: false };
  return { name: m[1], longContext: true };
}

/**
 * "claude-opus-4-8" → "Opus 4.8" — strip the `claude-` prefix, capitalize the
 * family name, join the remaining numeric segments with dots as the version.
 * Generic on purpose: a new model id needs no update here.
 *
 * The `[1m]` suffix is the CLI's long-context variant and becomes a readable
 * badge ("Opus 5 · 1M"): it is the difference between a 200k and a 1M window,
 * so it has to be legible in the picker, not glued onto the version number.
 */
export function friendlyModelLabel(modelId: string): string {
  if (modelId === 'codex') return 'Codex';
  const routed = /^(topics|claude-code|jcode|codex):(.*)$/.exec(modelId);
  if (routed) {
    const runtime = routed[1] === 'topics' ? 'Topics'
      : routed[1] === 'claude-code' ? 'Claude Code'
        : routed[1] === 'codex' ? 'Codex' : 'jcode';
    if (!routed[2] || routed[2] === 'auto') return `Automatic · ${runtime}`;
    const model = routed[2];
    const modelLabel = model.startsWith('gpt-') || model.startsWith('claude-')
      ? friendlyModelLabel(model)
      : model;
    return `${modelLabel} · ${runtime}`;
  }
  if (modelId.startsWith('gpt-')) return modelId.replace(/^gpt-/, 'GPT-');
  const long = /\[1m\]$/i.test(modelId);
  // A dated snapshot (`-20251001`, the server's DATED_SUFFIX) is not part of
  // the version: kept, it read «Haiku 4.5.20251001».
  const parts = modelId.replace(/^claude-/, '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '').split('-');
  const name = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : modelId;
  const version = parts.slice(1).join('.');
  const base = version ? `${name} ${version}` : name;
  return long ? `${base} · 1M` : base;
}

/**
 * The label a trigger shows for a choice: the provider's own catalog name when
 * the snapshot carries one (MSEL-09, «GPT-6.1-Sol»), else `modelDisplayLabel`.
 * The rows of the selector and the trigger that opened it then say the same.
 */
export function catalogModelLabel(
  snapshot: { providers: Array<{ name: string; modelInfo?: Record<string, { label?: string }> }> } | null | undefined,
  provider: string | null | undefined,
  modelId: string,
): string {
  const entries = snapshot?.providers ?? [];
  const own = entries.find((entry) => entry.name === provider)?.modelInfo?.[modelId]?.label;
  const any = own ?? entries.map((entry) => entry.modelInfo?.[modelId]?.label).find(Boolean);
  return any ?? modelDisplayLabel(modelId);
}

const DATE8 = /^\d{8}$/;
const MONTH_DAY = /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
/** Tokens that are acronyms, upper-case whole. */
const ACRONYMS = new Set(['glm', 'it', 'moe', 'xs', 'er', 'dbrx', 'oss']);
/** First tokens that are a company's own spelling. */
const PROPER = new Map([['deepseek', 'DeepSeek'], ['qwen', 'Qwen'], ['nvidia', 'NVIDIA'], ['ibm', 'IBM']]);

function claudeVersionLabel(bare: string): string | null {
  const m = bare.replace(/-\d{8}$/, '').replace(/\./g, '-');
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(m);
  if (!parts) return null;
  return `${parts[1]![0]!.toUpperCase()}${parts[1]!.slice(1)} ${parts[2]}${parts[3] ? `.${parts[3]}` : ''}`;
}

function sizeToken(word: string): boolean {
  return /^\d+(\.\d+)?[bmk]$/i.test(word) || /^a\d+(\.\d+)?[bm]$/i.test(word) || /^\d+x\d+[bm]$/i.test(word);
}

/**
 * THE LABEL OF A MODEL, one function for rows, closed triggers, `/model`, the
 * empty chat and the board (revision 2026-10-04 §3.6): the catalog's own label
 * when it has one; Anthropic keeps today's rule (`Opus 5.5`); every other id
 * loses its `vendor/`, its dates and a first token that repeats the company,
 * sizes go upper-case (30B, A3B, 8x22B), acronyms whole, words capitalised.
 * The `[1m]` mode is never part of the name: it is the row's 1M switch.
 */
export function modelDisplayLabel(id: string, info?: { label?: string } | null): string {
  if (info?.label) return info.label;
  let m = bareModelId(id).replace(/\[1m\]$/i, '');
  const slash = m.indexOf('/');
  const hadVendor = slash > 0;
  if (hadVendor) m = m.slice(slash + 1);
  if (m.startsWith('claude-')) {
    const claude = claudeVersionLabel(m);
    if (claude) return claude;
  }
  let suffix = '';
  m = m.replace(/\[([a-z0-9]+)\]$/i, (_all, tag: string) => { suffix = ` (${tag})`; return ''; });
  let tag = '';
  const colon = m.indexOf(':');
  if (colon > 0) { tag = m.slice(colon + 1); m = m.slice(0, colon); }
  const words = m.split('-').filter(Boolean);
  if (tag && tag !== 'latest') words.push(tag);
  while (words.length > 1 && (DATE8.test(words[words.length - 1]!) || MONTH_DAY.test(words[words.length - 1]!))) words.pop();
  if (words.length > 2 && /^\d{4}$/.test(words[words.length - 1]!) && /^(0[1-9]|1[0-2])$/.test(words[words.length - 2]!)) words.splice(-2, 2);
  if (!hadVendor && words.length > 1 && words[0] === 'zai') words.shift();
  if (!words.length) return id;
  if (/^o\d/.test(words[0]!)) return words.join('-') + suffix;
  const openAiPrefix = words[0] === 'gpt';
  if (openAiPrefix) words.shift();
  const out = words.map((word, index) => {
    if (sizeToken(word)) return word.toUpperCase().replace('X', 'x');
    if (/^v\d/.test(word)) return word;
    if (index === 0 && PROPER.has(word)) return PROPER.get(word)!;
    if (ACRONYMS.has(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
  if (openAiPrefix) return `GPT-${out[0] ?? ''}${out.length > 1 ? ` ${out.slice(1).join(' ')}` : ''}${suffix}`;
  return out.join(' ') + suffix;
}

/** Who decides on Automatic, per surface (revision §3.7). */
export type TriggerSurface = 'chat' | 'task' | 'board' | 'provider';

export interface TriggerText {
  label: string;
  /** «via Topics», «via Codex», or who decides on Automatic; '' when nobody is named. */
  who: string;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type LabelSnapshot = { providers: Array<{ name: string; label?: string; modelInfo?: Record<string, { label?: string }> }> } | null | undefined;

/**
 * THE CLOSED TEXT OF EVERY MODEL TRIGGER (revision §3.8): `{ label, who }`,
 * written «label · who» by `triggerLine` on the composer chip, the chat
 * settings, the card chip, the card composer, the drawer and the board
 * settings. No context window: that is on the open row.
 */
export function modelTriggerText(
  value: { provider: string | null | undefined; model: string | null | undefined },
  ctx: { snapshot: LabelSnapshot; tr: Translate; surface: TriggerSurface; viaTopics?: boolean; automaticWho?: string | null },
): TriggerText {
  const { snapshot, tr } = ctx;
  const engineLabel = (name: string) => snapshot?.providers.find((entry) => entry.name === name)?.label ?? providerLabel(name);
  if (!value.model) {
    const label = tr('ai.selector.auto');
    if (value.provider) return { label, who: engineLabel(value.provider) };
    const who = ctx.surface === 'chat' ? ctx.automaticWho ?? ''
      : ctx.surface === 'task' ? tr('ai.selector.auto.followsBoard')
        : ctx.surface === 'board' ? tr('ai.selector.auto.topicsPicks') : '';
    return { label, who };
  }
  const { name } = splitModelId(value.model);
  const label = catalogModelLabel(snapshot, value.provider, name);
  const who = ctx.viaTopics ? tr('ai.selector.route.topics')
    : value.provider ? tr('ai.selector.route.via', { engine: engineLabel(value.provider) }) : '';
  return { label, who };
}

export function triggerLine(text: TriggerText): string {
  return text.who ? `${text.label} · ${text.who}` : text.label;
}

/**
 * The closed text of a CARD's model (`provider:model`, a bare legacy model,
 * `null`/`auto` = Automatic): the same «label · who» as every trigger. A bare
 * Claude id runs on Claude Code, as `cardRunsThroughTopics` reads it.
 */
export function taskTriggerLine(
  value: string | null | undefined,
  ctx: { snapshot: LabelSnapshot; tr: Translate; surface: 'task' | 'board'; viaTopics?: boolean },
): string {
  const selection = taskModelSelection(value);
  const provider = selection.provider && selection.provider !== 'topics'
    ? selection.provider
    : selection.model?.startsWith('claude-') ? 'claude-code' : null;
  return triggerLine(modelTriggerText({ provider, model: selection.model ?? null }, ctx));
}
