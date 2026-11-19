/**
 * The strip under the header of every page of «Conoscenza»: Documents,
 * Contracts, Data and Rules, each with how many it holds and its own address.
 * A section the person has no access to is left out. (allow-italian: quotes the Italian interface)
 */
import type { LucideIcon } from 'lucide-react';
import { FileText, ScrollText } from 'lucide-react';
import { NAV_ICON } from '../../../../ui/icons';
import { SubNav, type SubNavItem } from '../../../../ui/shell/SubNav';
import { world } from '../../world';
import type { ScreenCtx } from '../../../app/kit';
import { atLeast, sectionLevel, type AccessSection } from '../../model/access';
import { liveContracts } from '../../model/live';
import { SP } from '../../paths';
import { TABLE_IDS } from '../data/tables';
import { isCompanyDoc } from './collections';
import { SECTION_STRIP } from '../../../../ui/shell/layout';

export type KnowledgeSection = 'documents' | 'contracts' | 'data' | 'rules';

const SECTION_ACCESS: Record<KnowledgeSection, AccessSection> = { documents: 'documents', contracts: 'contracts', data: 'data', rules: 'rules' };

/** Where each section opens. */
const SECTION_PATH: Record<KnowledgeSection, () => string> = {
  documents: SP.documents, contracts: SP.contracts, data: () => SP.data(), rules: SP.rules,
};


export function KnowledgeNav({ ctx, active }: { ctx: ScreenCtx; active: KnowledgeSection }) {
  const s = ctx.copy.sarimData.section;
  const counts: Record<KnowledgeSection, number> = {
    documents: world().knowledge.docs.filter((d) => isCompanyDoc(d.collection)).length,
    rules: world().knowledge.docs.filter((d) => !isCompanyDoc(d.collection)).length,
    contracts: liveContracts(ctx.state).length,
    data: TABLE_IDS.length,
  };
  const all: Array<[KnowledgeSection, string, LucideIcon]> = [
    ['documents', s.documents, FileText],
    ['contracts', s.contracts, NAV_ICON.contracts],
    ['data', s.data, NAV_ICON.data],
    ['rules', s.rules, ScrollText],
  ];
  const items: SubNavItem[] = all
    .filter(([id]) => atLeast(sectionLevel(ctx.state, ctx.persona, SECTION_ACCESS[id]), 'view') || id === active)
    .map(([id, label, icon]) => ({ id, label, icon, count: counts[id], active: id === active }));
  return (
    <div className={SECTION_STRIP}>
      <SubNav items={items} label={s.label} onSelect={(id) => ctx.go(SECTION_PATH[id as KnowledgeSection]())} />
    </div>
  );
}
