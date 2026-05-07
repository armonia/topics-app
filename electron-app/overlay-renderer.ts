/**
 * Phase 30.1 polish — Overlay window vanilla renderer.
 *
 * Mini DOM-only menu renderer for the trasparent BrowserWindow opened
 * by overlay-manager.ts. Receives item structure via IPC and renders
 * inline. Click → IPC select → main process resolves the parent's
 * Promise. Blur/Esc → IPC cancel.
 *
 * Why vanilla DOM (not React): the overlay is short-lived, single-purpose,
 * and a React bundle would add ~50KB+ for ~5 menu items. Vanilla keeps
 * the overlay <5KB total.
 *
 * Security: items pass `iconName` (string keyword), not raw SVG. The
 * renderer maps known names to hardcoded SVG paths. No innerHTML with
 * untrusted data.
 */

interface OverlayMenuItem {
  id: string;
  label: string;
  /** Predefined icon name. Maps to a hardcoded SVG path in ICONS. */
  iconName?: keyof typeof ICONS;
  /** Render a divider above this item. */
  divider?: boolean;
}

interface OverlayMenuInit {
  items: OverlayMenuItem[];
  theme: 'light' | 'dark';
  /** Reported back so caller can match the response to the request. */
  requestId: string;
}

interface OverlayBridge {
  onInit: (handler: (init: OverlayMenuInit) => void) => void;
  sendSelect: (requestId: string, itemId: string) => void;
  sendCancel: (requestId: string) => void;
}

const bridge = (window as unknown as { electronOverlayBridge: OverlayBridge }).electronOverlayBridge;

// SVG path-d strings from lucide-react icons (24x24 viewport).
// Adding a new icon = add a new key here, NOT pass raw SVG via IPC.
const ICONS = {
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18',
  terminal: 'M5 7l5 5-5 5M13 19h6',
  'message-square': 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  bot: 'M12 8V4H8M16 12H8M16 16H8M4 12V20a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V12a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2zM2 12h2M20 12h2',
  'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  layout: 'M3 3h18v18H3zM3 9h18M9 21V9',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  'plus-square': 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM12 8v8M8 12h8',
} as const;

function makeIconSvg(name: keyof typeof ICONS): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.appendChild(path);
  return svg;
}

const panel = document.getElementById('panel') as HTMLDivElement;
let currentRequestId: string | null = null;

function renderMenu(init: OverlayMenuInit) {
  currentRequestId = init.requestId;
  document.body.classList.toggle('dark', init.theme === 'dark');
  panel.replaceChildren();

  for (const item of init.items) {
    if (item.divider) {
      const sep = document.createElement('div');
      sep.className = 'divider';
      panel.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('data-id', item.id);

    const iconWrap = document.createElement('span');
    iconWrap.className = 'icon';
    if (item.iconName && ICONS[item.iconName]) {
      iconWrap.appendChild(makeIconSvg(item.iconName));
    }
    btn.appendChild(iconWrap);

    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = item.label;
    btn.appendChild(labelEl);

    btn.addEventListener('click', () => {
      bridge.sendSelect(init.requestId, item.id);
    });
    panel.appendChild(btn);
  }
}

bridge.onInit(renderMenu);

// Esc cancels.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentRequestId) {
    bridge.sendCancel(currentRequestId);
  }
});
