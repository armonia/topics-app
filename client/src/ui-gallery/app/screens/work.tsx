/**
 * The places of the `work` area: «La mia giornata» (x05), the queue (n12), the
 * origin of a value (v02), a record open to work on it (x06), an original
 * with its summary (v01) and the full sheet of a record (w05); the phone
 * layout (m01) is the same places under 768px. See `../kit.ts` for the
 * contract and `./work/` for the wiring of each place.
 */
import { FileText } from 'lucide-react';
import type { AreaModule, Params, ScreenCtx, ScreenDef, SearchEntry } from '../kit';
import { CASES } from '../../../ui/fixtures/org/cases';
import { recordName } from '../../../ui/fixtures/work';
import { P } from '../paths';
import { queueFor, visibleCases } from '../store/cases';
import { InboxPlace, OriginPlace } from './work/InboxPlace';
import { RecordPlace } from './work/RecordPlace';
import { DocPlace } from './work/DocPlace';
import { SheetPlace } from './work/SheetPlace';
import { TodayPlace } from './work/TodayPlace';
import { recordPathOf } from './work/adapters';

/* The cases the sample addresses open: the first of Nocera (2418, the complete one), a second to show another type, and SARIM's. */
const NOCERA_CASES = CASES.filter((c) => c.org === 'nocera');
const FIRST = NOCERA_CASES[0];
const OTHER = NOCERA_CASES.find((c) => c.kind !== FIRST?.kind) ?? FIRST;
const SARIM = CASES.find((c) => c.org === 'sarim');
const FIRST_ID = FIRST?.id ?? '2418';
const OTHER_ID = OTHER?.id ?? FIRST_ID;
const DOC_ID = FIRST?.documents.find((d) => d.id !== 'ricevuta' && !d.draft)?.id ?? 'd-ricorso';
const OTHER_DOC_ID = OTHER?.documents.find((d) => !d.draft)?.id ?? DOC_ID;
const FIELD_ID = FIRST?.fields.find((f) => f.id === 'scadenza')?.id ?? FIRST?.fields[0]?.id ?? 'scadenza';

const recordTab = (p: Params) => ({ key: `record:${p.id}`, label: recordName(p.id), kind: 'record' as const });
const inboxTab = (_p: unknown, ctx: ScreenCtx) => ({ key: 'inbox', label: ctx.copy.shell.nav.inbox, kind: 'inbox' as const, count: queueFor(ctx.state, ctx.persona).length });

const screens: ScreenDef[] = [
  {
    id: 'x05', path: '/oggi', org: 'nocera', nav: 'today', needs: 'view:today', samples: [P.today()],
    tabKey: () => 'today',
    tab: () => ({ kind: 'today' }),
    title: (_p, ctx) => ctx.copy.work.today.title,
    render: (_p, ctx) => <TodayPlace ctx={ctx} />,
  },
  {
    id: 'n12', path: '/da-fare', org: 'nocera', nav: 'inbox', needs: 'view:inbox', samples: [P.inbox()],
    tab: inboxTab,
    title: (_p, ctx) => ctx.copy.shell.nav.inbox,
    render: (_p, ctx) => <InboxPlace ctx={ctx} />,
  },
  {
    id: 'n12', path: '/da-fare/:item', org: 'nocera', nav: 'inbox', needs: 'view:inbox', samples: [P.inbox(FIRST_ID), P.inbox(OTHER_ID)],
    tab: inboxTab,
    title: (_p, ctx) => ctx.copy.shell.nav.inbox,
    render: (p, ctx) => <InboxPlace ctx={ctx} item={p.item} />,
  },
  {
    id: 'v02', path: '/da-fare/:item/origine/:field', org: 'nocera', nav: 'inbox', needs: 'view:inbox', samples: [P.inboxOrigin(FIRST_ID, FIELD_ID)],
    tab: inboxTab,
    title: (_p, ctx) => ctx.copy.shell.nav.inbox,
    render: (p, ctx) => <OriginPlace ctx={ctx} id={p.item} field={p.field} from="inbox" />,
  },
  {
    id: 'v02', path: '/pratiche/:id/origine/:field', org: 'nocera', nav: 'data', needs: 'view:data', samples: [P.recordOrigin(FIRST_ID, FIELD_ID)],
    tab: recordTab,
    title: (p) => recordName(p.id),
    render: (p, ctx) => <OriginPlace ctx={ctx} id={p.id} field={p.field} from="record" />,
  },
  {
    id: 'x06', path: '/pratiche/:id', org: 'nocera', nav: 'data', needs: 'view:data', samples: [P.record(FIRST_ID), ...(OTHER_ID !== FIRST_ID ? [P.record(OTHER_ID)] : [])],
    tab: recordTab,
    title: (p) => recordName(p.id),
    render: (p, ctx) => <RecordPlace ctx={ctx} id={p.id} />,
  },
  {
    id: 'x06', path: '/sarim/pratiche/:id', org: 'sarim', nav: 'callcenter', needs: 'view:callcenter', samples: [P.sarimRecord(SARIM?.id ?? FIRST_ID)],
    tab: recordTab,
    title: (p) => recordName(p.id),
    render: (p, ctx) => <RecordPlace ctx={ctx} id={p.id} />,
  },
  {
    id: 'v01', path: '/pratiche/:id/documenti/:doc', org: 'nocera', nav: 'data', needs: 'view:data', samples: [P.recordDoc(FIRST_ID, DOC_ID), ...(OTHER_ID !== FIRST_ID ? [P.recordDoc(OTHER_ID, OTHER_DOC_ID)] : [])],
    tab: recordTab,
    title: (p) => recordName(p.id),
    render: (p, ctx) => <DocPlace ctx={ctx} id={p.id} doc={p.doc} />,
  },
  {
    id: 'w05', path: '/pratiche/:id/scheda', org: 'nocera', nav: 'data', needs: 'view:data', samples: [P.recordSheet(FIRST_ID)],
    tab: recordTab,
    title: (p) => recordName(p.id),
    render: (p, ctx) => <SheetPlace ctx={ctx} id={p.id} />,
  },
];

/** Every case the person can see, and every document of it, findable by number, protocol, subject, counterpart, place and the words of the pages. */
function search(ctx: ScreenCtx): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const c of visibleCases(ctx.state, ctx.persona)) {
    const need = c.org === 'sarim' ? 'view:callcenter' as const : 'view:data' as const;
    out.push({
      id: `case:${c.id}`,
      group: ctx.copy.work.search.cases,
      title: `${recordName(c.id)} · ${c.title}`,
      detail: `${c.counterpart} · ${c.subject}`,
      keywords: [c.id, c.protocol?.number, c.subject, c.comune, c.counterpart, c.title, c.proposal].filter(Boolean).join(' '),
      path: recordPathOf(c),
      icon: FileText,
      needs: need,
    });
    for (const d of c.documents) {
      out.push({
        id: `doc:${c.id}:${d.id}`,
        group: ctx.copy.work.search.documents,
        title: d.name,
        detail: `${recordName(c.id)} · ${d.detail}`,
        keywords: `${d.name} ${d.summary.map((s) => s.text).join(' ')} ${d.text.join(' ')}`,
        path: P.recordDoc(c.id, d.id),
        icon: FileText,
        needs: 'view:data',
      });
    }
  }
  return out;
}

export const WORK_AREA: AreaModule = { screens, search };
