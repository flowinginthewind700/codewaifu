/**
 * The bundled Bench, launched for real (known gap #1).
 *
 * Both renderer crashes that shipped were failures of the *bundle*, not of the
 * code the unit tests see: `process.env` present in the dev transform and absent
 * from the built one, and a proposed-API flag that only exists at runtime. jsdom
 * never loads a bundle, and `FaultBoundary` only catches a throw inside React -
 * a document that dies before `createRoot` paints is still a blank frame with a
 * clean main log. So this launches `out/main/index.js` under Electron against a
 * faked herdr socket and asserts that the Bench window paints a tree row.
 *
 * It is deliberately not part of `npm test`: it needs a build, a display and
 * roughly twenty seconds. Run it with `npm run test:e2e`.
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskRecord } from '../../src/shared/pro'
import { PRO_WATCH_HINT, type ProStatePayload } from '../../src/shared/proCli'
import { startFakeHerdr, type FakeHerdr } from './fakeHerdr'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const mainEntry = path.join(root, 'out', 'main', 'index.js')
const artifacts = path.join(here, 'artifacts')
const shotFile = path.join(artifacts, 'bench.png')

const TASK_ID = 'e2e-smoke-task'
const TASK_TITLE = 'e2e smoke task'
/** Long enough for a cold Electron plus a first React mount, short enough to fail. */
const BOOT_TIMEOUT_MS = 45_000

let herdr: FakeHerdr | null = null
let app: ElectronApplication | null = null
let page: Page | null = null
let home = ''
let workdir = ''
/** Uncaught renderer exceptions, from every window, with the window that threw. */
const thrown: string[] = []
/** Console errors: diagnostics only, since a missing font is not a crash. */
const consoleErrors: string[] = []
/**
 * The child's stderr, tailed for diagnostics only.
 *
 * It cannot be an assertion. The stream is only reachable once
 * `electron.launch` has resolved, so it carries the app's own log lines and
 * Chromium's console from that moment on - and nothing from a boot that died
 * before it, which is the one case a tail looks like it should cover. What it
 * is good for is a failure message: "the tree row never appeared" next to
 * `herdr socket connect failed` from main points somewhere, and the same
 * failure next to nothing at all does not.
 */
const stderrTail: string[] = []
let bootError = ''

beforeAll(async () => {
  if (!fs.existsSync(mainEntry)) {
    throw new Error(
      `${mainEntry} is missing. The smoke test drives the built bundle, so run ` +
        '`npx electron-vite build` (or `npm run test:e2e`, which builds first).'
    )
  }

  herdr = await startFakeHerdr()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-home-'))
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-work-'))
  fs.mkdirSync(path.join(home, 'pro'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'config.json'),
    `${JSON.stringify(
      {
        speak: false,
        pro: {
          enabled: true,
          // The Bench is normally opened from the tray; a smoke test has no
          // hands, and clicking a bubble that carries no task is the other door.
          openBenchOnLaunch: true,
          socketPath: herdr.socketPath,
          speakAttention: false
        }
      },
      null,
      2
    )}\n`
  )
  // version 1 is `REGISTRY_VERSION` in src/main/pro/bench.ts. Not imported:
  // that module pulls in electron, and this file runs outside it.
  const now = Date.now()
  fs.writeFileSync(
    path.join(home, 'pro', 'bench.json'),
    `${JSON.stringify({ version: 1, updatedAt: now, tasks: [seedTask(workdir, now)] }, null, 2)}\n`
  )

  // Playwright wants a map with no `undefined` in it, and `process.env` is full
  // of them, so it is copied key by key rather than spread.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.CODEWAIFU_HOME = home
  // Hooks are installed into the agents' homes at launch. Left alone, a smoke
  // run would rewrite the developer's real ~/.codex/hooks.json.
  env.CODEX_HOME = path.join(home, 'codex')
  env.CLAUDE_CONFIG_DIR = path.join(home, 'claude')
  env.ELECTRON_DISABLE_SANDBOX = '1'
  env.CODEWAIFU_E2E = '1'
  // `npm run dev` exports this, and a shell that still has it would point the
  // Bench at a dev server that is not running: a blank frame that means nothing.
  delete env.ELECTRON_RENDERER_URL

  try {
    app = await electron.launch({
      executablePath: require('electron') as string,
      // Its own userData, so the single-instance lock cannot collide with a
      // companion or a dev run that is already up on this machine.
      args: [
        mainEntry,
        `--user-data-dir=${path.join(home, 'userData')}`,
        '--no-sandbox',
        // Puts Chromium's own console into stderrTail, which is diagnostics.
        // The assertion about throwing is `pageerror` after a reload; see below.
        '--enable-logging=stderr'
      ],
      env,
      timeout: BOOT_TIMEOUT_MS
    })
  } catch (error) {
    bootError = String(error)
    throw error
  }

  const stderr = app.process().stderr
  if (stderr) {
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        stderrTail.push(line)
        if (stderrTail.length > 400) stderrTail.shift()
      }
    })
  }

  // Attached before polling for the window, so a throw during the first React
  // mount is not missed. A throw during the bundle's own evaluation still is -
  // that one needs the reload in the case below.
  const watch = (window: Page): void => {
    window.on('pageerror', (error) => thrown.push(`${shortUrl(window.url())}: ${error.message}`))
    window.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(`${shortUrl(window.url())}: ${message.text()}`)
      }
    })
  }
  app.on('window', watch)
  for (const window of app.windows()) watch(window)

  page = await benchWindow(app)
}, BOOT_TIMEOUT_MS * 2)

afterAll(async () => {
  await closeApp(app)
  app = null
  page = null
  await herdr?.close()
  herdr = null
  for (const dir of [home, workdir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('the built Bench', () => {
  it('paints a document rather than a blank frame', async () => {
    expect(page, bootError || 'no Bench window').not.toBeNull()
    // Locator reads rather than `page.evaluate`: this file is typechecked by
    // tsconfig.node.json, which has no DOM lib, and adding one so a test can
    // touch `document` would let main-process code do the same by accident.
    const painted = await page!.locator('#root > *').count()
    expect(painted, await diagnose(page!)).toBeGreaterThan(0)
  })

  it('shows no crash card', async () => {
    const faults = page!.locator('.fault')
    const text = (await faults.count()) > 0 ? ((await faults.first().textContent()) ?? '').trim() : ''
    expect(text, await diagnose(page!)).toBe('')
  })

  it('paints a tree row for the task that was on disk', async () => {
    await page!.locator('.task-row').first().waitFor({ timeout: BOOT_TIMEOUT_MS })
    const names = await page!.locator('.task-row .task-name').allInnerTexts()
    expect(names, await diagnose(page!)).toContain(TASK_TITLE)
  })

  it('is not sitting on the install card, so herdr counted as online', async () => {
    // `install = !proEnabled || !herdrOnline` in Bench.tsx: a tree row and this
    // card are mutually exclusive, and the card is what a socket that never
    // answered would leave on screen.
    expect(await page!.locator('.install-card').count(), await diagnose(page!)).toBe(0)
    const methods = herdr?.methods ?? []
    expect(methods, 'the bundle never reached the fake herdr socket').toContain('session.snapshot')
    expect(methods, 'the event stream never subscribed').toContain('events.subscribe')
  })

  it('evaluates the built bundle without throwing', async () => {
    /*
     * Reload first, and here is why.
     *
     * The listeners below bind once `electron.launch` has resolved, which is
     * after the Bench window exists - so a bundle that throws while it is first
     * being evaluated has already thrown by then, and `pageerror` reports
     * nothing. That is precisely the failure this test exists for: both crashes
     * that shipped were module-evaluation throws in the built document.
     * A reload re-evaluates the same module graph with the listener already
     * bound, and a deferred module script runs before `load` settles, so the
     * exception is delivered into a window that is listening.
     *
     * The paint wait afterwards is a grace period rather than an assertion: a
     * broken bundle leaves `#root` empty, and this test would then report a
     * 45s selector timeout instead of the throw it caught. The paint assertion
     * lives in its own case above.
     */
    await page!.reload({ waitUntil: 'load' })
    await page!
      .locator('#root > *')
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => undefined)
    expect(
      thrown,
      `a throw nothing caught, in the built bundle; console errors:\n${consoleErrors.join('\n')}`
    ).toEqual([])
  })

  it('leaves a screenshot behind, because pixels are otherwise unobtainable here', async () => {
    fs.mkdirSync(artifacts, { recursive: true })
    await page!.screenshot({ path: shotFile })
    expect(fs.statSync(shotFile).size).toBeGreaterThan(10_000)
  })
})

describe('the built CLI', () => {
  /*
   * The same argument as the bundle, one layer out.
   *
   * `tests/proCli.test.ts` calls `runProCli` in-process against a fake relay,
   * so it cannot see a built main that never routes argv to the CLI, an
   * endpoint file another build wrote, or a `fs.writeSync` that lands nowhere.
   * This spawns the packaged entry point the way `~/.local/bin/codewaifu` does
   * after `install.sh`, and reads what a terminal would read.
   */

  /*
   * The window paints from the registry on disk, so "the Bench is up" is not
   * yet "herdr is online", and the bridge is a real socket on a real backoff.
   * Every case below reads a projection that says `offline` until it is - and
   * `pro recovery` then reports "herdr is not running" over its verdict about
   * the task, which is a late answer that reads as a wrong one.
   */
  beforeAll(async () => {
    await waitHerdrOnline()
  }, BOOT_TIMEOUT_MS + 5_000)

  it('prints the tree the window is showing', async () => {
    const run = await builtCli(['pro', 'state'])
    expect(run.code, run.diag).toBe(0)
    expect(run.out).toContain(TASK_TITLE)
    // Whole, because it is what every other verb takes as an argument.
    expect(run.out).toContain(TASK_ID)
  })

  it('prints the recovery tab, so a reboot is visible with no window open', async () => {
    const run = await builtCli(['pro', 'recovery'])
    expect(run.code, run.diag).toBe(0)
    // The seeded task has no pane, no workspace and no session id: intent only,
    // which is the one case the queue cannot see and the terminal has to.
    expect(run.out).toContain('1 task needs recovery')
    expect(run.out).toContain('lost')
    expect(run.out).toContain(TASK_ID)
    // And `pro state` says the same number, or the two verbs disagree about
    // the same projection.
    const state = await builtCli(['pro', 'state'])
    expect(state.out).toContain('1 task needs recovery   # codewaifu pro recovery')
  })

  it('exits 3 rather than hanging when there is no app to talk to', async () => {
    // The code a cron job polls on: "nobody home" is a state, not a fault.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-nohome-'))
    try {
      const run = await builtCli(['pro', 'state'], empty)
      expect(run.code, run.diag).toBe(3)
      expect(run.err).toContain('not running')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('watches until ctrl-c, and exits 0 because a person stopped it', async () => {
    /*
     * The one verb that does not finish, so the signal is part of its contract:
     * `while codewaifu pro watch; do ...; done` needs "I stopped it" (0) to be
     * distinguishable from "it broke" (3). Only a real child process can prove
     * the handler ran - in-process, `process.emit('SIGINT')` would be testing
     * vitest's own signal handling - which is why this case lives here.
     */
    const run = await builtCliWatch(['pro', 'watch'], PRO_WATCH_HINT)
    expect(run.painted, run.diag).toBe(true)
    expect(run.out, run.diag).toContain(TASK_TITLE)
    expect(run.code, run.diag).toBe(0)
    expect(run.err, run.diag).not.toContain('the stream broke')
  })
})

function seedTask(dir: string, now: number): TaskRecord {
  return {
    id: TASK_ID,
    title: TASK_TITLE,
    goal: 'prove the built bundle paints',
    workdir: dir,
    repoRoot: dir,
    branch: 'main',
    agentKind: 'codex',
    agentSessionId: '',
    agentSessionPath: '',
    // No workspace and no panes: a pane would make the bridge spawn a real
    // `herdr terminal session control` against a socket that cannot answer it.
    workspaceId: '',
    paneIds: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    parkedAt: 0
  }
}

interface CliRun {
  code: number
  out: string
  err: string
  /** The whole failure, for the assertion message: an exit code alone is not. */
  diag: string
}

/**
 * Run the built entry point as a terminal would: `electron <repo> pro state`.
 *
 * Its own `CODEWAIFU_HOME` unless the caller says otherwise, so the "nobody
 * home" case can point at a directory with no endpoint file in it.
 */
function builtCli(args: string[], homeOverride?: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron') as string, [root, ...args], {
      env: cliEnv(homeOverride),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: string[] = []
    const err: string[] = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => out.push(chunk))
    child.stderr.on('data', (chunk: string) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = out.join('')
      const stderr = err.join('')
      resolve({
        code: code ?? -1,
        out: stdout,
        err: stderr,
        diag: [
          `exit=${code}`,
          `stdout=${JSON.stringify(stdout.slice(0, 700))}`,
          `stderr=${JSON.stringify(stderr.slice(-400))}`
        ].join(' ')
      })
    })
  })
}

/**
 * Poll `pro state --json` until main's herdr bridge reports itself online.
 *
 * Waiting on the verb the cases assert through is deliberate: a window locator
 * would prove the *renderer* believes it, which is one more projection free to
 * disagree with the one under test. A bridge that never comes up fails here,
 * with the CLI's own diagnostics attached, instead of as a confusing verdict
 * two cases later.
 */
async function waitHerdrOnline(timeoutMs = BOOT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt'
  for (;;) {
    const run = await builtCli(['pro', 'state', '--json'])
    last = run.diag
    if (run.code === 0 && herdrOnlineIn(run.out)) return
    if (Date.now() >= deadline) {
      throw new Error(`herdr never came online for the CLI; last attempt: ${last}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** `--json` prints the relay's payload verbatim, so it is read as one. */
function herdrOnlineIn(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as ProStatePayload).view?.herdr?.online === true
  } catch {
    return false
  }
}

/** The environment a terminal hands the installed launcher. */
function cliEnv(homeOverride?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.CODEWAIFU_HOME = homeOverride ?? home
  env.ELECTRON_DISABLE_SANDBOX = '1'
  env.CODEWAIFU_E2E = '1'
  // `npm run dev` exports this, and a shell that still has it would point the
  // CLI at a dev server that is not running.
  delete env.ELECTRON_RENDERER_URL
  return env
}

interface WatchRun {
  code: number
  out: string
  err: string
  /** True once `marker` reached the terminal, which is when ctrl-c was sent. */
  painted: boolean
  diag: string
}

/**
 * Run a verb that does not finish, and stop it the way a person does.
 *
 * `builtCli` resolves on exit, so it cannot serve `watch`: something has to end
 * the child, and what ends it *is* the assertion. SIGINT goes to the child once
 * `marker` has been printed, and the code that comes back is the one the CLI
 * chose for "a human stopped me". A child that never prints gets SIGKILL at the
 * deadline, so a hung bundle fails as `painted: false` with its own output
 * attached rather than holding the suite open.
 */
function builtCliWatch(args: string[], marker: string, timeoutMs = 30_000): Promise<WatchRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron') as string, [root, ...args], {
      env: cliEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: string[] = []
    const err: string[] = []
    let painted = false
    let gaveUp = false
    const deadline = setTimeout(() => {
      gaveUp = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out.push(chunk)
      if (painted || !out.join('').includes(marker)) return
      painted = true
      child.kill('SIGINT')
    })
    child.stderr.on('data', (chunk: string) => err.push(chunk))
    child.on('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      const stdout = out.join('')
      const stderr = err.join('')
      resolve({
        code: code ?? -1,
        out: stdout,
        err: stderr,
        painted,
        diag: [
          `exit=${code} signal=${signal ?? '-'}${gaveUp ? ' (the marker never arrived)' : ''}`,
          `stdout=${JSON.stringify(stdout.slice(0, 700))}`,
          `stderr=${JSON.stringify(stderr.slice(-400))}`
        ].join(' ')
      })
    })
  })
}

/** The Bench window, by document. The widget is `index.html`; this is `pro.html`. */
async function benchWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  for (;;) {
    for (const window of app.windows()) {
      if (window.url().includes('pro.html')) return window
    }
    if (Date.now() > deadline) {
      const seen = app.windows().map((window) => window.url())
      throw new Error(
        `no Bench window within ${BOOT_TIMEOUT_MS}ms; windows seen: ${seen.join(', ') || 'none'}`
      )
    }
    await sleep(200)
  }
}

/**
 * What is actually on screen, for the assertion message.
 *
 * A red smoke test that says only "selector timed out" sends the next person
 * looking in the wrong place: the useful facts are whether the document is
 * empty, whether it is still booting, whether the crash card is up and what it
 * says, and what the renderer logged on the way there.
 */
async function diagnose(page: Page): Promise<string> {
  try {
    const faults = page.locator('.fault')
    const state = {
      url: page.url(),
      children: await page.locator('#root > *').count(),
      booting: (await page.locator('.boot').count()) > 0,
      fault:
        (await faults.count()) > 0
          ? ((await faults.first().textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 600)
          : '',
      text: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)
    }
    return [
      `url=${state.url}`,
      `rootChildren=${state.children}`,
      `booting=${state.booting}`,
      state.fault ? `fault="${state.fault}"` : '',
      state.text ? `body="${state.text}"` : '',
      thrown.length ? `thrown=${JSON.stringify(thrown)}` : '',
      consoleErrors.length ? `console=${JSON.stringify(consoleErrors.slice(0, 8))}` : '',
      stderrTail.length ? `stderr=${JSON.stringify(stderrTail.slice(-6))}` : ''
    ]
      .filter(Boolean)
      .join(' ')
  } catch (error) {
    return `diagnose failed: ${String(error)}`
  }
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return
  // A tray icon on Linux keeps the app alive after its last window closes, so
  // `close()` is raced against a kill rather than awaited on faith.
  await Promise.race([app.close().catch(() => undefined), sleep(8_000)])
  try {
    const proc = app.process()
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
  } catch {
    // Already gone, which is the wanted outcome.
  }
}

function shortUrl(url: string): string {
  const name = url.split('/').pop() ?? url
  return name || url
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
