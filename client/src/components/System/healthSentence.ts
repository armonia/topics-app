/**
 * A health problem said in the reader's language. The server sends the type
 * and its pieces (`vars`); the sentence is built here from the catalogue.
 * A type this client does not know yet, or a problem without pieces, keeps
 * the server's own sentence, so a new problem is never shown blank.
 */
import { addCatalogue } from '../../lib/i18n';
import HEALTH_IT from '../../lib/i18n-health-it';
import HEALTH_EN from '../../lib/i18n-health-en';
import type { HealthProblem } from '../../../../shared/agents-health';

addCatalogue('it', HEALTH_IT);
addCatalogue('en', HEALTH_EN);

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The variant a type's pieces call for (a memory has an owner or only an id, a tool may say why it is down).
 *  A type with no such variant falls back to its base key. */
function variant(vars: Record<string, string>): string {
  if (vars.count) return '.count';
  if (vars.store) return '.store';
  if (vars.reason) return '.reason';
  if (vars.agent) return '.agent';
  return '';
}

export function healthSentence(tr: Translate, p: HealthProblem): string {
  if (!p.vars) return p.sentence;
  const base = `health.problem.${p.type}`;
  for (const key of [base + variant(p.vars), base]) {
    const said = tr(key, p.vars);
    if (said !== key) return said;
  }
  return p.sentence;
}
