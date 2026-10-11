import type { ProcessRunResult } from 'claude-code'

import type { BoardLane, BoardReach, BoardRow, BoardView } from '../types'

/*
 * The walking and counting the pane draws from, pure so a test calls it
 * directly. It mirrors the board page's own (landrace's `src/ui/page.ts`:
 * `rootsOn`, `laneRoots`, `treeRows`, `matchCount`), less its search: the
 * server already split each tree into one copy per (page, lane), so the pane
 * only walks what it was sent and never places an item itself.
 */

/** The board's lanes, in its order, with the names its page gives them. */
export const LANES: readonly { lane: BoardLane; label: string }[] = [
  { lane: 'needs-you', label: 'Needs you' },
  { lane: 'running', label: 'Agent running' },
  { lane: 'elsewhere', label: 'Held elsewhere' },
  { lane: 'waiting', label: 'Waiting' },
  { lane: 'not-admitted', label: 'Not admitted' },
  { lane: 'discharged', label: 'Done' },
]

const COLLAPSED: ReadonlySet<BoardLane> = new Set(['not-admitted', 'discharged'])

export type DrawnRow = { row: BoardRow; depth: number }

export type PaneLane = {
  lane: BoardLane
  label: string
  count: number
  /** The board's default: Not admitted and Done start collapsed. */
  isCollapsed: boolean
  rows: DrawnRow[]
}

/** The server's copies for one page; Needs You's are page null. */
export const rootsOn = (rows: readonly BoardRow[], page: string | null): BoardRow[] => rows.filter(r => r.page === page)

/** null where the page does not draw the lane: Needs You draws only its own. */
export const laneRoots = (rows: readonly BoardRow[], page: string | null, lane: BoardLane): BoardRow[] | null =>
  page === null && lane !== 'needs-you' ? null : rootsOn(rows, page).filter(r => r.lane === lane)

/**
 * Depth-first over `children`. `seen` guards one lane against a cycle, and
 * is never shared: shared, it drew a parent in the first lane it was in and
 * dropped it from every other.
 */
export const treeRows = (rows: readonly BoardRow[], depth = 0, seen = new Set<string>(), out: DrawnRow[] = []): DrawnRow[] => {
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push({ row, depth })
    treeRows(row.children, depth + 1, seen, out)
  }
  return out
}

/**
 * What a copy adds to its lane's count: its filed items, never a context row
 * nor an artifact, which comes with its item; a root with no item counts once.
 */
export const matchCount = (copy: BoardRow): number => {
  let n = !copy.context && copy.kind !== 'item' ? 1 : 0
  const seen = new Set<string>()
  const walk = (row: BoardRow): void => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    if (!row.context && row.kind === 'item') n++
    for (const child of row.children) walk(child)
  }
  walk(copy)
  return n
}

/** Every lane a tab draws, in the board's order, each walked on its own. */
export const paneLanes = (view: BoardView, page: string | null): PaneLane[] =>
  LANES.flatMap(({ lane, label }) => {
    const roots = laneRoots(view.rows, page, lane)
    if (roots === null) return []
    return [{
      lane,
      label,
      count: roots.reduce((n, r) => n + matchCount(r), 0),
      isCollapsed: COLLAPSED.has(lane),
      rows: treeRows(roots),
    }]
  })

export const paneTitle = (name: string, count: number): string => (count > 0 ? `${name} · ${count}` : name)

// A pane id is 1-64 of letters, digits, `_` and `-`, and a workflow id 1-64 of
// lowercase letters, digits and `-`: a prefix cannot fit, and truncating gave
// two 64-character ids one pane. Uppercasing and `-` to `_` maps one to one,
// and never onto the lowercase `needs-you`.
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const WORKFLOW_PANE = /^[A-Z0-9][A-Z0-9_]{0,63}$/

/** The page's pane id; none for a workflow id outside the rule, which could share one. */
export const paneId = (page: string | null): string | undefined =>
  page === null ? 'needs-you' : WORKFLOW_ID.test(page) ? page.toUpperCase().replaceAll('-', '_') : undefined

/** The page a pane id names: null for Needs You, undefined for a pane not this plugin's. */
export const pageOfPane = (id: string): string | null | undefined =>
  id === 'needs-you' ? null : WORKFLOW_PANE.test(id) ? id.toLowerCase().replaceAll('_', '-') : undefined

export const subtitleOf = (row: BoardRow): string => [row.stage, row.note].filter(part => part !== null && part !== '').join(' · ')

/**
 * Every id that needs the person now, as the board's bell judges it: a
 * needs-you badge read from fresh labels, or one that needed them at the last
 * read and is only held elsewhere, or read from stale labels, now — the item
 * never left them, so its return is no arrival.
 */
export const needingIds = (rows: readonly BoardRow[], before: readonly string[] | null): string[] => {
  const into = new Set<string>()
  const walk = (list: readonly BoardRow[]): void => {
    for (const row of list) {
      const unsure = row.badge === 'elsewhere' || (row.badge === 'needs-you' && row.stale)
      const held = unsure && before !== null && before.includes(row.id)
      if ((row.badge === 'needs-you' && !row.stale) || held) into.add(row.id)
      walk(row.children)
    }
  }
  walk(rows)
  return [...into]
}

/** The ids needing the person now that did not at the last read; the first read only seeds. */
export const arrivals = (before: readonly string[] | null, now: readonly string[]): string[] =>
  before === null ? [] : now.filter(id => !before.includes(id))

/** The `command` option, split on spaces, then `port`; blank means the default. */
export const argvOf = (command: string): string[] => {
  const words = command.split(' ').filter(word => word !== '')
  return [...(words.length > 0 ? words : ['landrace']), 'port']
}

/**
 * What `landrace port` answered: stdout the URL on exit 0; `offline` on exit
 * 1 with the reason on stderr. A binary older than `port` has no such
 * command, and commander says so on stderr.
 */
export const readPort = (ran: ProcessRunResult): BoardReach => {
  const out = ran.stdout.trim()
  const err = ran.stderr.trim()
  if (ran.exitCode === 0) {
    return /^https?:\/\/\S+$/.test(out) ? { kind: 'live', url: out } : { kind: 'offline', reason: `port printed no URL: ${out}` }
  }
  if (out !== 'offline' && /unknown command/i.test(err)) return { kind: 'no-port' }
  return { kind: 'offline', reason: err.replace(/^landrace port: /, '') || `port exited ${ran.exitCode}` }
}

export const statusLine = (reach: BoardReach | null, view: BoardView | null, command: string): string | undefined => {
  if (reach === null) return undefined
  switch (reach.kind) {
    case 'live':
      return view !== null && view.needsYou > 0 ? `landrace: ${view.needsYou} needs you` : undefined
    case 'offline':
      return 'landrace: offline'
    case 'no-port':
      return "landrace: no 'port' command; update landrace"
    case 'not-found':
      return `landrace: '${command}' not found; set the command option`
  }
}

/**
 * The `Board ↗` link. A desktop surface links only https: and
 * http://localhost, and draws `port`'s 127.0.0.1 as plain text (the engine
 * says so; a pane test pins it); the board answers both host names. Reads
 * keep the URL `port` gave.
 */
export const boardLink = (url: string): string => url.replace(/^http:\/\/127\.0\.0\.1(?=[:/]|$)/, 'http://localhost')

/** `HH:MM`, local time, for "stale since". */
export const clockOf = (ms: number): string => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * A `/board.json` body, or null when it is not one: the pane never draws a
 * shape it did not check.
 */
export const parseView = (text: string): BoardView | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { rows, workflows, needsYou, listed } = raw as Record<string, unknown>
  if (!Array.isArray(rows) || !Array.isArray(workflows) || typeof needsYou !== 'number') return null
  // As the board page reads it: listed only when it says so.
  return { ...(raw as BoardView), listed: listed === true }
}
