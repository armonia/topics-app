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
  /** Optional brand colour (CSS string) for the icon. Mirrors what the web
   *  PaneAddMenu does via `style={{ color: cfg.color }}` on lucide icons —
   *  e.g. Claude orange `#D97757`, terminal purple `#8b5cf6`, browser
   *  green `#10b981`. Without this the overlay renders mono-colour icons
   *  while the web menu shows them branded, which made the two surfaces
   *  look like different menus to the user. */
  iconColor?: string;
  /** Render a divider above this item. */
  divider?: boolean;
}

interface OverlayMenuInit {
  items: OverlayMenuItem[];
  theme: 'light' | 'dark';
  /** Reported back so caller can match the response to the request. */
  requestId: string;
  /** Optional CSS color overrides extracted from the parent app's theme. */
  colors?: {
    bg?: string;
    text?: string;
    muted?: string;
    border?: string;
    hover?: string;
  };
}

interface OverlayBridge {
  onInit: (handler: (init: OverlayMenuInit) => void) => void;
  sendSelect: (requestId: string, itemId: string) => void;
  sendCancel: (requestId: string) => void;
}

const bridge = (window as unknown as { electronOverlayBridge: OverlayBridge }).electronOverlayBridge;

// Icon registry. Each entry is the inner-SVG body of the corresponding
// lucide-react icon (or, for `claude`, the official Anthropic logo). Two
// rendering modes:
//
//   - default (stroked outline): matches lucide-react's default look —
//     `fill="none"`, `stroke="currentColor"`, stroke-width 2. Used by the
//     web menu's <Globe/>, <Terminal/>, <GitBranch/> etc.
//   - `filled: true`: solid fill with `currentColor`, no stroke. Used for
//     the Anthropic Claude glyph (a solid logo, not an outline icon) so
//     the overlay matches the web menu's <ClaudeIcon /> exactly.
//
// `body` is parsed once via DOMParser at first use and the resulting nodes
// are cloned per render — no innerHTML, no IPC-supplied SVG, so the same
// security guarantees as the previous string-path approach hold (data is
// hardcoded constant, never user-supplied).
//
// Adding a new icon: paste the lucide-react inner SVG (or any equivalent
// SVG body) here and reference it by key. The PaneAddMenu side mirrors
// these keys via `OVERLAY_ICON_BY_LUCIDE`.
interface IconSpec {
  body: string;
  filled?: boolean;
}

const ICONS: Record<string, IconSpec> = {
  globe: {
    body:
      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  },
  terminal: { body: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
  // Shell pty pane — distinct from the generic 'terminal' icon so the
  // overlay matches the web menu's <TerminalSquare /> for the Shell row.
  'terminal-square': {
    body:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/>',
  },
  'message-square': {
    body:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  },
  folder: { body: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' },
  // Files pane — matches the web menu's <FolderTree /> for project files.
  'folder-tree': {
    body:
      '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>',
  },
  // Git pane — matches the web menu's <GitBranch />.
  'git-branch': {
    body:
      '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  },
  // Board Memory pane — matches the web menu's <Brain />.
  brain: {
    body:
      '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>',
  },
  // File pane — matches the web menu's <FileCode />.
  'file-code': {
    body:
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="m9 18 3-3-3-3"/><path d="m5 12-3 3 3 3"/>',
  },
  bot: {
    body:
      '<rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>',
  },
  // Anthropic Claude logo — solid filled glyph (NOT an outlined lucide
  // icon). Matches <ClaudeIcon /> in the web menu so Claude Code reads
  // the same way regardless of overlay vs portal rendering.
  claude: {
    filled: true,
    body:
      '<path d="M4.709 15.005l4.473-2.508.076-.218-.076-.121H9.005l-.748-.046-2.553-.068-2.215-.093-2.145-.114-.542-.115L0 11.16l.051-.334.456-.305.649.057 1.438.098 2.157.15 1.564.091 2.318.242h.369l.051-.15-.127-.092-.097-.092-2.232-1.514-2.416-1.598-1.264-.921-.684-.466-.346-.436-.148-.955.62-.684.834.057.214.057.846.65 1.806 1.399 2.358 1.737.345.288.138-.097.017-.07-.155-.258-1.283-2.318-1.369-2.36-.61-.978-.161-.586a2.85 2.85 0 0 1-.097-.69l.707-.961L5.32.426l.944.127.398.345.586 1.34.95 2.11 1.472 2.872.431.851.231.789.085.242h.15v-.138l.121-1.617.224-1.985.22-2.555.074-.719.356-.863.709-.466.551.265.455.65-.064.419-.271 1.754-.527 2.752-.346 1.84h.202l.23-.228.932-1.238 1.564-1.957.69-.777.806-.857.518-.41h.978l.72 1.071-.322 1.105-1.009 1.277-.834 1.082-1.196 1.611-.747 1.289.068.103.178-.017 2.704-.575 1.46-.265 1.744-.3.789.368.085.375-.311.765-1.864.461-2.186.438-3.257.77-.04.028.046.057 1.467.14.627.034h1.536l2.858.214.749.493.449.605-.076.461-1.15.586-5.177-1.231-1.244-.311h-.171v.104l1.035 1.013 1.898 1.714 2.377 2.21.12.547-.305.431-.322-.046-2.088-1.57-.806-.709-1.825-1.536h-.12v.161l.421.616 2.22 3.337.114 1.024-.16.334-.576.201-.633-.114-1.299-1.825-1.34-2.054-1.082-1.841-.133.076-.639 6.875-.3.351-.69.265-.575-.438-.305-.707.305-1.398.368-1.825.3-1.449.271-1.802.16-.599-.011-.04-.131.017-1.359 1.864-2.065 2.79-1.635 1.75-.39.155-.68-.352.064-.627.379-.556 2.262-2.878 1.363-1.783.88-1.031-.006-.15h-.051l-6.006 3.901-1.069.137-.462-.431.057-.707.22-.231 1.806-1.242z"/>',
  },
  'file-text': {
    body:
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  },
  layout: {
    body:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  },
  list: {
    body:
      '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  },
  'plus-square': {
    body:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  },
};

function makeIconSvg(name: keyof typeof ICONS, color?: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const spec = ICONS[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (spec.filled) {
    // Solid logos (Claude): fill with currentColor, no stroke.
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('stroke', 'none');
  } else {
    // Lucide outline default: hollow stroke at width 2, rounded joins.
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  // Brand-tint when the caller specifies a colour. Without this the SVG
  // inherits `currentColor` from the .icon span (mono text colour) and the
  // overlay menu looks plain compared to the web portal menu — which is
  // exactly the divergence this fix is solving.
  if (color) svg.style.color = color;
  // Parse the icon body once via DOMParser (safe: bodies are constant
  // hardcoded SVG fragments, never user-supplied) and clone its children
  // into our SVG element. This keeps multi-element icons (rect+path+line)
  // working without falling back to innerHTML on the SVG element.
  const wrapped = `<svg xmlns="${NS}">${spec.body}</svg>`;
  const parsed = new DOMParser().parseFromString(wrapped, 'image/svg+xml').documentElement;
  for (const child of Array.from(parsed.childNodes)) {
    svg.appendChild(child.cloneNode(true));
  }
  return svg;
}

const panel = document.getElementById('panel') as HTMLDivElement;
let currentRequestId: string | null = null;

function renderMenu(init: OverlayMenuInit) {
  currentRequestId = init.requestId;
  document.body.classList.toggle('dark', init.theme === 'dark');

  // Apply theme colors from parent app (CSS variables on body) so the
  // overlay always matches the active app theme (light/dark/custom).
  if (init.colors) {
    const root = document.body.style;
    if (init.colors.bg) root.setProperty('--ovl-bg', init.colors.bg);
    if (init.colors.text) root.setProperty('--ovl-text', init.colors.text);
    if (init.colors.muted) root.setProperty('--ovl-muted', init.colors.muted);
    if (init.colors.border) root.setProperty('--ovl-border', init.colors.border);
    if (init.colors.hover) root.setProperty('--ovl-hover', init.colors.hover);
  }

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
      iconWrap.appendChild(makeIconSvg(item.iconName, item.iconColor));
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
