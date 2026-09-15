#!/usr/bin/env node
/**
 * Acceptance 6.5 with the human replaced by a clock.
 *
 * Twenty tasks over four repos, every pane shouting, the selection moved by
 * keyboard only, and the RSS of every process in the app's subtree sampled for
 * an hour. The criterion is "memory stays flat through an hour of busy output",
 * and an hour is not a unit a test runner should own - so this is a script with
 * four verbs, and a killed run still leaves its evidence on disk:
 *
 *   node scripts/soak-bench.mjs setup     herdr session, repos, panes, seeded home
 *   node scripts/soak-bench.mjs run       launch the built app, cycle, sample
 *   node scripts/soak-bench.mjs report    slope and peak from the JSONL
 *   node scripts/soak-bench.mjs teardown  close panes, stop the session, rm temps
 *
 * It drives a real herdr named session (`cwsoak`) rather than the fake socket the
 * e2e smoke uses, because the question is about the terminal bridge and xterm's
 * buffers under real frame traffic; a fake that never sends a frame would answer
 * a different question. Sampling reads /proc, so this harness is Linux-only -
 * which matches the platform Pro has actually been verified on.
 *
 * Knobs, all optional: SOAK_SESSION, SOAK_STATE, SOAK_OUT, SOAK_MINUTES,
 * SOAK_CYCLE_S, SOAK_SAMPLE_S, SOAK_LINES_S, HERDR_BIN.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERDR = process.env.HERDR_BIN || path.join(os.homedir(), '.local/bin/herdr')
const SESSION = process.env.SOAK_SESSION || 'cwsoak'
const STATE_FILE = process.env.SOAK_STATE || '/tmp/cw-soak-state.json'
const OUT_FILE = process.env.SOAK_OUT || '/tmp/cw-soak-rss.jsonl'
const MINUTES = Number(process.env.SOAK_MINUTES || 60)
const CYCLE_S = Number(process.env.SOAK_CYCLE_S || 45)
const SAMPLE_S = Number(process.env.SOAK_SAMPLE_S || 20)
/** Lines per second per pane: 20 panes at 10/s is 200 lines/s of real traffic. */
const LINES_S = Number(process.env.SOAK_LINES_S || 10)
const TASK_COUNT = 20
const REPO_COUNT = 4
const PAGE_KB = pageSizeKb()

function pageSizeKb() {
  const res = spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8' })
  const bytes = Number(String(res.stdout || '').trim())
  return (Number.isFinite(bytes) && bytes > 0 ? bytes : 4096) / 1024
}

function fail(message) {
  process.stderr.write(`soak: ${message}\n`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * herdr's CLI prints NDJSON when it has no terminal, which is exactly this case.
 * `session list` is the exception - it prints a human table either way - so
 * nothing here calls it.
 *
 * `pane run` is the exception worth knowing about: it prints nothing, and it
 * *types* its arguments into the pane's shell joined by spaces, so quoting does
 * not survive the trip. Every command this harness runs is therefore one token
 * pointing at a script file on disk.
 */
function herdrJson(args) {
  const res = spawnSync(HERDR, args, {
    env: { ...process.env, HERDR_SESSION: SESSION },
    encoding: 'utf8'
  })
  if (res.status !== 0) {
    fail(`herdr ${args.join(' ')} exited ${res.status}: ${res.stderr || res.stdout}`)
  }
  const line = res.stdout.trim().split('\n').filter(Boolean).pop()
  if (!line) return null
  const parsed = JSON.parse(line)
  if (parsed.error) fail(`herdr ${args.join(' ')}: ${JSON.stringify(parsed.error)}`)
  return parsed.result
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    fail(`${STATE_FILE} is missing; run \`node scripts/soak-bench.mjs setup\` first`)
  }
}

/**
 * `pane read` answers with the terminal's own text, not with a JSON envelope, so
 * it cannot share herdrJson: the last line of a busy pane is whatever the pane
 * last printed, and parsing that is how a harness ends up reporting a SyntaxError
 * as if the terminal were broken.
 */
function herdrText(args) {
  const res = spawnSync(HERDR, args, {
    env: { ...process.env, HERDR_SESSION: SESSION },
    encoding: 'utf8'
  })
  if (res.status !== 0) {
    fail(`herdr ${args.join(' ')} exited ${res.status}: ${res.stderr || res.stdout}`)
  }
  return res.stdout
}

/** Close leftovers from a setup that died halfway, so a rerun starts clean. */
function closeStale(prefix) {
  const list = herdrJson(['workspace', 'list']).workspaces
  for (const workspace of list) {
    if (!String(workspace.label || '').startsWith(prefix)) continue
    herdrJson(['workspace', 'close', workspace.workspace_id])
  }
}

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */

function repoAt(dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  const git = (args) => {
    const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    if (res.status !== 0) fail(`git ${args.join(' ')} in ${dir}: ${res.stderr}`)
  }
  git(['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nsoak fixture\n`)
  git(['add', '.'])
  git(['-c', 'user.email=soak@local', '-c', 'user.name=soak', 'commit', '-q', '-m', `${name} seed`])
  return dir
}

/** Synchronous wait: setup has nothing to interleave with. */
function pause(ms) {
  spawnSync('sleep', [String(ms / 1000)])
}

/**
 * The session server outlives its TUI client (`herdr session stop` is a verb of
 * its own), so a pty is only needed long enough to boot it.
 */
function ensureSession() {
  // Not `session list`: that verb prints a human table, and every other verb here
  // prints NDJSON, so it is the one command in this file that cannot be parsed.
  // A `pane list` that answers *is* the proof the server is up, and it is the
  // same socket the run will use.
  const running = () =>
    spawnSync(HERDR, ['pane', 'list'], {
      env: { ...process.env, HERDR_SESSION: SESSION },
      encoding: 'utf8'
    }).status === 0
  if (!running()) {
    const client = spawn('script', ['-qec', `env HERDR_SESSION=${SESSION} ${HERDR}`, '/dev/null'], {
      detached: true,
      stdio: 'ignore'
    })
    client.unref()
    const deadline = Date.now() + 30_000
    while (!running()) {
      if (Date.now() > deadline) fail(`session ${SESSION} never came up`)
      pause(500)
    }
    // Kill the pty wrapper, not the server. The bracket keeps this pattern from
    // matching the harness's own command line, which pkill would kill too.
    spawnSync('pkill', ['-f', `script.*HERDR_SESSION=${SESSION.slice(0, -1)}[${SESSION.slice(-1)}]`])
    pause(1500)
  }
  const socket = path.join(os.homedir(), '.config/herdr/sessions', SESSION, 'herdr.sock')
  if (!fs.existsSync(socket)) fail(`session ${SESSION} is running but has no socket at ${socket}`)
  return socket
}

/**
 * Type the busy loop into a pane and prove it took.
 *
 * A pane created a moment ago may not have a prompt yet, and text typed into
 * nothing is silently lost - which would leave a quiet pane in an hour that is
 * supposed to be busy, and a flat memory curve that proves nothing.
 */
function startBusy(paneId, script) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    herdrJson(['pane', 'run', paneId, 'bash', script])
    pause(2500)
    if (herdrText(['pane', 'read', paneId]).includes('soak ')) return
  }
  fail(`pane ${paneId} never started shouting; \`herdr pane read ${paneId}\` is the next stop`)
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-soak-'))
  const socket = ensureSession()
  closeStale('soak-')
  const busy = path.join(base, 'busy.sh')
  fs.writeFileSync(
    busy,
    [
      '#!/usr/bin/env bash',
      '# On disk rather than typed inline: `herdr pane run` joins its arguments',
      '# with spaces, so a quoted loop arrives as broken tokens.',
      'i=0',
      'while :; do',
      '  printf "soak %s %s %s\\n" "$i" "$(date +%s)" "012345678901234567890123456789012345678901234567890123456789012345678901"',
      '  i=$((i+1))',
      `  sleep ${1 / LINES_S}`,
      'done',
      ''
    ].join('\n')
  )

  const workspaces = []
  const panes = []
  for (let w = 0; w < REPO_COUNT; w += 1) {
    const repo = repoAt(path.join(base, `repo-${w}`), `repo-${w}`)
    const created = herdrJson([
      'workspace',
      'create',
      '--cwd',
      repo,
      '--label',
      `soak-${w}`,
      '--no-focus'
    ])
    const workspaceId = created.workspace.workspace_id
    const mine = () =>
      herdrJson(['pane', 'list']).panes.filter((pane) => pane.workspace_id === workspaceId)
    let list = mine()
    // Split the seed pane into a grid, alternating axes so herdr's layout code
    // is exercised too.
    while (list.length < TASK_COUNT / REPO_COUNT) {
      const anchor = list[list.length - 1]
      herdrJson([
        'pane',
        'split',
        '--pane',
        anchor.pane_id,
        '--direction',
        list.length % 2 === 1 ? 'right' : 'down'
      ])
      list = mine()
    }
    for (const pane of list) {
      startBusy(pane.pane_id, busy)
      panes.push({ id: pane.pane_id, workspaceId })
    }
    workspaces.push({ id: workspaceId, repo })
  }

  const home = path.join(base, 'home')
  fs.mkdirSync(path.join(home, 'pro'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'config.json'),
    `${JSON.stringify(
      {
        speak: false,
        // 0 = automatic: the installed companion on this box owns the default
        // port and its endpoint.env, and this run must not argue with either.
        port: 0,
        pro: { enabled: true, openBenchOnLaunch: true, socketPath: socket, speakAttention: false }
      },
      null,
      2
    )}\n`
  )
  const now = Date.now()
  const tasks = panes.map((pane, i) => ({
    id: `soak-task-${String(i + 1).padStart(2, '0')}`,
    title: `soak task ${i + 1}`,
    goal: 'keep a pane shouting for an hour',
    workdir: workspaces[i % workspaces.length].repo,
    repoRoot: workspaces[i % workspaces.length].repo,
    branch: 'main',
    agentKind: i % 2 === 0 ? 'codex' : 'claude',
    agentSessionId: '',
    agentSessionPath: '',
    workspaceId: pane.workspaceId,
    paneIds: [pane.id],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    parkedAt: 0
  }))
  fs.writeFileSync(
    path.join(home, 'pro', 'bench.json'),
    `${JSON.stringify({ version: 1, updatedAt: now, tasks }, null, 2)}\n`
  )

  fs.writeFileSync(
    STATE_FILE,
    `${JSON.stringify(
      {
        base,
        home,
        socket,
        session: SESSION,
        busy,
        workspaces,
        panes,
        tasks: tasks.map((task) => task.id)
      },
      null,
      2
    )}\n`
  )
  process.stdout.write(
    `soak: session ${SESSION} up, ${workspaces.length} workspaces, ${panes.length} panes, ` +
      `${tasks.length} tasks\nsoak: state at ${STATE_FILE}\n`
  )
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

/**
 * pid/ppid/rss for every process, straight out of /proc.
 *
 * `ps -e` would do, but this needs the parent chain anyway to find the app's
 * subtree, and /proc/<pid>/stat is the only place that has both in one pass.
 */
function procTable() {
  const rows = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let stat = ''
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // exited between readdir and read
    }
    // comm may contain spaces and parens, so the fields start after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    rows.push({ pid: Number(entry), ppid: Number(fields[1]), rssKB: Number(fields[21]) * PAGE_KB })
  }
  return rows
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {
    return ''
  }
}

/** RSS of the app's own subtree, by role, plus the total the claim is about. */
function sampleRss(mainPid) {
  const rows = procTable()
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const subtree = new Set([mainPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (!subtree.has(row.pid) && subtree.has(row.ppid)) {
        subtree.add(row.pid)
        grew = true
      }
    }
  }
  const procs = []
  for (const pid of subtree) {
    const row = byPid.get(pid)
    if (!row) continue
    const text = cmdline(pid)
    const kind =
      pid === mainPid
        ? 'main'
        : text.includes('--type=renderer')
          ? 'renderer'
          : text.includes('--type=gpu')
            ? 'gpu'
            : 'helper'
    procs.push({ kind, pid, rssKB: Math.round(row.rssKB) })
  }
  const byKind = {}
  for (const proc of procs) byKind[proc.kind] = (byKind[proc.kind] || 0) + proc.rssKB
  return { procs, byKind, totalKB: procs.reduce((sum, proc) => sum + proc.rssKB, 0) }
}

/**
 * The herdr server's own RSS, as context rather than as the claim.
 *
 * Twenty panes filling scrollback grow *its* heap too, and a reader who sees a
 * flat curve for us should be able to see that the growth went somewhere. Found
 * by socket inode, because several session servers can run at once and their
 * command lines are identical. Best effort: null when it cannot be had.
 */
function sampleHerdr(socketPath) {
  try {
    const unix = fs.readFileSync('/proc/net/unix', 'utf8')
    const line = unix.split('\n').find((row) => row.endsWith(socketPath))
    if (!line) return null
    const inode = line.trim().split(/\s+/)[6]
    if (!inode || inode === '0') return null
    const wanted = `socket:[${inode}]`
    for (const row of procTable()) {
      if (!cmdline(row.pid).includes('herdr')) continue
      let fds = []
      try {
        fds = fs.readdirSync(`/proc/${row.pid}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        try {
          if (fs.readlinkSync(`/proc/${row.pid}/fd/${fd}`) === wanted) return Math.round(row.rssKB)
        } catch {
          /* a fd that closed under us */
        }
      }
    }
  } catch {
    /* context only: never let this take the run down */
  }
  return null
}

/** What the Bench is showing, read through locators: this file has no DOM lib. */
async function sampleDom(page) {
  const out = { selected: '', cursor: '', panes: 0, phases: [], dropped: '', canvases: 0 }
  try {
    const name = await page
      .locator('.task-row[data-selected="true"] .task-name')
      .first()
      .textContent()
    out.selected = (name || '').trim()
    // The cursor is not the selection: `j`/`k` move the cursor and `Enter`
    // promotes it, so a run that only watches `data-selected` would conclude
    // the keyboard does nothing while the Bench is in fact moving fine.
    out.cursor = (
      (await page.locator('.task-row[data-cursor="true"] .task-name').first().textContent()) || ''
    ).trim()
    out.panes = await page.locator('.pane').count()
    out.phases = await page
      .locator('.pane-flag')
      .evaluateAll((nodes) => nodes.map((node) => `${node.dataset.phase}/${node.dataset.live}`))
    out.dropped = (await page.locator('.pane-flag span').allInnerTexts())
      .join('|')
      .replace(/\s+/g, ' ')
    out.canvases = await page.locator('.pane-body canvas').count()
  } catch {
    /* a sample that misses is still a sample; the RSS is the claim */
  }
  return out
}

/**
 * One keyboard step: move the cursor, then commit it so the pane grid remounts.
 *
 * `move()` clamps at both ends instead of wrapping, so a run that only ever
 * presses `j` spends 40 of its 80 cycles parked on the last row. The direction
 * flips when a step fails to move the cursor, which walks the whole list twice.
 */
async function step(page, direction) {
  const before = (await sampleDom(page)).cursor
  await page.keyboard.press(direction === 'down' ? 'j' : 'k')
  await sleep(400)
  const after = (await sampleDom(page)).cursor
  if (after === before) {
    direction = direction === 'down' ? 'up' : 'down'
    await page.keyboard.press(direction === 'down' ? 'j' : 'k')
    await sleep(400)
  }
  // Enter is what mounts the panes of the row the cursor is on. A focused button
  // would swallow it (`control(event.target)` in Bench.tsx), hence the blur.
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Enter')
  await sleep(900)
  return direction
}

async function run() {
  const state = readState()
  const { _electron: electron } = await import('playwright-core')
  const mainEntry = path.join(root, 'out', 'main', 'index.js')
  if (!fs.existsSync(mainEntry)) fail('out/main/index.js missing; run npx electron-vite build first')

  // Copied key by key rather than spread: Playwright rejects a map whose values
  // are undefined, and process.env is full of them.
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.CODEWAIFU_HOME = state.home
  // Hooks are installed into the agents' homes at launch; left alone an hour-long
  // run would rewrite the developer's real ~/.codex/hooks.json.
  env.CODEX_HOME = path.join(state.home, 'codex')
  env.CLAUDE_CONFIG_DIR = path.join(state.home, 'claude')
  env.ELECTRON_DISABLE_SANDBOX = '1'
  // `npm run dev` exports this, and a shell that still has it would point the
  // Bench at a dev server that is not running.
  delete env.ELECTRON_RENDERER_URL

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [mainEntry, `--user-data-dir=${path.join(state.home, 'userData')}`, '--no-sandbox'],
    env,
    timeout: 60_000
  })
  const proc = app.process()
  const mainPid = proc.pid
  // Drained whether or not anyone reads it: a pipe nobody empties fills at 64KB
  // and blocks the child, which would look exactly like a memory-freeze bug.
  const tail = []
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 200) tail.shift()
      }
    })
  }

  let page = null
  const bootDeadline = Date.now() + 60_000
  while (!page && Date.now() < bootDeadline) {
    page = app.windows().find((window) => window.url().includes('pro.html')) || null
    if (!page) await sleep(300)
  }
  if (!page) fail(`no Bench window within 60s; stderr tail:\n${tail.slice(-8).join('\n')}`)
  await page.locator('.task-row').first().waitFor({ timeout: 60_000 })

  // The acceptance says keyboard-only, so the keyboard is what moves here - but a
  // key event lands on whatever has focus, and at boot that is not guaranteed to
  // be the tree. Prove a full step works before burning an hour on it. Blurring
  // rather than clicking a row: a clicked row is a focused button, and Enter then
  // re-activates that button instead of committing the cursor.
  const firstCursor = (await sampleDom(page)).cursor
  let direction = await step(page, 'down')
  if ((await sampleDom(page)).cursor === firstCursor) {
    await page.evaluate(() => document.activeElement?.blur?.())
    direction = await step(page, 'down')
  }
  if ((await sampleDom(page)).cursor === firstCursor) {
    fail('`j` does not move the cursor; the hour would measure a Bench nobody drives')
  }

  fs.writeFileSync(OUT_FILE, '')
  const started = Date.now()
  const horizon = started + MINUTES * 60_000
  let nextSample = 0
  let nextCycle = started + CYCLE_S * 1000
  let cycles = 0
  process.stdout.write(
    `soak: pid ${mainPid}, sampling ${MINUTES} min every ${SAMPLE_S}s, cycling every ${CYCLE_S}s\n` +
      `soak: out ${OUT_FILE}\n`
  )

  while (Date.now() < horizon) {
    if (proc.exitCode !== null || proc.killed) {
      fail(
        `the app died after ${Math.round((Date.now() - started) / 1000)}s; stderr tail:\n` +
          tail.slice(-12).join('\n')
      )
    }
    const now = Date.now()
    if (now >= nextSample) {
      nextSample = now + SAMPLE_S * 1000
      const dom = await sampleDom(page)
      const rss = sampleRss(mainPid)
      const line = {
        t: new Date(now).toISOString(),
        elapsedS: Math.round((now - started) / 1000),
        cycles,
        ...dom,
        rss: rss.byKind,
        totalKB: rss.totalKB,
        procs: rss.procs,
        herdrKB: sampleHerdr(state.socket)
      }
      fs.appendFileSync(OUT_FILE, `${JSON.stringify(line)}\n`)
      process.stdout.write(
        `soak: +${String(line.elapsedS).padStart(4)}s ${(dom.selected || dom.cursor).padEnd(14)} ` +
          `total=${(line.totalKB / 1024).toFixed(0)}MB ` +
          `renderer=${((line.rss.renderer || 0) / 1024).toFixed(0)}MB ` +
          `main=${((line.rss.main || 0) / 1024).toFixed(0)}MB ` +
          `herdr=${line.herdrKB === null ? '?' : `${(line.herdrKB / 1024).toFixed(0)}MB`} ` +
          `panes=${dom.panes} phases=${dom.phases.join(',')}\n`
      )
    }
    if (now >= nextCycle) {
      nextCycle = now + CYCLE_S * 1000
      direction = await step(page, direction).catch(() => direction)
      cycles += 1
    }
    await sleep(1000)
  }

  process.stdout.write(`soak: hour done, ${cycles} selection cycles, closing the app\n`)
  await Promise.race([app.close().catch(() => undefined), sleep(8000)])
  try {
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
  } catch {
    /* already gone, which is the wanted outcome */
  }
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

/** Least squares of MB against minutes. The slope is the claim. */
function slopePerMin(points) {
  const n = points.length
  const xs = points.map(([x]) => x / 60)
  const ys = points.map(([, y]) => y / 1024)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0)
  if (den === 0) return 0
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0)
  return num / den
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1)
}

function report() {
  const lines = fs
    .readFileSync(OUT_FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  if (lines.length < 10) fail(`only ${lines.length} samples in ${OUT_FILE}; the run did not happen`)
  const spanMin = (lines[lines.length - 1].elapsedS - lines[0].elapsedS) / 60
  process.stdout.write(`soak: ${lines.length} samples over ${spanMin.toFixed(1)} min\n\n`)

  const series = [['total', (l) => l.totalKB]]
  for (const kind of ['main', 'renderer', 'gpu', 'helper']) {
    series.push([kind, (l) => l.rss?.[kind]])
  }
  series.push(['herdr', (l) => l.herdrKB])
  for (const [name, pick] of series) {
    const points = lines
      .map((line) => [line.elapsedS, pick(line)])
      .filter(([, value]) => typeof value === 'number')
    if (points.length < 10) continue
    const mb = points.map(([, value]) => value / 1024)
    const slope = slopePerMin(points)
    process.stdout.write(
      `${name.padEnd(9)} peak ${Math.max(...mb).toFixed(1).padStart(7)} MB  ` +
        `first3 ${mean(mb.slice(0, 3)).toFixed(1).padStart(7)} MB  ` +
        `last3 ${mean(mb.slice(-3)).toFixed(1).padStart(7)} MB  ` +
        `slope ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} MB/min\n`
    )
  }

  // The curve is only evidence for the criterion if a human-shaped thing was
  // driving the Bench while it was measured.
  const distinct = new Set(lines.map((line) => line.selected)).size
  const cursors = new Set(lines.map((line) => line.cursor)).size
  const cycles = lines[lines.length - 1].cycles
  const paneCounts = new Set(lines.map((line) => line.panes))
  const phases = new Set(lines.flatMap((line) => line.phases))
  const dropped = lines.map((line) => line.dropped).filter((text) => /\d/.test(text))
  const canvasCounts = new Set(lines.map((line) => line.canvases))
  process.stdout.write(
    `\nsoak: selection visited ${distinct} distinct tasks over ${cycles} cycles\n` +
      `soak: cursor visited ${cursors} distinct tasks\n` +
      `soak: mounted panes per sample ${[...paneCounts].sort().join(',')}\n` +
      `soak: bridge phases seen ${[...phases].sort().join(' ') || 'none'}\n` +
      `soak: canvases per sample ${[...canvasCounts].sort().join(',')}\n` +
      `soak: samples reporting dropped frames ${dropped.length}/${lines.length}` +
      `${dropped.length ? ` (last: ${dropped[dropped.length - 1].slice(0, 80)})` : ''}\n`
  )
  if (distinct < 2) fail('the selection never moved; this measured an idle Bench')
}

/* ------------------------------------------------------------------ *
 * teardown
 * ------------------------------------------------------------------ */

function teardown() {
  const state = readState()
  const quiet = (args) =>
    spawnSync(HERDR, args, { env: { ...process.env, HERDR_SESSION: SESSION }, encoding: 'utf8' })
  for (const pane of state.panes) quiet(['pane', 'close', pane.id])
  for (const workspace of state.workspaces) quiet(['workspace', 'close', workspace.id])
  quiet(['session', 'stop', SESSION])
  fs.rmSync(state.base, { recursive: true, force: true })
  fs.rmSync(STATE_FILE, { force: true })
  process.stdout.write(
    `soak: session ${SESSION} stopped, temps removed (samples kept at ${OUT_FILE})\n`
  )
}

const verb = process.argv[2]
if (verb === 'setup') setup()
else if (verb === 'run') await run()
else if (verb === 'report') report()
else if (verb === 'teardown') teardown()
else fail(`unknown verb ${verb}; want setup | run | report | teardown`)
