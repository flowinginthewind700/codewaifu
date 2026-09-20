// ============================================================
// Fence info string -> the grammar that should tokenize it.
//
// Agents write ```ts, ```python3, ```sh, ```diff, ```dockerfile and a dozen
// other spellings for the same handful of grammars. highlight.js already
// carries most of those aliases, so this table only holds the spellings it
// does not know; everything else is passed through and checked against
// `registered()` at the render site.
//
// ⛔ Keep this module free of node/electron/react imports — it is unit tested
//    and it is bundled into the renderer.
// ============================================================

/**
 * Spellings highlight.js does not alias on its own, mapped to a grammar that
 * reads them correctly. Deliberately conservative: a wrong grammar paints
 * prose in code colours, which is worse than no colours at all, so anything
 * without a trustworthy match resolves to `null` and renders as plain text.
 */
const ALIASES: Record<string, string> = {
  // Languages, spelled the way people actually type them into a fence.
  htm: 'xml',
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  python3: 'python',
  py3: 'python',
  python2: 'python',
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  tsx: 'typescript',
  jsx: 'javascript',
  dotnet: 'csharp',
  kts: 'kotlin',
  gemfile: 'ruby',
  phtml: 'php',
  pm: 'perl',
  sass: 'scss',
  stylus: 'css',
  gradle: 'java',
  groovy: 'java',

  // Spellings of a grammar the app registers under another name. Leaving these
  // out costs nothing but colour - the block still renders as plain text - yet
  // they are the fences people actually type.
  'objective-c': 'objectivec',
  objc: 'objectivec',
  proto: 'protobuf',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  gql: 'graphql',
  wat: 'wasm',

  // Shell transcripts. `console` is the grammar highlight.js names them with,
  // but every tool spells the fence differently.
  'shell-session': 'console',
  'bash-session': 'console',
  sh: 'bash',
  zsh: 'bash',
  fish: 'bash',

  // Diffs and patches: the single most common fence in an agent reply.
  unified: 'diff',

  // Config files. `properties` is KEY=value (.env, Java), `ini` is [section]
  // (git, toml-ish), and picking the wrong one of the two is visible.
  env: 'properties',
  dotenv: 'properties',
  properties: 'properties',
  conf: 'ini',
  cfg: 'ini',

  // Containers and build files.
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  cmake: 'cmake',

  // Things people fence that are not code: rendering them as plain text is the
  // correct answer, and it is also the cheap one (see codeSpans()).
  txt: 'plaintext',
  text: 'plaintext',
  plain: 'plaintext',
  log: 'plaintext',
  output: 'plaintext',
  consolelog: 'plaintext',
  powershell: 'plaintext',
  ps1: 'plaintext',
  pwsh: 'plaintext',
  bat: 'plaintext',
  cmd: 'plaintext',
  dos: 'plaintext',
  tex: 'plaintext',
  latex: 'plaintext',
  vim: 'plaintext',
  vimscript: 'plaintext'
}

/**
 * Resolve a fence info string to a grammar name, or `null` when there is no
 * grammar worth trusting. The caller still has to check `registered()` — this
 * only normalizes the spelling.
 */
export function resolveLanguage(fence: string | undefined | null): string | null {
  const raw = String(fence ?? '').trim()
  if (!raw) return null
  // ```bash title=example.sh and ```ts {1,3} both appear in the wild; the
  // info string is everything after the marker, so take the first token.
  const first = raw.split(/[\s{]/, 1)[0] || raw
  const key = first.toLowerCase()
  return ALIASES[key] ?? (key || null)
}

/**
 * A grammar that would only produce unstyled text. `plaintext` is registered
 * and tokenizes into nothing, so skipping it saves a pass over every log dump
 * and tree listing an agent prints. Written as a type guard because every
 * caller needs the narrowed string, not a boolean it then has to re-check.
 */
export function isStylableLanguage(language: string | null): language is string {
  return Boolean(language) && language !== 'plaintext' && language !== 'text'
}

/**
 * Every spelling in the table, for the test that checks each one resolves to a
 * grammar the app actually registers. An alias aimed at a name we never
 * registered is invisible at runtime - `codeSpans()` just renders the block
 * plain - so the only place it can fail is here.
 */
export function aliasKeys(): string[] {
  return Object.keys(ALIASES)
}
