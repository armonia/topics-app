import type { ReactNode } from 'react';
import type { UiCopy } from '../ui/copy/types';
import type { TabModel } from '../ui/types';
import { AppFrame } from '../ui/shell/AppFrame';
import { Sidebar } from '../ui/shell/Sidebar';
import { TabBar } from '../ui/shell/TabBar';
import { adminSidebar, adminTabs, type AdminSurface } from '../ui/fixtures/shell';
import { KitPage } from './KitPage';
import { IconLegend } from './IconLegend';

export interface GalleryScreen {
  id: string;
  title: string;
  render: (copy: UiCopy) => ReactNode;
}

/** The operator's window: the full sidebar and three tabs. */
function adminFrame(copy: UiCopy, surface: AdminSurface, tab: TabModel, pane: ReactNode) {
  return (
    <AppFrame
      sidebar={<Sidebar model={adminSidebar(surface)} copy={copy} />}
      tabBar={<TabBar tabs={adminTabs(tab)} copy={copy} />}
    >
      {pane}
    </AppFrame>
  );
}

/** The registry of the gallery: the ids are the mockups' own (`png/<id>.png`). */
export const SCREENS: GalleryScreen[] = [
  {
    id: 'shell',
    title: 'Shell',
    render: (copy) => adminFrame(copy, 'nav-flows', { id: 'tab-flows', kind: 'flows', label: copy.flows.root }, <div />),
  },
  {
    id: 'kit',
    title: 'Componenti condivisi', // allow-italian: gallery title
    render: (copy) => <KitPage copy={copy} />,
  },
  {
    id: 'z01',
    title: 'Sistema di icone', // allow-italian: mockup title
    render: (copy) => <IconLegend copy={copy} />,
  },
];
