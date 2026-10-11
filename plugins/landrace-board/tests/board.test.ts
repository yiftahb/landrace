import { test, expect } from 'claude-code/testing'

import {
  arrivals,
  argvOf,
  boardLink,
  needingIds,
  paneId,
  paneLanes,
  paneTitle,
  readPort,
  statusLine,
  subtitleOf,
} from '../hooks/board.ts'
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

const pull = row('pr-7', { kind: 'pull-request', title: 'PR for 11', badge: null, chat: null, stage: null })

// One tree split across lanes, as /board.json sends it since #134: epic #10
// waits itself, story #11 under it needs you, task #12 under it is running.
// Each copy holds only its own lane's children.
const VIEW: BoardView = {
  needsYou: 1,
  workflows: [
    { id: 'full-cycle', name: 'Full cycle', needsYou: 1 },
    { id: 'fastlane', name: 'Fastlane', needsYou: 0 },
  ],
  rows: [
    row('10', { page: null, lane: 'needs-you', context: true, children: [row('11', { badge: 'needs-you', stage: 'spec', note: 'approve the spec', children: [pull] })] }),
    row('10', { page: 'full-cycle', lane: 'needs-you', context: true, children: [row('11', { badge: 'needs-you', stage: 'spec', note: 'approve the spec', children: [pull] })] }),
    row('10', { page: 'full-cycle', lane: 'running', context: true, children: [row('12', { badge: 'running', stage: 'build' })] }),
    row('10', { page: 'full-cycle', lane: 'waiting', children: [] }),
    row('pr-99', { kind: 'pull-request', badge: null, chat: null, page: 'full-cycle', lane: 'discharged' }),
    row('20', { page: 'fastlane', lane: 'waiting' }),
  ],
}

const drawn = (lane: ReturnType<typeof paneLanes>[number]) => lane.rows.map(r => `${r.depth}:${r.row.id}`)

test('Needs You draws only its own lane, walked depth-first', async () => {
  const lanes = paneLanes(VIEW, null)
  expect(lanes.map(l => l.lane)).toEqual(['needs-you'])
  const [needs] = lanes
  expect(needs && drawn(needs)).toEqual(['0:10', '1:11', '2:pr-7'])
  // The epic is only the path to #11: it is not counted, nor is the pull request.
  expect(needs?.count).toBe(1)
})

test('a workflow tab draws every lane in the board order, an item once in each lane it is in', async () => {
  const lanes = paneLanes(VIEW, 'full-cycle')
  expect(lanes.map(l => l.lane)).toEqual(['needs-you', 'running', 'elsewhere', 'waiting', 'not-admitted', 'discharged'])
  const by = Object.fromEntries(lanes.map(l => [l.lane, l]))
  expect(by['needs-you'] && drawn(by['needs-you'])).toEqual(['0:10', '1:11', '2:pr-7'])
  expect(by.running && drawn(by.running)).toEqual(['0:10', '1:12'])
  expect(by.waiting && drawn(by.waiting)).toEqual(['0:10'])
  expect(lanes.map(l => l.count)).toEqual([1, 1, 0, 1, 0, 1])
  expect(lanes.map(l => l.isCollapsed)).toEqual([false, false, false, false, true, true])
  // Another workflow's copies stay on its own tab.
  expect(paneLanes(VIEW, 'fastlane').find(l => l.lane === 'waiting')?.rows.map(r => r.row.id)).toEqual(['20'])
})

test('the cycle guard is per lane, never shared across lanes', async () => {
  const looped = row('30', { page: 'w', lane: 'waiting' })
  looped.children = [looped]
  const view: BoardView = { needsYou: 0, workflows: [{ id: 'w', name: 'W', needsYou: 0 }], rows: [looped, { ...looped, lane: 'running' }] }
  const lanes = paneLanes(view, 'w')
  expect(lanes.find(l => l.lane === 'running')?.rows.map(r => r.row.id)).toEqual(['30'])
  expect(lanes.find(l => l.lane === 'waiting')?.rows.map(r => r.row.id)).toEqual(['30'])
})

test('a tab title carries its count, and none at zero', async () => {
  expect(paneTitle('Needs You', 2)).toBe('Needs You · 2')
  expect(paneTitle('Fastlane', 0)).toBe('Fastlane')
})

test('a pane id keeps to the letters a pane id may hold', async () => {
  expect(paneId(null)).toBe('needs-you')
  expect(paneId('full-cycle')).toBe('wf-full-cycle')
  expect(paneId('a.b c')).toBe('wf-a_b_c')
  expect(paneId('x'.repeat(80)).length).toBe(64)
})

test('the second line is the stage and the note, either alone when the other is missing', async () => {
  expect(subtitleOf(row('1', { stage: 'build', note: 'round 2' }))).toBe('build · round 2')
  expect(subtitleOf(row('1', { stage: 'build', note: '' }))).toBe('build')
  expect(subtitleOf(row('1', { stage: null, note: 'waiting on #5' }))).toBe('waiting on #5')
})

test('an arrival is an id newly needing you, never on the first read', async () => {
  const before = needingIds(VIEW.rows, null)
  expect(before).toEqual(['11'])
  expect(arrivals(null, before)).toEqual([])
  const later: BoardRow[] = [...VIEW.rows, row('40', { page: null, lane: 'needs-you', badge: 'needs-you' })]
  expect(arrivals(before, needingIds(later, before))).toEqual(['40'])
})

test('a needs-you read from stale labels, or held elsewhere, is no arrival', async () => {
  const stale = [row('50', { page: null, lane: 'needs-you', badge: 'needs-you', stale: true })]
  expect(needingIds(stale, [])).toEqual([])
  // #11 needed you and is only held elsewhere now: still needing, so its return is not new.
  const held = [row('11', { page: 'full-cycle', lane: 'elsewhere', badge: 'elsewhere' })]
  const kept = needingIds(held, ['11'])
  expect(kept).toEqual(['11'])
  expect(arrivals(kept, needingIds(VIEW.rows, kept))).toEqual([])
})

test('the command option splits on spaces, then port is appended', async () => {
  expect(argvOf('landrace')).toEqual(['landrace', 'port'])
  expect(argvOf('  node  dist/cli.js ')).toEqual(['node', 'dist/cli.js', 'port'])
  expect(argvOf('   ')).toEqual(['landrace', 'port'])
})

test('port: exit 0 is the URL, exit 1 offline with the reason, an unknown command an older binary', async () => {
  const ran = (exitCode: number, stdout: string, stderr: string) => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  expect(readPort(ran(0, 'http://127.0.0.1:4545\n', ''))).toEqual({ kind: 'live', url: 'http://127.0.0.1:4545' })
  expect(readPort(ran(1, 'offline\n', 'landrace port: the recorded pid 9 is gone\n'))).toEqual({ kind: 'offline', reason: 'the recorded pid 9 is gone' })
  expect(readPort(ran(1, '', "error: unknown command 'port'\n"))).toEqual({ kind: 'no-port' })
  expect(readPort(ran(0, 'not a url\n', ''))).toEqual({ kind: 'offline', reason: 'port printed no URL: not a url' })
})

test('the status line says which condition fired', async () => {
  expect(statusLine({ kind: 'live', url: 'u' }, VIEW, 'landrace')).toBe('landrace: 1 needs you')
  expect(statusLine({ kind: 'live', url: 'u' }, { ...VIEW, needsYou: 0 }, 'landrace')).toBe(undefined)
  expect(statusLine({ kind: 'offline', reason: 'x' }, null, 'landrace')).toBe('landrace: offline')
  expect(statusLine({ kind: 'no-port' }, null, 'landrace')).toBe("landrace: no 'port' command; update landrace")
  expect(statusLine({ kind: 'not-found' }, null, 'node dist/cli.js')).toBe("landrace: 'node dist/cli.js' not found; set the command option")
})

test('the board link names localhost, which a desktop surface links and the board answers', async () => {
  expect(boardLink('http://127.0.0.1:4545')).toBe('http://localhost:4545')
  expect(boardLink('http://127.0.0.1:4545/')).toBe('http://localhost:4545/')
  expect(boardLink('https://board.example')).toBe('https://board.example')
})
