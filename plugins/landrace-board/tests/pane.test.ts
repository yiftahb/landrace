import { test, expect, mock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import type { BoardRow, BoardView } from '../types'

const row = (id: string, more: Partial<BoardRow> = {}): BoardRow => ({
  id,
  kind: 'item',
  title: `Item ${id}`,
  link: `https://example.com/${id}`,
  badge: 'waiting',
  lane: null,
  page: null,
  stage: 'todo',
  note: '',
  context: false,
  stale: false,
  chat: { prompt: `Let's talk about #${id}` },
  children: [],
  ...more,
})

const story = () => row('11', { badge: 'needs-you', stage: 'spec', note: 'approve the spec' })

// Epic #10 waits itself; story #11 under it needs you; task #12 runs.
const VIEW: BoardView = {
  listed: true,
  needsYou: 1,
  workflows: [
    { id: 'full-cycle', name: 'Full cycle', needsYou: 1 },
    { id: 'fastlane', name: 'Fastlane', needsYou: 0 },
  ],
  rows: [
    row('10', { page: null, lane: 'needs-you', context: true, children: [story()] }),
    row('10', { page: 'full-cycle', lane: 'needs-you', context: true, children: [story()] }),
    row('10', { page: 'full-cycle', lane: 'running', context: true, children: [row('12', { badge: 'running', stage: 'build' })] }),
    row('10', { page: 'full-cycle', lane: 'waiting' }),
    row('pr-99', { kind: 'pull-request', title: 'Old PR', badge: null, chat: null, page: 'full-cycle', lane: 'discharged' }),
  ],
}

const URL = 'http://127.0.0.1:4545'
const ran = (exitCode: number, stdout: string, stderr = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

/** The world beneath the plugin: landrace, its board, and the session's UI calls, recorded. */
function world(on: On, port: { answer: ProcessRunResult | Error; cwdFails?: boolean }, served: { view: BoardView | null; hang?: boolean }) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 11, 9, 30) })
  const seen = {
    argv: [] as string[][],
    cwd: [] as (string | undefined)[],
    fetched: [] as string[],
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    filled: [] as string[],
    panes: new Map<string, string>(),
    closed: [] as string[],
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => {
    if (port.cwdFails) {
      port.cwdFails = false
      throw new Error('no session folder yet')
    }
    return { value: '/work/project' }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    seen.argv.push([...e.argv])
    seen.cwd.push(e.init?.cwd)
    if (port.answer instanceof Error) throw port.answer
    return { value: port.answer }
  })
  on('http.fetch', async ($, e) => {
    seen.fetched.push(e.url)
    const view = served.view
    if (served.hang) await clock.sleep(3_600_000)
    return view === null
      ? { value: { status: 502, ok: false, headers: {}, text: 'bad gateway' } }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(view) } }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.panes.set(e.id, e.title ?? e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.panes.delete(e.id)
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...seen.panes].map(([id, title]) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })) }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  return { clock, seen }
}

const start = async ($: { session: { start: (e: { cwd: string; surface: null; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/work/project', surface: null, isInteractive: true })

const PANE = (title: string) => ({
  title,
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

test('session start runs `<command> port` in the session folder and reads the board it names', { options: { command: 'node  dist/cli.js' } }, async ($, on) => {
  const { clock, seen } = world(on, { answer: ran(0, `${URL}\n`) }, { view: VIEW })
  await start($)
  await clock.settle()
  expect(seen.argv).toEqual([['node', 'dist/cli.js', 'port']])
  expect(seen.cwd).toEqual(['/work/project'])
  expect(seen.fetched).toEqual([`${URL}/board.json`])
  expect(seen.status.at(-1)).toBe('landrace: 1 needs you')
  await clock.advance(5000)
  expect(seen.fetched.length).toBe(2)
})

test('port exiting 1 is offline, said in the status line and the pane, and asked again every 30 s', async ($, on) => {
  const { clock, seen } = world(on, { answer: ran(1, 'offline\n', 'landrace port: no record for the workspace in .landrace\n') }, { view: VIEW })
  await start($)
  await clock.settle()
  expect(seen.status.at(-1)).toBe('landrace: offline')
  expect(seen.fetched).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'needs-you', props: PANE('Needs You') })
    expect(await ui.find({ text: /no record for the workspace/ })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(29_000)
  expect(seen.argv.length).toBe(1)
  await clock.advance(1_000)
  expect(seen.argv.length).toBe(2)
})

test('a command that cannot start, and a binary with no port command, each say so', async ($, on) => {
  const port = { answer: new Error('spawn landrace ENOENT') as ProcessRunResult | Error }
  const { clock, seen } = world(on, port, { view: VIEW })
  await start($)
  await clock.settle()
  expect(seen.status.at(-1)).toBe("landrace: 'landrace' not found; set the command option")
  port.answer = ran(1, '', "error: unknown command 'port'\n")
  await clock.advance(30_000)
  expect(seen.status.at(-1)).toBe("landrace: no 'port' command; update landrace")
})

test('a toast when an id newly needs you, never on the first read', async ($, on) => {
  const served = { view: VIEW as BoardView | null }
  const { clock, seen } = world(on, { answer: ran(0, URL) }, served)
  await start($)
  await clock.settle()
  expect(seen.toasts).toEqual([])
  served.view = { ...VIEW, needsYou: 2, rows: [...VIEW.rows, row('40', { title: 'Pick a name', page: null, lane: 'needs-you', badge: 'needs-you' })] }
  await clock.advance(5000)
  expect(seen.toasts).toEqual(['landrace: #40 needs you: Pick a name'])
  expect(seen.status.at(-1)).toBe('landrace: 2 needs you')
  await clock.advance(5000)
  expect(seen.toasts.length).toBe(1)
})

test('a tab draws its lanes from the split tree: an item in two lanes is in both, a context row dimmed with no actions', async ($, on) => {
  const { clock, seen } = world(on, { answer: ran(0, URL) }, { view: VIEW })
  await start($)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'FULL_CYCLE', props: PANE('Full cycle · 1') })
    expect((await ui.find({ type: 'Link', text: 'Board ↗' }))?.props.href).toBe('http://localhost:4545')
    expect(await ui.find({ key: 'row:needs-you:10' })).toBeDefined()
    expect(await ui.find({ key: 'row:running:10' })).toBeDefined()
    expect(await ui.find({ key: 'row:waiting:10' })).toBeDefined()
    expect((await ui.find({ key: 'lane:needs-you' }))?.text).toContain('Needs you · 1')
    expect((await ui.find({ key: 'lane:running' }))?.text).toContain('Agent running · 1')
    // The context copy of #10 is dim and offers nothing; its own copy in Waiting does.
    const titleDim = async (key: string) => ((await ui.find({ key }))?.children[0] as { props: { dimColor?: boolean } } | undefined)?.props.dimColor
    expect(await titleDim('row:needs-you:10')).toBe(true)
    expect(await titleDim('row:waiting:10')).toBe(false)
    expect(await ui.find({ key: 'chat:needs-you:10' })).toBeUndefined()
    expect(await ui.find({ key: 'chat:waiting:10' })).toBeDefined()
    expect(await ui.find({ key: 'chat:needs-you:11' })).toBeDefined()
    expect((await ui.find({ key: 'row:needs-you:11' }))?.text).toContain('spec · approve the spec')
    // Done starts collapsed, and opens on a press.
    expect(await ui.find({ key: 'row:discharged:pr-99' })).toBeUndefined()
    await ui.press({ key: 'lane:discharged' })
    expect(await ui.find({ key: 'row:discharged:pr-99' })).toBeDefined()
    await ui.press({ key: 'lane:discharged' })
    await ui.press({ key: 'chat:needs-you:11' })
    await ui.unmount()
  }
  expect(seen.filled).toEqual(["Let's talk about #11", "Let's talk about #11"])
})

test("the desktop links http://localhost and draws port's 127.0.0.1 as plain text, so Board ↗ names localhost", async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'PROBE' }, ($, e) => {
    const { Box, Link } = $.ui.resolve(e)
    return h(Box, null, h(Link, { href: 'http://localhost:4545', label: 'local' }), h(Link, { href: URL, label: 'loopback' }))
  })
  const ui = await $.ui.mount({ plugin: 'landrace-board', surface: 'desktop', component: 'Pane', requestId: 'PROBE', props: PANE('Probe') })
  expect(await ui.find({ type: 'Link', text: 'local' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'loopback' })).toBeUndefined()
  await ui.unmount()
})

test("another plugin's pane with an id shaped like a workflow's is left to its owner", async ($, on) => {
  const { clock } = world(on, { answer: ran(0, URL) }, { view: VIEW })
  on('ui.render', { component: 'Pane', requestId: 'LOG' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'the log')
  })
  await start($)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'LOG', props: PANE('Log') })
    expect(await ui.find({ text: 'the log' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'Board ↗' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a workflow pane still open after its workflow left the view is drawn, not handed on', async ($, on) => {
  const { clock, seen } = world(on, { answer: ran(0, URL) }, { view: VIEW })
  await start($)
  await clock.settle()
  seen.panes.set('GONE', 'Gone')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'GONE', props: PANE('Gone') })
    expect(await ui.find({ type: 'Link', text: 'Board ↗' })).toBeDefined()
    await ui.unmount()
  }
})

test('Needs You draws only its lane', async ($, on) => {
  const { clock } = world(on, { answer: ran(0, URL) }, { view: VIEW })
  await start($)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'needs-you', props: PANE('Needs You · 1') })
    expect(await ui.find({ key: 'row:needs-you:11' })).toBeDefined()
    expect(await ui.find({ key: 'lane:running' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a workflow id outside the rule opens no tab, and Needs You says so', async ($, on) => {
  const served = { view: { ...VIEW, workflows: [...VIEW.workflows, { id: 'Bad id', name: 'Bad', needsYou: 0 }] } as BoardView | null }
  const { clock, seen } = world(on, { answer: ran(0, URL) }, served)
  await start($)
  await clock.settle()
  await $.command.run({ command: 'board', args: '' } as never)
  expect([...seen.panes.keys()]).toEqual(['needs-you', 'FULL_CYCLE', 'FASTLANE'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'needs-you', props: PANE('Needs You · 1') })
    expect(await ui.find({ text: "no tab for workflow 'Bad id': not a workflow id" })).toBeDefined()
    await ui.unmount()
  }
})

test('a failed read keeps the rows, dimmed and stale since the last good read, and asks port again at once', async ($, on) => {
  const served = { view: VIEW as BoardView | null }
  const { clock, seen } = world(on, { answer: ran(0, URL) }, served)
  await start($)
  await clock.settle()
  served.view = null
  await clock.advance(5000)
  expect(seen.argv.length).toBe(2)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'needs-you', props: PANE('Needs You · 1') })
    expect(await ui.find({ text: /stale since \d\d:\d\d/ })).toBeDefined()
    const title = (await ui.find({ key: 'row:needs-you:11' }))?.children[0] as { props: { dimColor?: boolean } } | undefined
    expect(title?.props.dimColor).toBe(true)
    // The rows are the last good read's, not dropped.
    expect(await ui.find({ key: 'chat:needs-you:11' })).toBeDefined()
    await ui.unmount()
  }
})

test('/board opens one pane per sidebar page, counted; a workflow that leaves closes its pane', async ($, on) => {
  const served = { view: VIEW as BoardView | null }
  const { clock, seen } = world(on, { answer: ran(0, URL) }, served)
  await start($)
  await clock.settle()
  expect(seen.panes.size).toBe(0)
  await $.command.run({ command: 'board', args: '' } as never)
  expect([...seen.panes]).toEqual([
    ['needs-you', 'Needs You · 1'],
    ['FULL_CYCLE', 'Full cycle · 1'],
    ['FASTLANE', 'Fastlane'],
  ])
  served.view = {
    ...VIEW,
    needsYou: 2,
    workflows: [{ id: 'full-cycle', name: 'Full cycle', needsYou: 2 }, { id: 'docs', name: 'Docs', needsYou: 0 }],
  }
  await clock.advance(5000)
  expect([...seen.panes]).toEqual([
    ['needs-you', 'Needs You · 2'],
    ['FULL_CYCLE', 'Full cycle · 2'],
    ['DOCS', 'Docs'],
  ])
  expect(seen.closed).toEqual(['FASTLANE'])
})

test('a board that has not listed yet seeds nothing: its first listing announces nothing already waiting', async ($, on) => {
  const served = { view: { ...VIEW, listed: false, needsYou: 0, rows: [] } as BoardView | null }
  const { clock, seen } = world(on, { answer: ran(0, URL) }, served)
  await start($)
  await clock.settle()
  served.view = VIEW
  await clock.advance(5000)
  expect(seen.toasts).toEqual([])
  expect(seen.status.at(-1)).toBe('landrace: 1 needs you')
})

test("a restarted board that has not listed yet clears the old board's rows and count", async ($, on) => {
  const port = { answer: ran(0, URL) }
  const served = { view: VIEW as BoardView | null }
  const { clock, seen } = world(on, port, served)
  await start($)
  await clock.settle()
  expect(seen.status.at(-1)).toBe('landrace: 1 needs you')
  served.view = null
  port.answer = ran(0, 'http://127.0.0.1:4646')
  await clock.advance(5000)
  expect(seen.argv.length).toBe(2)
  served.view = { ...VIEW, listed: false, needsYou: 0, workflows: [], rows: [] }
  await clock.advance(5000)
  expect(seen.fetched.at(-1)).toBe('http://127.0.0.1:4646/board.json')
  expect(seen.status.at(-1)).toBeUndefined()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'landrace-board', surface, component: 'Pane', requestId: 'needs-you', props: PANE('Needs You · 1') })
    expect(await ui.find({ text: 'Waiting for the first tick…' })).toBeDefined()
    expect(await ui.find({ key: 'row:needs-you:11' })).toBeUndefined()
    expect(await ui.find({ key: 'lane:needs-you' })).toBeUndefined()
    expect(await ui.find({ text: /stale since/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a read that never answers counts as failed, and port is asked again', async ($, on) => {
  const served = { view: VIEW as BoardView | null, hang: false }
  const { clock, seen } = world(on, { answer: ran(0, URL) }, served)
  await start($)
  await clock.settle()
  served.hang = true
  await clock.advance(5000)
  expect(seen.argv.length).toBe(1)
  await clock.advance(10_000)
  expect(seen.argv.length).toBe(2)
  served.hang = false
  await clock.advance(5000)
  expect(seen.fetched.length).toBe(3)
})

test('a first ask that throws is asked again in 30 s', async ($, on) => {
  const { clock, seen } = world(on, { answer: ran(0, URL), cwdFails: true }, { view: VIEW })
  await start($)
  await clock.settle()
  expect(seen.argv).toEqual([])
  await clock.advance(30_000)
  expect(seen.argv.length).toBe(1)
  expect(seen.status.at(-1)).toBe('landrace: 1 needs you')
})
