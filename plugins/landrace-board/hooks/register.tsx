import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  argvOf,
  arrivals,
  boardLink,
  clockOf,
  needingIds,
  paneId,
  paneLanes,
  paneTitle,
  parseView,
  readPort,
  statusLine,
  subtitleOf,
} from './board.ts'
import type { BoardReach, BoardRow, BoardState, BoardView } from '../types'

const READ_MS = 5_000
const RETRY_MS = 30_000
// `port` gives up on the board after two seconds; this is for a node that
// cannot even start in time.
const PORT_TIMEOUT_MS = 15_000

const NEEDS_YOU = 'Needs You'

const INITIAL: BoardState = { view: null, reach: null, isLive: false, readAt: null, needing: null }
const board = atom({ plugin: 'landrace-board', key: 'board' } as const, INITIAL)
const toggled = atom({ plugin: 'landrace-board', key: 'toggled' } as const, [] as string[])

/** Each sidebar page's pane: Needs You first, then each workflow, with its count. */
const pagesOf = (view: BoardView | null): { id: string; title: string }[] => [
  { id: paneId(null), title: paneTitle(NEEDS_YOU, view?.needsYou ?? 0) },
  ...(view?.workflows ?? []).map(w => ({ id: paneId(w.id), title: paneTitle(w.name, w.needsYou) })),
]

const findRow = (rows: readonly BoardRow[], id: string): BoardRow | undefined => {
  for (const row of rows) {
    if (row.id === id) return row
    const below = findRow(row.children, id)
    if (below) return below
  }
  return undefined
}

const arrivalToast = (view: BoardView, ids: readonly string[]): string => {
  const [only] = ids
  if (ids.length === 1 && only !== undefined) {
    const title = findRow(view.rows, only)?.title
    return title ? `landrace: #${only} needs you: ${title}` : `landrace: #${only} needs you`
  }
  return `landrace: ${ids.map(id => `#${id}`).join(', ')} need you`
}

// The engine follows `$` only into functions declared at the top of this
// file, so the loop lives here, and what it shares lives beside it.
let command = 'landrace'
// One timer at a time: the 5 s read while live, the 30 s ask while not.
let timer: Timer | null = null
let isBusy = false

/** Runs one ask or one read, unless the last is still running. */
async function turn($: EngineInterface, mode: 'ask' | 'read'): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    if (mode === 'ask') await discover($, true)
    else await poll($)
  } finally {
    isBusy = false
  }
}

function every($: EngineInterface, ms: number, mode: 'ask' | 'read'): void {
  timer?.cancel()
  timer = $.clock.every(ms, () => {
    void turn($, mode)
  })
}

async function showStatus($: EngineInterface): Promise<void> {
  const state = await read($, board)
  $.ui.status(statusLine(state.reach, state.view, command))
}

/** Asks `landrace port` which URL serves this session's board. */
async function ask($: EngineInterface): Promise<BoardReach> {
  const cwd = await $.session.cwd()
  try {
    return readPort(await $.process.run(argvOf(command), { cwd, timeoutMs: PORT_TIMEOUT_MS }))
  } catch (e) {
    // The call rejects when the command cannot start, and when it outlives
    // its timeout; only the first is a command that is not there.
    const message = e instanceof Error ? e.message : String(e)
    return /time(d)? ?out/i.test(message) ? { kind: 'offline', reason: `${command} port did not finish: ${message}` } : { kind: 'not-found' }
  }
}

/**
 * Finds the board. Live, it reads every 5 s, the first read at once unless
 * a read has just failed: that failure is why it asked again, and reading
 * at once would ask again at once, without end. Not live, it asks again in 30 s.
 */
async function discover($: EngineInterface, readNow: boolean): Promise<void> {
  const reach = await ask($)
  await update($, board, state => ({ ...state, reach, isLive: state.isLive && reach.kind === 'live' }))
  await showStatus($)
  if (reach.kind !== 'live') {
    every($, RETRY_MS, 'ask')
    return
  }
  every($, READ_MS, 'read')
  if (readNow) await poll($)
}

async function poll($: EngineInterface): Promise<void> {
  const before = await read($, board)
  if (before.reach?.kind !== 'live') return
  let view: BoardView | null = null
  try {
    const answer = await $.http.fetch(`${before.reach.url}/board.json`)
    view = answer.ok ? parseView(answer.text) : null
  } catch {
    view = null
  }
  if (view === null) {
    await update($, board, state => ({ ...state, isLive: false }))
    await discover($, false)
    return
  }
  const now = await $.clock.now()
  const needing = needingIds(view.rows, before.needing)
  const fresh = arrivals(before.needing, needing)
  const got = view
  await update($, board, state => ({ ...state, view: got, isLive: true, readAt: now, needing }))
  if (fresh.length > 0) $.ui.toast(arrivalToast(view, fresh))
  await showStatus($)
  await follow($, before.view, view)
}

/**
 * Keeps open panes in step with the view: retitles each whose count moved,
 * opens a workflow that appeared, closes one that left. Only while the
 * person has the board's panes open: a read never opens one unasked, and
 * never reopens one the person closed. Opened before any read, the
 * workflows' panes open with the first.
 */
async function follow($: EngineInterface, was: BoardView | null, view: BoardView): Promise<void> {
  const open = new Map((await $.ui.panes()).map(pane => [pane.id, pane.title]))
  if (open.size === 0) return
  const known = new Set(pagesOf(was).map(page => page.id))
  const pages = pagesOf(view)
  for (const page of pages) {
    const title = open.get(page.id)
    if (title === undefined ? !known.has(page.id) : title !== page.title) await $.ui.open(page)
  }
  const kept = new Set(pages.map(page => page.id))
  for (const id of open.keys()) if (!kept.has(id)) await $.ui.close({ id })
}

export const register: Register = (on, options) => {
  command = typeof options.command === 'string' && options.command.trim() !== '' ? options.command.trim() : 'landrace'
  timer = null
  isBusy = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: "Show this project's Landrace board: Needs You, then one tab per workflow" })
    // Not awaited: the first prompt does not wait on a node process.
    $.clock.after(0, () => {
      void turn($, 'ask')
    })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    const state = await read($, board)
    for (const page of pagesOf(state.view)) await $.ui.open(page)
    return { text: state.view === null ? `Opened the board's pane; ${statusLine(state.reach, null, command) ?? 'landrace: not read yet'}.` : 'Opened the board.' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const state = await read($, board)
    const workflow = state.view?.workflows.find(w => paneId(w.id) === e.requestId)
    // Another plugin's pane.
    if (e.requestId !== paneId(null) && workflow === undefined && !e.requestId.startsWith('wf-')) return next(e)
    const page = e.requestId === paneId(null) ? null : (workflow?.id ?? e.requestId.slice(3))
    const opened = await read($, toggled)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const reach = state.reach
    const dim = !state.isLive

    const head = [
      reach?.kind === 'live' ? <Link href={boardLink(reach.url)} label="Board ↗" /> : null,
      reach !== null && reach.kind !== 'live' ? <Text color="red">{statusLine(reach, null, command)}</Text> : null,
      reach?.kind === 'offline' ? <Text dimColor>{reach.reason}</Text> : null,
      reach === null ? <Text dimColor>Looking for this project's board…</Text> : null,
      dim && state.readAt !== null ? <Text dimColor>stale since {clockOf(state.readAt)}</Text> : null,
    ]

    // A context row is only the path to a match: dimmed, and with no actions,
    // as the board page draws none on it.
    const drawRow = (row: BoardRow, depth: number, lane: string) => {
      const muted = dim || row.context
      const key = `row:${lane}:${row.id}`
      if (row.kind !== 'item') {
        return (
          <Box key={key} paddingLeft={depth * 2} flexDirection="row" gap={1}>
            <Text dimColor>{row.kind}</Text>
            {row.link ? <Link href={row.link} label={row.title} /> : <Text dimColor={muted}>{row.title}</Text>}
          </Box>
        )
      }
      const subtitle = subtitleOf(row)
      const chat = row.chat
      return (
        <Box key={key} paddingLeft={depth * 2} flexDirection="column">
          <Text dimColor={muted} bold={!muted}>#{row.id} {row.title}</Text>
          {subtitle !== '' ? <Text dimColor>{subtitle}</Text> : null}
          {row.context ? null : (
            <Box flexDirection="row" gap={1}>
              {row.link ? <Link href={row.link} label="Open ↗" /> : null}
              {chat ? <Button key={`chat:${lane}:${row.id}`} label="Chat here" onPress={() => $.prompt.fill({ text: chat.prompt })} /> : null}
            </Box>
          )}
        </Box>
      )
    }

    const lanes = state.view === null ? [] : paneLanes(state.view, page)
    const body = lanes.map(lane => {
      const toggleKey = `${page ?? ''}:${lane.lane}`
      const isCollapsed = lane.isCollapsed !== opened.includes(toggleKey)
      const flip = () => update($, toggled, list => (list.includes(toggleKey) ? list.filter(k => k !== toggleKey) : [...list, toggleKey]))
      return (
        <Box key={`lane-box:${lane.lane}`} flexDirection="column" marginTop={1}>
          <Button key={`lane:${lane.lane}`} plain label={`${isCollapsed ? '▸' : '▾'} ${lane.label} · ${lane.count}`} onPress={flip} />
          {isCollapsed ? null : lane.rows.length === 0 ? <Text dimColor>None</Text> : lane.rows.map(({ row, depth }) => drawRow(row, depth, lane.lane))}
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {head}
        {body}
      </Box>
    )
  })
}
