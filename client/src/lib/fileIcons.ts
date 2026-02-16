// Shared file icon utility — used by FileExplorer, FilePane, PaneTabBar, EditorTabs

const EXT_ICONS: Record<string, string> = {
  ts: '🔷', tsx: '⚛️', js: '🟡', jsx: '⚛️',
  json: '📋', md: '📝', css: '🎨', scss: '🎨',
  html: '🌐', svg: '🖼️', png: '🖼️', jpg: '🖼️', gif: '🖼️', webp: '🖼️',
  py: '🐍', rs: '🦀', go: '🐹', rb: '💎',
  sh: '🐚', bash: '🐚', zsh: '🐚',
  yaml: '⚙️', yml: '⚙️', toml: '⚙️',
  env: '🔒', lock: '🔒',
  sql: '🗄️', graphql: '◈', gql: '◈',
  swift: '🦅', kt: '🟣', java: '☕',
  txt: '📄', csv: '📊', xml: '📰',
  gitignore: '🚫', dockerfile: '🐳',
};

const NAME_ICONS: Record<string, string> = {
  'Dockerfile': '🐳', '.gitignore': '🚫', '.env': '🔒',
  'package.json': '📦', 'tsconfig.json': '🔷', 'Cargo.toml': '🦀',
  'Makefile': '🔧', 'README.md': '📖',
};

export function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return NAME_ICONS[name] || EXT_ICONS[ext] || '📄';
}
