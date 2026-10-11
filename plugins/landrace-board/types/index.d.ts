/**
 * The part of landrace's `/board.json` the pane reads. The server's own
 * declaration is `BoardView` in landrace's `src/namespace.ts`; a field the
 * pane does not draw is left out here, never re-shaped.
 */
export type BoardLane = 'needs-you' | 'running' | 'elsewhere' | 'waiting' | 'not-admitted' | 'discharged'

export type BoardRow = {
  id: string
  /** `item`, or the artifact's kind: `pull-request`, `document`. */
  kind: string
  title: string
  /** http(s) or empty. */
  link: string
  /** Items only: the lane of the item's own state. */
  badge: BoardLane | null
  /** Root copies only: the lane this copy is drawn in. */
  lane: BoardLane | null
  /** Root copies only: the workflow page that draws the copy, null for Needs You. */
  page: string | null
  stage: string | null
  note: string
  /** Drawn only as the path to a match below it. */
  context: boolean
  /** The labels behind a needs-you badge predate a step this process ran. */
  stale: boolean
  chat: { prompt: string } | null
  children: BoardRow[]
}

export type BoardWorkflow = { id: string; name: string; needsYou: number }

export type BoardView = {
  /** Whether a listing has been taken yet: before it `rows` is empty because nothing was read. */
  listed: boolean
  rows: BoardRow[]
  workflows: BoardWorkflow[]
  needsYou: number
}

/** What `landrace port` said, or why it could not say. */
export type BoardReach =
  | { kind: 'live'; url: string }
  | { kind: 'offline'; reason: string }
  | { kind: 'no-port' }
  | { kind: 'not-found' }

/** The pane's one value: the last view, whether it is live, and when it was last read. */
export type BoardState = {
  view: BoardView | null
  reach: BoardReach | null
  /** Whether the last `/board.json` read succeeded. */
  isLive: boolean
  /** When `view` was read, epoch ms; null before the first good read. */
  readAt: number | null
  /** Ids that needed the person at the last read; null before the first. */
  needing: string[] | null
}

declare module 'claude-code' {
  interface PluginState {
    'landrace-board': {
      board: BoardState
      /** `<page>:<lane>` of each lane the person opened or closed against its default. */
      toggled: string[]
    }
  }
}
