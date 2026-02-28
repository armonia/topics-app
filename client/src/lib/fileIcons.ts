// Shared file icon utility — SVG icons via Lucide
// Used by FileExplorer, FilePane, PaneTabBar, EditorTabs

import {
  FileText, FileCode, FileImage, FileVideo, FileAudio,
  FileSpreadsheet, FileArchive, FileLock, FileTerminal, FileCog,
  File, Folder, FolderOpen, Database, Globe, Palette, Coffee,
  Gem, Cog, Package, BookOpen, ShieldOff, Container,
  Braces, Code, Binary, FileKey, ScrollText, FileCheck, Presentation,
  type LucideIcon,
} from 'lucide-react';

// --- Extension → icon + color mapping ---

interface IconDef {
  icon: LucideIcon;
  color: string;
}

const EXT_MAP: Record<string, IconDef> = {
  // Web / JS / TS
  ts:    { icon: FileCode,   color: '#3178c6' },
  tsx:   { icon: FileCode,   color: '#61dafb' },
  js:    { icon: FileCode,   color: '#f7df1e' },
  jsx:   { icon: FileCode,   color: '#61dafb' },
  mjs:   { icon: FileCode,   color: '#f7df1e' },
  cjs:   { icon: FileCode,   color: '#f7df1e' },
  vue:   { icon: FileCode,   color: '#42b883' },
  svelte:{ icon: FileCode,   color: '#ff3e00' },

  // Markup / Docs
  html:  { icon: Globe,      color: '#e44d26' },
  htm:   { icon: Globe,      color: '#e44d26' },
  md:    { icon: FileText,   color: '#519aba' },
  mdx:   { icon: FileText,   color: '#519aba' },
  txt:   { icon: FileText,   color: '#8e8e93' },
  rtf:   { icon: FileText,   color: '#8e8e93' },
  pdf:   { icon: FileText,   color: '#e44d26' },
  doc:   { icon: FileText,   color: '#2b579a' },
  docx:  { icon: FileText,   color: '#2b579a' },

  // Style
  css:   { icon: Palette,    color: '#563d7c' },
  scss:  { icon: Palette,    color: '#cd6799' },
  sass:  { icon: Palette,    color: '#cd6799' },
  less:  { icon: Palette,    color: '#1d365d' },
  styl:  { icon: Palette,    color: '#ff6347' },

  // Data / Config
  json:  { icon: Braces,     color: '#f7df1e' },
  jsonc: { icon: Braces,     color: '#f7df1e' },
  json5: { icon: Braces,     color: '#f7df1e' },
  yaml:  { icon: FileCog,    color: '#cb171e' },
  yml:   { icon: FileCog,    color: '#cb171e' },
  toml:  { icon: FileCog,    color: '#9c4121' },
  ini:   { icon: FileCog,    color: '#8e8e93' },
  xml:   { icon: Code,       color: '#e44d26' },
  csv:   { icon: FileSpreadsheet, color: '#217346' },
  tsv:   { icon: FileSpreadsheet, color: '#217346' },
  xls:   { icon: FileSpreadsheet, color: '#217346' },
  xlsx:  { icon: FileSpreadsheet, color: '#217346' },

  // Images
  png:   { icon: FileImage,  color: '#a074c4' },
  jpg:   { icon: FileImage,  color: '#a074c4' },
  jpeg:  { icon: FileImage,  color: '#a074c4' },
  gif:   { icon: FileImage,  color: '#a074c4' },
  webp:  { icon: FileImage,  color: '#a074c4' },
  svg:   { icon: FileImage,  color: '#ffb13b' },
  ico:   { icon: FileImage,  color: '#a074c4' },
  bmp:   { icon: FileImage,  color: '#a074c4' },
  tiff:  { icon: FileImage,  color: '#a074c4' },
  avif:  { icon: FileImage,  color: '#a074c4' },

  // Audio
  mp3:   { icon: FileAudio,  color: '#e44d26' },
  wav:   { icon: FileAudio,  color: '#e44d26' },
  ogg:   { icon: FileAudio,  color: '#e44d26' },
  flac:  { icon: FileAudio,  color: '#e44d26' },
  aac:   { icon: FileAudio,  color: '#e44d26' },
  m4a:   { icon: FileAudio,  color: '#e44d26' },
  wma:   { icon: FileAudio,  color: '#e44d26' },

  // Video
  mp4:   { icon: FileVideo,  color: '#ff6347' },
  mkv:   { icon: FileVideo,  color: '#ff6347' },
  avi:   { icon: FileVideo,  color: '#ff6347' },
  mov:   { icon: FileVideo,  color: '#ff6347' },
  webm:  { icon: FileVideo,  color: '#ff6347' },
  flv:   { icon: FileVideo,  color: '#ff6347' },
  wmv:   { icon: FileVideo,  color: '#ff6347' },

  // Archives
  zip:   { icon: FileArchive, color: '#f7df1e' },
  tar:   { icon: FileArchive, color: '#f7df1e' },
  gz:    { icon: FileArchive, color: '#f7df1e' },
  bz2:   { icon: FileArchive, color: '#f7df1e' },
  xz:    { icon: FileArchive, color: '#f7df1e' },
  '7z':  { icon: FileArchive, color: '#f7df1e' },
  rar:   { icon: FileArchive, color: '#f7df1e' },

  // Languages
  py:    { icon: FileCode,   color: '#3572a5' },
  rs:    { icon: FileCode,   color: '#dea584' },
  go:    { icon: FileCode,   color: '#00add8' },
  rb:    { icon: Gem,        color: '#cc342d' },
  swift: { icon: FileCode,   color: '#f05138' },
  kt:    { icon: FileCode,   color: '#7f52ff' },
  kts:   { icon: FileCode,   color: '#7f52ff' },
  java:  { icon: Coffee,     color: '#b07219' },
  c:     { icon: FileCode,   color: '#555555' },
  cpp:   { icon: FileCode,   color: '#f34b7d' },
  h:     { icon: FileCode,   color: '#555555' },
  hpp:   { icon: FileCode,   color: '#f34b7d' },
  cs:    { icon: FileCode,   color: '#178600' },
  php:   { icon: FileCode,   color: '#4f5d95' },
  lua:   { icon: FileCode,   color: '#000080' },
  r:     { icon: FileCode,   color: '#198ce7' },
  dart:  { icon: FileCode,   color: '#00b4ab' },
  zig:   { icon: FileCode,   color: '#f7a41d' },
  ex:    { icon: FileCode,   color: '#6e4a7e' },
  exs:   { icon: FileCode,   color: '#6e4a7e' },
  erl:   { icon: FileCode,   color: '#b83998' },
  hs:    { icon: FileCode,   color: '#5e5086' },
  ml:    { icon: FileCode,   color: '#dc6b1e' },
  scala: { icon: FileCode,   color: '#c22d40' },
  clj:   { icon: FileCode,   color: '#db5855' },

  // Shell
  sh:    { icon: FileTerminal, color: '#89e051' },
  bash:  { icon: FileTerminal, color: '#89e051' },
  zsh:   { icon: FileTerminal, color: '#89e051' },
  fish:  { icon: FileTerminal, color: '#89e051' },
  bat:   { icon: FileTerminal, color: '#c1f12e' },
  ps1:   { icon: FileTerminal, color: '#012456' },
  cmd:   { icon: FileTerminal, color: '#c1f12e' },

  // Database / Query
  sql:   { icon: Database,   color: '#e38c00' },
  graphql: { icon: Code,     color: '#e535ab' },
  gql:   { icon: Code,       color: '#e535ab' },
  prisma:{ icon: Database,   color: '#2d3748' },

  // Env / Secrets
  env:   { icon: FileLock,   color: '#ecd53f' },
  pem:   { icon: FileKey,    color: '#cb171e' },
  key:   { icon: FileKey,    color: '#cb171e' },
  cert:  { icon: FileKey,    color: '#cb171e' },

  // Lock files
  lock:  { icon: FileLock,   color: '#8e8e93' },

  // Presentation
  ppt:   { icon: Presentation, color: '#d24726' },
  pptx:  { icon: Presentation, color: '#d24726' },

  // Binary / Executables
  wasm:  { icon: Binary,     color: '#654ff0' },
  exe:   { icon: Binary,     color: '#8e8e93' },
  dll:   { icon: Binary,     color: '#8e8e93' },
  so:    { icon: Binary,     color: '#8e8e93' },
  dylib: { icon: Binary,     color: '#8e8e93' },

  // Misc
  log:   { icon: ScrollText, color: '#8e8e93' },
  diff:  { icon: FileCheck,  color: '#41b883' },
  patch: { icon: FileCheck,  color: '#41b883' },
};

// --- Special filenames ---

const NAME_MAP: Record<string, IconDef> = {
  'Dockerfile':     { icon: Container,    color: '#2496ed' },
  'docker-compose.yml': { icon: Container, color: '#2496ed' },
  'docker-compose.yaml': { icon: Container, color: '#2496ed' },
  '.dockerignore':  { icon: Container,    color: '#2496ed' },
  '.gitignore':     { icon: ShieldOff,    color: '#f05033' },
  '.gitmodules':    { icon: ShieldOff,    color: '#f05033' },
  '.gitattributes': { icon: ShieldOff,    color: '#f05033' },
  '.env':           { icon: FileLock,     color: '#ecd53f' },
  '.env.local':     { icon: FileLock,     color: '#ecd53f' },
  '.env.example':   { icon: FileLock,     color: '#ecd53f' },
  'package.json':   { icon: Package,      color: '#cb3837' },
  'package-lock.json': { icon: FileLock,  color: '#cb3837' },
  'bun.lockb':      { icon: FileLock,     color: '#fbf0df' },
  'yarn.lock':      { icon: FileLock,     color: '#2c8ebb' },
  'pnpm-lock.yaml': { icon: FileLock,     color: '#f69220' },
  'tsconfig.json':  { icon: FileCog,      color: '#3178c6' },
  'Cargo.toml':     { icon: Package,      color: '#dea584' },
  'Cargo.lock':     { icon: FileLock,     color: '#dea584' },
  'Gemfile':        { icon: Gem,          color: '#cc342d' },
  'Gemfile.lock':   { icon: FileLock,     color: '#cc342d' },
  'Makefile':       { icon: Cog,          color: '#8e8e93' },
  'CMakeLists.txt': { icon: Cog,          color: '#8e8e93' },
  'README.md':      { icon: BookOpen,     color: '#519aba' },
  'LICENSE':        { icon: ScrollText,   color: '#d4aa00' },
  'LICENSE.md':     { icon: ScrollText,   color: '#d4aa00' },
  'CHANGELOG.md':   { icon: ScrollText,   color: '#519aba' },
  'CLAUDE.md':      { icon: BookOpen,     color: '#d97706' },
};

// --- Default fallback ---

const DEFAULT_ICON: IconDef = { icon: File, color: '#8e8e93' };
const FOLDER_ICON: IconDef = { icon: Folder, color: '#8e8e93' };
const FOLDER_OPEN_ICON: IconDef = { icon: FolderOpen, color: '#dcb67a' };

// --- Public API ---

export type { IconDef };

export function getFileIconDef(name: string, isDirectory = false, isOpen = false): IconDef {
  if (isDirectory) return isOpen ? FOLDER_OPEN_ICON : FOLDER_ICON;
  if (NAME_MAP[name]) return NAME_MAP[name];
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXT_MAP[ext] || DEFAULT_ICON;
}

/** Legacy compat — returns the Lucide icon component */
export function getFileIcon(name: string): LucideIcon {
  return getFileIconDef(name).icon;
}

/** Get the color for a file */
export function getFileIconColor(name: string): string {
  return getFileIconDef(name).color;
}
