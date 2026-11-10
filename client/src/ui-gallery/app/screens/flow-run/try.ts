/**
 * The test of one step on a real example case: what the step reads from the
 * case and what it returns, each value with the words it comes from. The
 * result is plain data (a path instead of a handler), so it survives a reload.
 */
import type { Tone } from '../../../../ui/types';
import type { UiCopy } from '../../../../ui/copy/types';
import type { CaseSeed, FlowSeed, FlowStepSeed } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { daysFromToday } from '../../../../ui/fixtures/org/clock';
import { ruleHolds, type StepConfig } from '../../../../ui/flowrun/config';
import { P } from '../../paths';
import { protocolOf } from '../../store/cases';

export interface StoredRow {
  label: string;
  value: string;
  source?: { label: string; path?: string };
  tone?: Tone;
}

export interface StoredTry {
  caseId: string;
  caseTitle: string;
  at: string;
  input: StoredRow[];
  output: StoredRow[];
  note?: string;
}

const KIND_TO_TYPE: Record<string, string> = {
  ricorso: 'A', sgravio: 'B', concessione: 'D', accesso: 'F', segnalazione: 'D', fattura: 'E', verbale: 'C', irrigazione: 'D',
  regione: 'C', send: 'C', rifiuti: 'G', foglie: 'G', fir: 'G',
};

const average = (c: CaseSeed) => (c.fields.length ? Math.round(c.fields.reduce((s, f) => s + f.confidence, 0) / c.fields.length) : 94);

const docPath = (c: CaseSeed, doc?: string) => (doc ? P.recordDoc(c.id, doc) : P.record(c.id));

/** The cases a step can be tried on: those of its flow first, then the others of the organization. */
export function casesFor(flow: FlowSeed, all: CaseSeed[]): CaseSeed[] {
  const own = all.filter((c) => c.flow === flow.id);
  return own.length ? own : all.filter((c) => c.org === flow.org);
}

export function buildTry(copy: UiCopy, step: FlowStepSeed, cfg: StepConfig, c: CaseSeed, at: string): StoredTry {
  const t = copy.flowRun.tryIt.rows;
  const first = c.documents[0];
  const conf = average(c);
  const subject: StoredRow = { label: t.subject, value: c.subject, source: first ? { label: first.name, path: docPath(c, first.id) } : undefined };
  const sender: StoredRow = { label: t.sender, value: c.counterpart };
  const attachments: StoredRow = { label: t.attachments, value: c.documents.map((d) => d.name).join(', ') || t.noKnowledge };
  const base = { caseId: c.id, caseTitle: c.title, at };
  switch (cfg.type) {
    case 'classify': {
      const letter = KIND_TO_TYPE[c.kind] ?? 'C';
      const type = cfg.types.find((x) => x.letter === letter) ?? cfg.types[0];
      const sure = conf >= cfg.threshold;
      return {
        ...base,
        input: [subject, sender, attachments, { label: t.knowledge, value: cfg.knowledge.join(', ') || t.noKnowledge }],
        output: [
          { label: t.type, value: `${type.letter} · ${type.name}`, source: first ? { label: first.name, path: docPath(c, first.id) } : undefined },
          { label: t.office, value: OFFICE_LABEL[c.office] },
          { label: t.confidence, value: `${conf}%`, tone: sure ? 'green' : 'amber' },
          { label: t.decides, value: sure ? t.outcomeElse : t.outcomeThen, tone: sure ? 'green' : 'amber' },
          { label: t.reason, value: t.reasonText(OFFICE_LABEL[c.office], conf) },
        ],
      };
    }
    case 'ai': {
      const out: StoredRow[] = cfg.fields.map((f, i) => {
        const found = c.fields.find((x) => x.label.toLowerCase() === f.name.toLowerCase()) ?? c.fields[i];
        if (f.name === 'fiducia') return { label: f.name, value: `${conf}%`, tone: conf >= cfg.threshold ? 'green' : 'amber' } as StoredRow;
        return {
          label: f.name,
          value: found?.value ?? c.subject,
          source: found ? { label: `${found.source.doc} · ${copy.common.page(found.source.page)}`, path: docPath(c, found.source.doc) } : undefined,
        };
      });
      return {
        ...base,
        input: [subject, attachments, { label: t.knowledge, value: cfg.knowledge.join(', ') || t.noKnowledge }, { label: t.fields, value: cfg.fields.map((f) => f.name).join(', ') }],
        output: out,
      };
    }
    case 'rule': {
      const next = c.deadlines[0];
      const values = { fiducia: conf, allegati: 0, mittente: false, giorni: next ? daysFromToday(next.date) : 90, importo: c.amount ?? 0 };
      const hit = ruleHolds(cfg.conditions, cfg.fields, values);
      return {
        ...base,
        input: [
          ...cfg.fields.filter((f) => cfg.conditions.some((x) => x.field === f.id)).map((f) => ({
            label: f.label,
            value: f.kind === 'list' ? (values.mittente ? copy.flowRun.rule.yes : copy.flowRun.rule.no) : String(values[f.id as keyof typeof values]),
          })),
        ],
        output: [
          { label: t.result, value: hit ? cfg.thenLabel : cfg.elseLabel, tone: hit ? 'amber' : 'green' },
          { label: t.checks, value: t.condition(cfg.conditions.length) },
        ],
        note: t.checksOk,
      };
    }
    case 'robot': {
      return {
        ...base,
        input: c.fields.slice(0, 3).map((f) => ({ label: f.label, value: f.value, source: { label: `${f.source.doc} · ${copy.common.page(f.source.page)}`, path: docPath(c, f.source.doc) } })),
        output: [
          { label: t.page, value: cfg.steps[0]?.page ?? cfg.program },
          { label: t.protocol, value: protocolOf(c)?.number ?? t.notSent },
          { label: t.result, value: t.readOnlyRun, tone: 'green' },
        ],
        note: t.notSent,
      };
    }
    default: {
      return {
        ...base,
        input: [{ label: t.fields, value: c.fields.map((f) => f.label).join(', ') }, subject],
        output: [
          { label: t.who, value: OFFICE_LABEL[step.office ?? c.office] },
          { label: step.kind === 'send' ? t.message : t.sees, value: c.proposal },
          { label: t.sent, value: t.notSent, tone: 'green' },
        ],
      };
    }
  }
}
