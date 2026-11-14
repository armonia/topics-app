/**
 * The WIRING of the status table: the surfaces that say "awaiting you",
 * "working" and "failed" actually use `lib/statusVisual.ts`, and the colours
 * the module replaced do not come back.
 *
 * Read from the source on purpose. These are JSX attributes and table entries,
 * and rendering five panes to look at a class name would prove less: the
 * element is located by what it MEANS (its testid, its i18n key, its table
 * key), then the WHOLE element or entry is checked, multi-line included, for
 * the positive token and against the old one. A check that only looked at
 * lines holding `className` would miss a tint moved to a variable or to the
 * next line.
 *
 * @covers STATUS-VISUAL-01e, STATUS-VISUAL-01f, STATUS-VISUAL-01g, STATUS-VISUAL-01h
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const COMPONENTS = join(import.meta.dir, '../components');
const read = (rel: string) => readFileSync(join(COMPONENTS, rel), 'utf8');

/** Index just past the expression that starts at `from`: the first `,`, `;` or
 *  closing bracket at depth 0. Brackets and quotes are tracked, so a value
 *  spread over several lines (`{ Icon: Bot,\n tint: X }`) comes back whole. */
function expressionEnd(src: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return i;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return i;
  }
  return src.length;
}

/** The value of `key:` inside `scope`, multi-line included. */
function entry(scope: string, key: RegExp): string {
  const m = key.exec(scope);
  if (!m) throw new Error(`no entry ${key}`);
  const start = m.index + m[0].length;
  return scope.slice(start, expressionEnd(scope, start));
}

/** The object or array literal assigned to `const NAME` (its type annotation skipped). */
function objectOf(src: string, name: string): string {
  const i = src.indexOf(`const ${name}`);
  if (i < 0) throw new Error(`no const ${name}`);
  const m = /=\s*[[{]/.exec(src.slice(i));
  if (!m) throw new Error(`const ${name} is not a literal`);
  const open = i + m.index + m[0].length - 1;
  return src.slice(open, expressionEnd(src, open));
}

/** End of the JSX opening tag that starts at `lt` (braces-aware, so `=>` inside `{}` is not the end). */
function openingTagEnd(src: string, lt: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return src.length;
}

/** [start, end) of the JSX element whose opening tag starts at `lt`, or null when
 *  the `<` opens no element (a generic such as `useState<number>`). */
function elementRange(src: string, lt: number): [number, number] | null {
  const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(lt))![1]!;
  const end = openingTagEnd(src, lt);
  if (src[end - 1] === '/') return [lt, end + 1];
  const re = new RegExp(`<${tag.replace('.', '\\.')}(?=[\\s>/])|</${tag.replace('.', '\\.')}\\s*>`, 'g');
  re.lastIndex = end + 1;
  let depth = 1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) return [lt, m.index + m[0].length];
    } else if (src[openingTagEnd(src, m.index) - 1] !== '/') depth++;
  }
  return null;
}

/** The innermost JSX element that contains `anchor` (in its tag or its children). */
function elementAround(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  for (let lt = src.lastIndexOf('<', at); lt >= 0; lt = src.lastIndexOf('<', lt - 1)) {
    if (!/^<[A-Za-z]/.test(src.slice(lt, lt + 2))) continue;
    const range = elementRange(src, lt);
    if (range && range[0] <= at && at < range[1]) return src.slice(range[0], range[1]);
  }
  throw new Error(`no element around ${anchor}`);
}

const ROSE = /\b(?:rose|pink)-\d/;
const GREEN = /\b(?:emerald|green)-\d|STATUS_(?:DOT|INK|CHIP)\.ok\b|PALLINO_OK|SEGNALE_OK|SUCCESS_TEXT/;
const DANGER = /STATUS_CHIP\.danger|STATUS_INK\.danger|DANGER_TEXT/;

describe('statusVisual wiring', () => {
  test('STATUS-VISUAL-01e: "awaiting you" is amber with the CircleAlert mark wherever it is drawn', () => {
    const needsInput = entry(objectOf(read('Board/constants.ts'), 'DISPATCH_CHIP'), /\bneeds_input:\s*/);
    expect(needsInput).toContain('STATUS_CHIP.wait');
    expect(needsInput).toContain('Icon: STATUS_ICON.wait');
    expect(needsInput).not.toMatch(ROSE);

    for (const [file, anchor] of [
      ['Board/Card.tsx', "tr('board.card.awaitingYou')"],
      ['Processes/SessionConsumption.tsx', "tr('board.card.awaitingYou')"],
    ] as const) {
      const el = elementAround(read(file), anchor);
      expect(el, file).toContain('STATUS_CHIP.wait');
      expect(el, file).toContain('<STATUS_ICON.wait');
      expect(el, file).not.toMatch(ROSE);
    }

    // The lit count of the Board row: the review slot counts "awaiting you".
    const counts = read('Sidebar/BoardStatusCounts.tsx');
    const lit = counts.slice(counts.indexOf("status === 'review'\n"), counts.indexOf('<StatusIcon status={status} />'));
    expect(lit).toContain('<STATUS_ICON.wait');
    expect(lit).toContain('STATUS_INK.wait');

    const sections = objectOf(read('Sidebar/TopicTree.tsx'), 'STATE_SECTIONS');
    expect(sections).toMatch(/key: 'needs-you', icon: STATUS_ICON\.wait\b/);

    const mobile = elementAround(read('Sidebar/MobileChromeBar.tsx'), 'testId="mobile-chrome-waiting"');
    expect(mobile).toContain('<STATUS_ICON.wait');
  });

  test('STATUS-VISUAL-01f: "working" is the sky of in_progress, never the green of done', () => {
    const pane = read('Agents/AgentsPane.tsx');
    for (const [name, token] of [['DOT', 'STATUS_DOT.working'], ['TEXT', 'STATUS_INK.working']] as const) {
      const working = entry(objectOf(pane, name), /\bworking:\s*/);
      expect(working, `AgentsPane ${name}.working`).toContain(token);
      expect(working).not.toMatch(GREEN);
    }
    const groupCount = elementAround(pane, "tr('agents.working', { n: g.working })");
    expect(groupCount).toContain('STATUS_INK.working');
    expect(groupCount).toContain('STATUS_DOT.working');
    expect(groupCount).not.toMatch(GREEN);

    const lines = entry(objectOf(read('Sidebar/AgentLines.tsx'), 'SIGNALS'), /\bworking:\s*/);
    expect(lines).toContain('tint: STATUS_INK.working');
    expect(lines).not.toMatch(GREEN);

    const row = elementAround(read('Sidebar/AgentsRow.tsx'), "tr('agents.working', { n: working })");
    expect(row).toContain('STATUS_INK.working');
    expect(row).not.toMatch(GREEN);

    const tree = read('Sidebar/TopicTree.tsx');
    expect(objectOf(tree, 'STATE_SECTIONS')).toMatch(/key: 'working', icon: STATUS_ICON\.working\b/);
    const dot = elementAround(tree, "aria-label={tr('sidebar.subagents.working')}");
    expect(dot).toContain('STATUS_DOT.working');
    expect(dot).not.toMatch(GREEN);

    expect(entry(objectOf(read('Board/constants.ts'), 'DISPATCH_CHIP'), /\bworking:\s*/)).toContain('STATUS_CHIP.working');
  });

  test('STATUS-VISUAL-01g: errors, failures and stops are the danger red on the card and in the detail', () => {
    const failed = entry(objectOf(read('Board/constants.ts'), 'DISPATCH_CHIP'), /\bfailed:\s*/);
    expect(failed).toContain('STATUS_CHIP.danger');
    expect(failed).not.toMatch(ROSE);

    const sites: readonly (readonly [string, string])[] = [
      ['Board/Card.tsx', 'data-testid="card-action-error"'],
      ['Board/Card.tsx', 'data-testid="card-not-landed"'],
      ['Board/Card.tsx', "tr('board.card.checksRed')"],
      ['Board/Card.tsx', "tr('board.task.stopped')"],
      ['Board/Card.tsx', 'data-kind="unattended"'],
      ['Board/TaskThread.tsx', 'data-testid="task-action-error"'],
      ['Board/TaskDeliveryBand.tsx', 'data-testid="task-not-landed-banner"'],
      ['Board/TaskHeader.tsx', "tr('board.task.stopped')"],
      ['Board/TaskMetadata.tsx', 'data-testid={`subtask-work-${node.id}`}'],
      ['Board/TaskMetadata.tsx', "className={workChip.kind === 'unattended'"],
    ];
    for (const [file, anchor] of sites) {
      const el = elementAround(read(file), anchor);
      expect(el, `${file} ${anchor}`).toMatch(DANGER);
      expect(el, `${file} ${anchor}`).not.toMatch(ROSE);
    }
    // The load error draws its colour on the glyph, not on the box.
    const loadError = elementAround(read('Board/TaskDetail.tsx'), 'data-testid="task-load-error"');
    expect(loadError).toMatch(/<AlertTriangle className=\{`[^`]*\$\{DANGER_TEXT\}/);
    expect(loadError).not.toMatch(ROSE);

    // Rose survives on the Board only where it is not a state: the Review
    // column glyph and the priority. Every other rose is a regression.
    for (const file of ['Board/Card.tsx', 'Board/TaskDetail.tsx', 'Board/constants.ts']) {
      const src = read(file);
      const priorityDots = file.endsWith('constants.ts') ? objectOf(src, 'PRIORITY_DOT') : '';
      const roses = src.replace(priorityDots, '').split('\n').filter((l) => ROSE.test(l) && !/priority|review:|PRIORITY_DOT|\* /.test(l));
      expect(roses, file).toEqual([]);
    }
  });

  test('STATUS-VISUAL-01h: the hourglass has at most one meaning (one line) in the components', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (l.includes('Hourglass')) hits.push(`${p}:${i + 1}`); });
        }
      }
    };
    walk(COMPONENTS);
    expect(hits.length, hits.join('\n')).toBeLessThanOrEqual(1);
  });
});
