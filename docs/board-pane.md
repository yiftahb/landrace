# The board in a Claude Code pane

`landrace-board` is a Claude Code plugin that shows your project's board in a pane beside the chat: Needs You first, then one tab per workflow. Installed once, at user scope, it works in every project. Each session finds the `landrace start` running for its own folder and shows that board, or says it is offline.

It reads the same `/board.json` the [board](cli.md#the-board) page draws from, and writes nothing. Reply, Resolve, Go to step and the other writes stay on the board page and the [operator tools](cli.md#the-operator-tools).

The plugin lives in this repository, in `plugins/landrace-board/`, and is not part of the npm package. Claude Code's plugin API is in early access, so a Claude Code release can change what the plugin relies on.

## Install

You need a `landrace` that has the [`port`](cli.md#landrace-port) command. The plugin was built and tested against Claude Code 2.1.295. At the prompt of a Claude Code session in a terminal, type:

```text
/plugin install landrace-board --marketplace yiftahb/landrace
```

Answer `y` to add the marketplace, then pick the user scope so it loads in every project. The install asks for one option, `command`, which you can leave at its default.

## The command option

The plugin runs `<command> port` in the session's folder to find the board. `command` is split on spaces, and `port` is appended. The default, `landrace`, suits a global install. In a checkout of Landrace itself, set it to `node dist/cli.js`.

## Use

Type `/board` to open the panes. Nothing opens on its own when a session starts. In the terminal's fullscreen layout the panes dock beside the transcript; otherwise they sit above the prompt.

- **Tabs.** One tab per page of the board's sidebar: `Needs You`, then each workflow by name. Each tab's title carries its count of items that need you, as in `Needs You · 2` or `Full cycle · 1`, and no count at zero. A workflow that appears on the board opens its tab while the panes are open, once the terminal is wide enough for Claude Code to place a pane nobody asked for, and one that leaves closes it. A tab you close stays closed until you type `/board` again.
- **Lanes.** Needs You shows only its own lane. A workflow tab shows every lane, in the board's order: Needs you, Agent running, Held elsewhere, Waiting, Not admitted and Done. Not admitted and Done start collapsed; press a lane's header to open or close it. A lane's count is the items filed in it, as on the board.
- **Rows.** Each item is `#<id> <title>`, then its stage and note. Its pull requests and documents sit under it, each linked where it has a link. A parent whose children are in several lanes appears in each of those lanes, with only that lane's children, exactly as the board draws it. A parent shown only as the path to its children is dimmed and offers nothing.
- **Actions.** On an item's own row, `Open ↗` opens it in its tracker, and `Chat here` puts the board's chat prompt for that item in your prompt box. Nothing is sent until you send it. `Board ↗`, at the top of each tab, opens the full board in your browser.

The plugin reads the board every 5 seconds. Until the first tick has listed the tracker, the pane says "Waiting for the first tick…". A read that fails, or gives no answer within 10 seconds, keeps the last rows on screen, dimmed, under "stale since HH:MM", and asks `port` again at once.

## Signals

The status line under the prompt says one of:

- `landrace: <n> needs you`, cleared when nothing needs you;
- `landrace: offline`, when `port` says the board is offline. The pane shows the reason, and the plugin asks again every 30 seconds;
- `landrace: no 'port' command; update landrace`, when the `landrace` it runs predates `port`;
- `landrace: '<command>' not found; set the command option`, when the command cannot start.

A toast says when an item newly needs you, as in `landrace: #40 needs you: Pick a name`. The first read of a session announces nothing that was already waiting. As on the board, an item that needed you and is only held elsewhere for a moment does not count as new.

## Limits

- Only the session's own board. Another project's `landrace start` is not shown.
- The pane draws rows, not the board page itself. The item panel, search and the writes are on the board page.
- The desktop app links only `https:` and `http://localhost` addresses, and draws any other as plain text. `port` names `127.0.0.1`, so `Board ↗` links `localhost` in its place. The board answers both.
