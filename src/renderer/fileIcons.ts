// File-tree icon colours, in the IntelliJ spirit: the shape tells you file
// vs folder, the colour tells you *what kind* at a glance, so scanning a
// long tree is a colour-matching task rather than a reading task.
//
// Colours are the language's own brand colour where it has one (TypeScript
// blue, Go cyan, Rust rust), which is what makes them learnable without a
// legend. They're literal hex rather than theme vars on purpose — a
// language's identity shouldn't flip with the app theme — but each one is
// picked to clear ~3:1 against both the light (#f7f7f9) and dark (#17171b)
// surfaces, so nothing washes out in either mode.

/// Fallback for anything unmapped: the same muted ink the tree text uses,
/// so unknown types recede instead of shouting in a default colour.
export const DEFAULT_FILE_COLOR = 'var(--c-ink-faint)';

const BY_EXTENSION: Record<string, string> = {
  // Web / JS family
  ts: '#3178c6',
  mts: '#3178c6',
  cts: '#3178c6',
  tsx: '#4dabf7',
  js: '#d6b60c',
  mjs: '#d6b60c',
  cjs: '#d6b60c',
  jsx: '#e8c547',
  vue: '#41b883',
  svelte: '#ff5c26',
  html: '#e34c26',
  htm: '#e34c26',
  css: '#4a8df8',
  scss: '#cf649a',
  sass: '#cf649a',
  less: '#4a76b8',

  // Data / config
  json: '#b3a838',
  jsonc: '#b3a838',
  yml: '#e37933',
  yaml: '#e37933',
  toml: '#9c8b73',
  ini: '#9c8b73',
  cfg: '#9c8b73',
  conf: '#9c8b73',
  env: '#c9a227',
  properties: '#9c8b73',
  xml: '#e07b53',
  sql: '#e38c00',
  csv: '#4caf82',
  tsv: '#4caf82',

  // Languages
  py: '#4b8bbe',
  pyi: '#4b8bbe',
  rb: '#d0483c',
  rake: '#d0483c',
  go: '#00a8c6',
  rs: '#d08b60',
  java: '#e07b19',
  kt: '#a97bff',
  kts: '#a97bff',
  scala: '#dc322f',
  swift: '#f05138',
  php: '#8b8fd4',
  cs: '#a05fbd',
  c: '#6295cb',
  h: '#6295cb',
  cc: '#e05a86',
  cpp: '#e05a86',
  cxx: '#e05a86',
  hh: '#e05a86',
  hpp: '#e05a86',
  hxx: '#e05a86',
  dart: '#39b6f0',
  ex: '#a883c7',
  exs: '#a883c7',
  lua: '#4b7bd6',
  r: '#4b8bbe',
  pl: '#5aa9c9',
  sh: '#5aae3c',
  bash: '#5aae3c',
  zsh: '#5aae3c',
  fish: '#5aae3c',
  ps1: '#4a8df8',

  // Docs / text
  md: '#8f96a3',
  markdown: '#8f96a3',
  mdx: '#8f96a3',
  txt: '#8f96a3',
  rst: '#8f96a3',
  pdf: '#d1453b',
  doc: '#3d6eb5',
  docx: '#3d6eb5',
  xls: '#3f8f4f',
  xlsx: '#3f8f4f',
  ppt: '#d1592f',
  pptx: '#d1592f',

  // Assets
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  webp: '#a074c4',
  bmp: '#a074c4',
  ico: '#a074c4',
  svg: '#c58fd8',
  woff: '#8a8f98',
  woff2: '#8a8f98',
  ttf: '#8a8f98',
  otf: '#8a8f98',

  // Archives / binaries — deliberately drab; these are the rows you want
  // your eye to skip.
  zip: '#8a8f98',
  gz: '#8a8f98',
  tar: '#8a8f98',
  tgz: '#8a8f98',
  bz2: '#8a8f98',
  xz: '#8a8f98',
  '7z': '#8a8f98',
  rar: '#8a8f98',
  jar: '#8a8f98',
  exe: '#8a8f98',
  dmg: '#8a8f98',
  bin: '#8a8f98',
  wasm: '#7a5cc4',
};

/// Whole-name matches, checked before the extension. These are the files
/// you look for by name, not by type.
const BY_NAME: Record<string, string> = {
  'package.json': '#8bc34a',
  'package-lock.json': '#6b7280',
  'tsconfig.json': '#3178c6',
  dockerfile: '#2496ed',
  'docker-compose.yml': '#2496ed',
  'docker-compose.yaml': '#2496ed',
  makefile: '#c9a227',
  '.gitignore': '#e8734a',
  '.gitattributes': '#e8734a',
  '.npmrc': '#cb3837',
  'license': '#c9a227',
  'license.md': '#c9a227',
  'readme.md': '#5aa9c9',
  'changelog.md': '#5aa9c9',
  'claude.md': '#d97757',
  'agents.md': '#d97757',
};

/// Folder tints. Only folders with a recognised *role* get colour; the rest
/// stay neutral, which is what makes `src` and `test` findable in a tree of
/// forty directories.
const BY_FOLDER: Record<string, string> = {
  src: '#4a8df8',
  lib: '#4a8df8',
  app: '#4a8df8',
  main: '#4a8df8',
  renderer: '#4a8df8',
  preload: '#4a8df8',
  shared: '#4a8df8',
  components: '#4dabf7',
  test: '#5aae3c',
  tests: '#5aae3c',
  __tests__: '#5aae3c',
  spec: '#5aae3c',
  e2e: '#5aae3c',
  docs: '#8f96a3',
  doc: '#8f96a3',
  assets: '#a074c4',
  static: '#a074c4',
  public: '#a074c4',
  images: '#a074c4',
  resources: '#a074c4',
  config: '#e37933',
  scripts: '#c9a227',
  bin: '#c9a227',
  build: '#8a8f98',
  dist: '#8a8f98',
  out: '#8a8f98',
  target: '#8a8f98',
  coverage: '#8a8f98',
  node_modules: '#6b7280',
  vendor: '#6b7280',
  '.git': '#6b7280',
  '.github': '#6b7280',
  '.idea': '#6b7280',
  '.vscode': '#6b7280',
};

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes('.') ? lower.split('.').pop() ?? '' : '';
}

export function fileIconColor(name: string): string {
  const lower = name.toLowerCase();
  return BY_NAME[lower] ?? BY_EXTENSION[extensionOf(lower)] ?? DEFAULT_FILE_COLOR;
}

/// Neutral (`null`) for folders with no recognised role, so the caller can
/// fall back to the tree's own ink colour rather than tinting everything.
export function folderIconColor(name: string): string | null {
  return BY_FOLDER[name.toLowerCase()] ?? null;
}

/// Test and spec files get a marker of their own, the way IntelliJ badges
/// them — `foo.test.ts` sitting next to `foo.ts` is otherwise a same-colour
/// near-identical row.
export function isTestFileName(name: string): boolean {
  return /\.(test|spec)\.[a-z0-9]+$/i.test(name) || /^test_.*\.py$/i.test(name);
}
