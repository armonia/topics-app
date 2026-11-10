/**
 * SARIM edition, section «Contratti» of «Conoscenza»: the contract management
 * of the company. The list with its saved filters (sarim-contracts), the
 * deadlines of all the contracts as a list and as a month, two addresses
 * (sarim-contract-deadlines, sarim-contract-deadlines-month), and one
 * contract with the seven pages of its strip, each at its own address: the
 * text with its numbered clauses (sarim-contract, also on one clause), the
 * obligations, the comments, the versions (sarim-versions) with two of them
 * compared word by word (sarim-compare), the attachments with one as paper
 * (sarim-attachment), the approval chain with who may do what
 * (sarim-signatures) and the links to flows and cards. Every contract has its
 * own tab. Search finds the contracts (title, counterparty, CIG) and every
 * clause of the version in force. The wiring is in `contracts/`, the state in
 * `../model/live.ts` and the reading of the data in `../model/contracts.ts`.
 */
import { CalendarClock, FileText, Pilcrow } from 'lucide-react';
import type { AreaModule, Params, ScreenCtx, ScreenDef, SearchEntry } from '../../app/kit';
import { liveContractById, liveContracts } from '../model/live';
import { currentVersion, kindLabel } from '../model/contracts';
import { SP } from '../paths';
import { ListPlace } from './contracts/ListPlace';
import { DeadlinesPlace } from './contracts/DeadlinesPlace';
import { ContractPlace, type ContractMode } from './contracts/ContractPlace';
import { ComparePlace } from './contracts/ComparePlace';
import { AttachmentPlace } from './contracts/AttachmentPlace';
import { SignaturesPlace } from './contracts/SignaturesPlace';
import { attachmentsOf } from './contracts/view';
import { world } from '../world';

const ORG = { org: world().key, nav: 'knowledge', needs: 'view:contracts' } as const;

/** Every place under «Conoscenza» shares one tab; a contract names it after itself. */
const contractTab = {
  tabKey: () => 'sarim:knowledge',
  tab: (p: Params, ctx: ScreenCtx) => ({ label: liveContractById(ctx.state, p.id)?.title ?? ctx.copy.contracts.page.notFoundTitle, kind: 'contracts' as const }),
};

/** The list and the deadlines of the contracts. */
const areaTab = {
  tabKey: () => 'sarim:knowledge',
  tab: (_p: Params, ctx: ScreenCtx) => ({ label: ctx.copy.contracts.title, kind: 'contracts' as const }),
};

const contractTitle = (p: Params, ctx: ScreenCtx) => liveContractById(ctx.state, p.id)?.title ?? ctx.copy.contracts.page.notFoundTitle;
const withContract = (p: Params, ctx: ScreenCtx, part: string) => `${part} · ${contractTitle(p, ctx)}`;

function search(ctx: ScreenCtx): SearchEntry[] {
  const t = ctx.copy.contracts;
  return [
    {
      id: 'sarim-contract-deadlines',
      group: t.search.contracts,
      title: t.search.deadlines,
      detail: t.search.deadlinesDetail,
      path: SP.contractDeadlines(),
      icon: CalendarClock,
      needs: 'view:contracts',
    },
    ...liveContracts(ctx.state).flatMap((c): SearchEntry[] => {
      const v = currentVersion(c);
      return [
        {
          id: `sarim-contract:${c.id}`,
          group: t.search.contracts,
          title: c.title,
          detail: `${kindLabel[c.kind]} · ${c.counterparty}`,
          keywords: [c.counterparty, c.counterpartyKind, c.cig ?? '', c.object, ...(c.tags ?? [])].join(' '),
          path: SP.contract(c.id),
          icon: FileText,
          needs: 'view:contracts',
        },
        ...v.clauses.map((x): SearchEntry => ({
          id: `sarim-clause:${c.id}:${x.id}`,
          group: t.search.clauses,
          title: t.page.clauseHeading(x.n, x.title),
          detail: c.title,
          keywords: `${c.counterparty} ${x.text}`,
          path: SP.clause(c.id, x.id),
          icon: Pilcrow,
          needs: 'view:contracts',
        })),
      ];
    }),
  ];
}

/** One page of a contract that draws the text with a panel beside it. */
const textPage = (id: string, path: string, mode: ContractMode, samples: string[], title: (p: Params, ctx: ScreenCtx) => string): ScreenDef => ({
  id, path, ...ORG, ...contractTab, samples, title,
  render: (p, ctx) => <ContractPlace key={p.id} ctx={ctx} id={p.id} mode={mode} />,
});

export const SARIM_CONTRACTS_AREA: AreaModule = {
  screens: [
    {
      id: 'sarim-contracts', path: '/conoscenza/contratti', ...ORG, ...areaTab, // allow-italian: address pattern, not shown
      samples: [SP.contracts()],
      title: (_p, ctx) => ctx.copy.contracts.title,
      render: (_p, ctx) => <ListPlace ctx={ctx} />,
    },
    {
      id: 'sarim-contract-deadlines', path: '/conoscenza/contratti/scadenze', ...ORG, ...areaTab, // allow-italian: address pattern, not shown
      samples: [SP.contractDeadlines()],
      title: (_p, ctx) => ctx.copy.contracts.deadlines.title,
      render: (_p, ctx) => <DeadlinesPlace ctx={ctx} view="list" />,
    },
    {
      id: 'sarim-contract-deadlines-month', path: '/conoscenza/contratti/scadenze/mese', ...ORG, ...areaTab, // allow-italian: address pattern, not shown
      samples: [SP.contractDeadlinesMonth()],
      title: (_p, ctx) => `${ctx.copy.contracts.deadlines.title} · ${ctx.copy.contracts.deadlines.views.calendar}`,
      render: (_p, ctx) => <DeadlinesPlace ctx={ctx} view="month" />,
    },
    {
      id: 'sarim-contract', path: '/conoscenza/contratti/:id', ...ORG, ...contractTab, // allow-italian: address pattern, not shown
      samples: world().samples.contracts.map((id) => SP.contract(id)),
      title: contractTitle,
      render: (p, ctx) => <ContractPlace key={p.id} ctx={ctx} id={p.id} mode="text" />,
    },
    {
      id: 'sarim-contract', path: '/conoscenza/contratti/:id/clausola/:clause', ...ORG, ...contractTab, // allow-italian: address pattern, not shown
      samples: world().samples.clauses.map(([id, clause]) => SP.clause(id, clause)),
      title: (p, ctx) => {
        const c = liveContractById(ctx.state, p.id);
        const x = c && currentVersion(c).clauses.find((y) => y.id === p.clause);
        return x ? withContract(p, ctx, ctx.copy.contracts.page.clauseHeading(x.n, x.title)) : contractTitle(p, ctx);
      },
      render: (p, ctx) => <ContractPlace key={p.id} ctx={ctx} id={p.id} clause={p.clause} mode="text" />,
    },
    textPage('sarim-contract-obligations', '/conoscenza/contratti/:id/obblighi', 'obligations', world().samples.contractObligations.map((id) => SP.contractObligations(id)), (p, ctx) => withContract(p, ctx, ctx.copy.contracts.side.tabs.obligations)), // allow-italian: address pattern, not shown
    textPage('sarim-contract-comments', '/conoscenza/contratti/:id/commenti', 'comments', world().samples.contractComments.map((id) => SP.contractComments(id)), (p, ctx) => withContract(p, ctx, ctx.copy.contracts.side.tabs.comments)), // allow-italian: address pattern, not shown
    textPage('sarim-versions', '/conoscenza/contratti/:id/versioni', 'versions', world().samples.contractVersions.map((id) => SP.versions(id)), (p, ctx) => withContract(p, ctx, ctx.copy.contracts.side.tabs.versions)), // allow-italian: address pattern, not shown
    textPage('sarim-contract-attachments', '/conoscenza/contratti/:id/allegati', 'attachments', world().samples.contractAttachments.map((id) => SP.contractAttachments(id)), (p, ctx) => withContract(p, ctx, ctx.copy.contracts.side.tabs.attachments)), // allow-italian: address pattern, not shown
    textPage('sarim-contract-links', '/conoscenza/contratti/:id/collegamenti', 'links', world().samples.contractLinks.map((id) => SP.contractLinks(id)), (p, ctx) => withContract(p, ctx, ctx.copy.contracts.side.tabs.links)), // allow-italian: address pattern, not shown
    {
      id: 'sarim-compare', path: '/conoscenza/contratti/:id/confronto/:from/:to', ...ORG, ...contractTab, // allow-italian: address pattern, not shown
      samples: world().samples.compares.map(([id, from, to]) => SP.compare(id, from, to)),
      title: (p, ctx) => withContract(p, ctx, ctx.copy.contracts.compare.title(Number(p.from), Number(p.to))),
      render: (p, ctx) => <ComparePlace ctx={ctx} id={p.id} from={Number(p.from)} to={Number(p.to)} />,
    },
    {
      id: 'sarim-attachment', path: '/conoscenza/contratti/:id/allegati/:doc', ...ORG, ...contractTab, // allow-italian: address pattern, not shown
      samples: world().samples.attachments.map(([id, doc]) => SP.attachment(id, doc)),
      title: (p, ctx) => {
        const c = liveContractById(ctx.state, p.id);
        const a = c && attachmentsOf(ctx, c).find((x) => x.id === p.doc);
        return withContract(p, ctx, a?.name ?? ctx.copy.contracts.attachment.crumb);
      },
      render: (p, ctx) => <AttachmentPlace ctx={ctx} id={p.id} doc={p.doc} />,
    },
    {
      id: 'sarim-signatures', path: '/conoscenza/contratti/:id/firme', ...ORG, ...contractTab, // allow-italian: address pattern, not shown
      samples: world().samples.signatures.map((id) => SP.signatures(id)),
      title: (p, ctx) => withContract(p, ctx, ctx.copy.contracts.signatures.crumb),
      render: (p, ctx) => <SignaturesPlace ctx={ctx} id={p.id} />,
    },
  ],
  search,
};
