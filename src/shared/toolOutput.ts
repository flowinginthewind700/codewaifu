// ============================================================
// A tool row's result -> which part of it is code, and which code.
//
// The terminal history both readers show is almost entirely tool rows. Measured
// over 40 real Codex rollouts (11,513 tool rows, 17.1 MB of output) there were
// *zero* fenced code blocks in agent prose, so colouring fences - and only
// fences - coloured nothing a human actually reads: every `cat src/app.ts` came
// back grey while the same file is coloured in the editor next door.
//
// Two rules pick a grammar, in order, and both are provenance rather than
// guesswork:
//
// 1. The command that produced the output named the file it printed. `cat
//    src/app.ts` is TypeScript because the agent said so. This counts only for
//    readers whose stdout *is* the file's bytes (cat/head/tail/less/more/bat);
//    anything that rewrites, prefixes, counts or filters lines is rejected, so
//    `nl -ba` line numbers can never be painted as if they were source.
// 2. The output's own shape, but only when a parser agrees: `JSON.parse`
//    succeeds, or the body is a diff. Never `highlightAuto()` - see highlight.tsx
//    for why auto-detection is worse than no colour.
//
// Everything else stays plain, which is what it looked like before and beats
// prose wearing code colours.
//
// ⛔ Keep this module free of node/electron/react imports - it is unit tested
//    and it is bundled into the renderer.
// ============================================================

/**
 * Readers whose stdout is the file's own bytes. They may truncate it, never
 * rewrite it, so what they print is genuinely the file's source.
 */
const READER_COMMANDS = new Set(['cat', 'bat', 'head', 'tail', 'less', 'more'])

/**
 * `sed`/`gsed`, which is a reader only in one narrow shape: `-n` with a script
 * made purely of numeric line-range prints (`sed -n '905,1010p' app.py`). That
 * emits the file's own lines verbatim, exactly like `head`/`tail`, and it is how
 * most of this app's own transcripts read source - 1.7M characters of it across
 * 40 rollouts, all of which rendered grey while every `cat` next to it was
 * coloured. Every other `sed` rewrites, injects or deletes bytes, so it is
 * handled by `sedPrintsFile()` rather than being trusted on the command word.
 */
const SED_COMMANDS = new Set(['sed', 'gsed'])

/**
 * A single `sed` print of whole lines, addressed by number or by `$` (the last
 * line): `5p`, `1,40p`, `1,$p`, `$p`. An address that is a regex (`/export/p`)
 * or a step (`1~2p`) selects lines by content, which is a different question and
 * is left alone.
 */
const SED_PRINT_RANGE = /^(?:\$|\d+)(?:,(?:\$|\d+))?p$/

/** Leading words that emit nothing themselves, so they cannot corrupt stdout. */
const PASSTHROUGH_COMMANDS = new Set(['cd', 'pushd', 'popd'])

/** Wrappers that hand the rest of the line to the real command. */
const COMMAND_WRAPPERS = new Set(['sudo', 'command', 'nice', 'nohup', 'time'])

/**
 * Words that rewrite, prefix, count or filter what they print. One anywhere in
 * the command disqualifies the whole thing: a confidently wrong colour is worse
 * than none, and `grep`/`nl` output is *shaped* like the source it came from
 * without *being* it.
 */
const TRANSFORMING =
  /\b(?:rg|grep|egrep|fgrep|ack|ag|nl|awk|gawk|mawk|cut|tr|wc|sort|uniq|column|od|xxd|hexdump|strings|jq|yq|diff|patch|base64|md5sum|sha1sum|sha256sum|file|stat|du|tree|tac|rev|paste|expand|unexpand|comm|fold)\b/

/**
 * A stdout redirect, which sends the file's bytes somewhere other than the
 * output we are about to colour. `2>/dev/null` and `2>&1` are stderr and stay
 * allowed: they are in most of the real commands and change nothing printed.
 */
const STDOUT_REDIRECT = /(?:^|[\s;|&(])>{1,2}(?!&)/

/**
 * Path extension -> grammar. Only spellings with one reading: `.h` is C by
 * convention here, `.md` is markdown, and anything absent renders plain rather
 * than being guessed at. `tests/highlightTheme.test.tsx` requires every value
 * to be a grammar the app actually registers, so a typo cannot silently drop
 * colours.
 */
const EXTENSION_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  java: 'java',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  php: 'php',
  r: 'r',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  xsl: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  env: 'properties',
  proto: 'protobuf',
  cmake: 'cmake',
  make: 'makefile',
  mk: 'makefile'
}

/** Extensionless filenames that still declare their own language. */
const BASENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby'
}

/** Tools whose arguments carry a shell command in `cmd`/`command`/`script`. */
const SHELL_TOOLS = new Set([
  'exec_command',
  'exec',
  'shell',
  'local_shell',
  'bash',
  'sh',
  'command',
  'run_command',
  'run_terminal_command',
  'terminal',
  'container.exec'
])

/** Every extension in the table, for the test that checks each is registered. */
export function extensionLanguageKeys(): string[] {
  return Object.keys(EXTENSION_LANG)
}

/** Every grammar the tables can name, for the same test. */
export function extensionLanguageValues(): string[] {
  return [...new Set([...Object.values(EXTENSION_LANG), ...Object.values(BASENAME_LANG)])]
}

function normalizeTool(tool: string | null | undefined): string {
  const raw = String(tool ?? '').trim().toLowerCase()
  // Codex spells custom tools with a `_call` suffix (`local_shell_call`).
  return raw.replace(/_call$/, '')
}

/** Whether this tool's arguments hold a shell command worth reading. */
export function isShellTool(tool: string | null | undefined): boolean {
  return SHELL_TOOLS.has(normalizeTool(tool))
}

/**
 * The command word of one pipeline segment, past `VAR=value` assignments and
 * the wrappers that just re-exec what follows them. `/usr/bin/cat` counts as
 * `cat`: a path is where the binary lives, not a different binary.
 */
function firstWord(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_]\w*=/.test(token) || COMMAND_WRAPPERS.has(token)) {
      index++
      continue
    }
    break
  }
  const token = tokens[index]
  if (!token) return ''
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Whether one `sed` segment prints the named file's own lines verbatim, and so
 * may vouch for its language the way `head` does.
 *
 * Only `-n` (suppress the default print) with a script that is nothing but
 * numeric line-range `p` commands qualifies. Everything that would make the
 * bytes on screen differ from the file is rejected: in-place `-i`, a script read
 * from `-f`, a second `-e`, a substitution/insert/delete, or a regex address
 * (`/foo/p`, whose body this cannot parse safely). The asymmetry is deliberate -
 * a false negative costs one grey block, a false positive paints transformed
 * text as source, and a confidently wrong colour is the one outcome this module
 * exists to avoid.
 */
function sedPrintsFile(segment: string): boolean {
  // Only flag-shaped tokens (a leading `-`) are inspected, so a filename or the
  // quoted script can never be mistaken for a flag.
  const flags = (segment.match(/(?:^|\s)-{1,2}[A-Za-z-]+/g) ?? []).join(' ')
  if (/--in-place|(?:^|\s)-[A-Za-z]*i/.test(flags)) return false
  if (/(?:^|\s)-[A-Za-z]*e|--expression/.test(flags)) return false
  if (/(?:^|\s)-[A-Za-z]*f|--file/.test(flags)) return false
  // `-n` is what makes the output only the lines the script prints; without it
  // sed echoes every line and re-prints the range, which is not the file.
  if (!/(?:^|\s)-[A-Za-z]*n|--quiet/.test(flags)) return false

  const quoted = segment.match(/(['"])((?:\\.|(?!\1)[^\\])*)\1/)
  const script = quoted
    ? quoted[2]
    // `gsed` is GNU sed under Homebrew's name; `\bsed` would miss it because
    // there is no word boundary inside the word.
    : (segment.match(/(?:^|[\s;|&(])g?sed\s+(?:-[A-Za-z]+\s+)*(\S+)/)?.[1] ?? '')
  if (!script) return false
  const commands = script
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  return commands.length > 0 && commands.every((command) => SED_PRINT_RANGE.test(command))
}

/**
 * The single language a command's stdout is written in, or `null`.
 *
 * Every pipeline segment has to be a reader (or a `cd`), and exactly one
 * extension has to be in play. `cat a.ts && node b.js` is therefore `null`:
 * its output is a file followed by a program's logs, and no one grammar is
 * true of both halves.
 */
export function commandLanguage(command: string | null | undefined): string | null {
  const cmd = String(command ?? '').trim()
  if (!cmd) return null
  if (TRANSFORMING.test(cmd)) return null
  if (STDOUT_REDIRECT.test(cmd)) return null

  const segments = cmd
    .split(/&&|\|\||[|;]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length === 0) return null

  let sawReader = false
  for (const segment of segments) {
    const word = firstWord(segment)
    if (READER_COMMANDS.has(word)) {
      sawReader = true
      continue
    }
    if (SED_COMMANDS.has(word)) {
      if (!sedPrintsFile(segment)) return null
      sawReader = true
      continue
    }
    if (PASSTHROUGH_COMMANDS.has(word)) continue
    return null
  }
  if (!sawReader) return null
  return pathLanguage(cmd)
}

/**
 * The one language named by the paths in a string, or `null` when zero or
 * several are named. Requiring exactly one is what keeps `cat a.ts b.py` from
 * being painted as either.
 */
export function pathLanguage(text: string | null | undefined): string | null {
  const source = String(text ?? '')
  if (!source) return null
  const languages = new Set<string>()
  for (const match of source.match(/[\w./@+~-]*\.\w{1,9}\b/g) ?? []) {
    const extension = match.slice(match.lastIndexOf('.') + 1).toLowerCase()
    const language = EXTENSION_LANG[extension]
    if (language) languages.add(language)
  }
  for (const match of source.match(/\b[A-Za-z][\w.-]*\b/g) ?? []) {
    const language = BASENAME_LANG[match.toLowerCase()]
    if (language) languages.add(language)
  }
  if (languages.size !== 1) return null
  return [...languages][0]
}

/**
 * The grammar for a shell tool's command, or `null`. Non-shell tools get `null`
 * rather than a guess: an `apply_patch` result is a confirmation line, and a
 * `view_image` result is binary, neither of which is code.
 */
export function commandToolLanguage(
  tool: string | null | undefined,
  command: string | null | undefined
): string | null {
  if (!isShellTool(tool)) return null
  return commandLanguage(command)
}

/** The line the harness prints before a command's own stdout. */
const OUTPUT_MARKER = /^Output:[ \t]*$/m

export interface ToolOutputParts {
  /** The harness wrapper (`Chunk ID:`, `Wall time:`, exit code, `Output:`). */
  head: string
  /** What the command itself printed. */
  body: string
}

/**
 * Split a tool result into the wrapper this app's own harness prints and the
 * bytes the command produced.
 *
 * Colouring the whole thing would paint `Chunk ID: 4ae44c` as if it were
 * TypeScript, so the wrapper is kept as its own plain run. When there is no
 * marker - an error message, or an agent whose harness prints differently - the
 * whole text is the body and nothing is lost.
 */
export function splitToolOutput(raw: string | null | undefined): ToolOutputParts {
  const source = String(raw ?? '')
  const match = OUTPUT_MARKER.exec(source)
  if (!match) return { head: '', body: source }
  const at = match.index + match[0].length
  return {
    head: source.slice(0, at).replace(/\n$/, ''),
    body: source.slice(at).replace(/^\n/, '')
  }
}

/** A body `JSON.parse` accepts. Only the parser gets to decide this. */
export function looksLikeJson(body: string): boolean {
  const text = body.trim()
  if (!text) return false
  const first = text.charAt(0)
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * A body that is a diff or a `git show`.
 *
 * Both the first line and a diff line inside it have to qualify: a log that
 * happens to mention `@@` mid-paragraph is not a patch, and calling it one
 * paints ordinary text green and red.
 */
export function looksLikeDiff(body: string): boolean {
  const text = body.trimStart()
  if (!text) return false
  const newline = text.indexOf('\n')
  const first = newline < 0 ? text : text.slice(0, newline)
  const startsLikeDiff =
    /^diff --git /.test(first) ||
    /^--- /.test(first) ||
    /^\+\+\+ /.test(first) ||
    /^@@ /.test(first) ||
    /^commit [0-9a-f]{7,40}\s*$/.test(first)
  if (!startsLikeDiff) return false
  return /^diff --git |^@@ |^--- |^\+\+\+ /m.test(text)
}

/** The grammar an output's own shape proves, ignoring where it came from. */
export function shapeLanguage(raw: string | null | undefined): string | null {
  const { body } = splitToolOutput(raw)
  const text = body.trim()
  if (!text) return null
  if (looksLikeJson(text)) return 'json'
  if (looksLikeDiff(text)) return 'diff'
  return null
}

/**
 * The grammar for one tool row's output, or `null` for "render it plain".
 *
 * Provenance wins over shape: the command that printed a file is a better
 * witness than the file's first line, and a `.json` fixture printed by `cat
 * notes.md` should still read as the markdown the agent asked for.
 */
export function outputLanguage(input: {
  tool?: string | null
  command?: string | null
  output?: string | null
}): string | null {
  const fromCommand = commandToolLanguage(input.tool, input.command)
  if (fromCommand) return fromCommand
  return shapeLanguage(input.output)
}
