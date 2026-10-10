# Command line

Landrace is one command, `landrace`, with nine subcommands. Each but `init`, `version` and `update` takes the **workspace** — the `.landrace/` folder holding `landrace.yaml`, the workflows and the hooks. Every one of those but `next`, which requires it, defaults to `.landrace` in the current folder.

```text
landrace init     <name>
landrace validate [dir]
landrace status   [-w, --workspace <dir>]
landrace start    [-w, --workspace <dir>] [--once] [--debug] [--ui-port <port>] [--headless]
                  [--telemetry] [--otel KEY=VALUE]...
landrace port     [-w, --workspace <dir>]
landrace next     -w, --workspace <dir> [--workflow <id>] -s, --snapshot <file>
landrace mcp      [-w, --workspace <dir>] [--workflow <id>]
                  [--child <parent> --stage <stage> --round <round>]
landrace version
landrace update
```

`landrace --version` prints the version alone.

`validate`, `status`, `start` and `mcp` import the project's TypeScript hook modules. Node 22.18 and newer read them unflagged; on an older Node 22, `landrace` re-runs itself once with `--experimental-strip-types` and says so. A command that fails prints `landrace <command>: <reason>` and exits 1, never a stack trace.

A hook's `landrace/*` imports resolve to the copy of Landrace that is running ([Hook modules](hooks.md#hook-modules)). Inside this repository that copy is the built `dist/` only when this checkout's own CLI runs, as `node dist/cli.js`: run `pnpm build` after pulling and before any of these commands. A global `landrace` run here loads its own copy instead, whatever `dist/` holds, so `pnpm build` changes nothing for it. A hook newer than the copy fails to import: the error says to rebuild when the copy is a checkout, and to update Landrace when it is an installed one.

## landrace init

```text
landrace init <name>
```

Creates the workflow `<name>` under `.landrace/workflows/<name>/` in the current folder: a commented `workflow.yaml` with one entry stage that admits items labelled `lr:<name>`, and an empty `steps/`. Where `.landrace/` does not exist yet, it also writes a commented `landrace.yaml` and adds `.landrace/.env` to `.gitignore` unless git already ignores it. It never overwrites: an existing workflow folder is refused, and so is a `<name>` that is not a usable workflow id or whose label the engine writes itself. It prints each file it created and what to do next — including, when `landrace.yaml` has a `workflows:` list, adding `<name>` to it, which `init` never edits.

## landrace validate

```text
landrace validate [dir]
```

Proves every workflow in the workspace `dir` (default `.landrace`) sound, and exits 1 if not. It reads and imports, and writes nothing. Every check it runs is in [What `landrace validate` checks](validate.md).

## landrace status

```text
landrace status [-w, --workspace <dir>]
```

Prints one line per listed item — `#<id>  <stage>  <title>  <note>`, with the workflow beside the id (`#12 [fastlane]`) when the workspace has several. The note says what the item waits on, or why it was skipped or stopped:

- `skipped: <reason>` — the workflow's own `else` reason, for an item its `eligible` rules turn away;
- `blocked: needs a human` — an item labelled `lr:blocked`;
- `blocked by a security check` — one a security check stopped;
- `halted: <why>` — a halt the engine finds itself: two `lr:stage:*` labels, an item two stages place, an item no stage places in a workflow with no entry stage, a conflict (two workflows claim it) or a clash (two sources report it);
- `error: <message>` — an `identity` that cannot be evaluated, such as one using an operator outside the allowlist.

`status` runs no agent, writes nothing, checks no token and exports no telemetry, so it is the safe way to see what Landrace thinks of your items. It needs no `.mcp.json`.

## landrace start

```text
landrace start [-w, --workspace <dir>] [--once] [--debug] [--ui-port <port>] [--headless] [--telemetry] [--otel KEY=VALUE]...
```

Watches the tracker and advances every item a workflow claims. It runs a **tick** every `tick.interval`: each tick lists every workflow's source, then checks each claimed item once, most urgent first. An agent a tick starts runs on after its checks end, and a tick that starts while an earlier one is still checking is skipped. `tick.concurrency` bounds the agents running at once across the whole workspace, overlapping ticks and every workflow included; checking an item takes no slot. [Configuration](configuration.md#landraceyaml) says what happens to a step when no slot is free.

As it starts, it asks npm whether a newer Landrace is out and, if one is, prints one line to stderr naming it — see [Checking for a newer version](#checking-for-a-newer-version).

| Flag | Meaning |
|---|---|
| `-w, --workspace <dir>` | The workspace. Default `.landrace` |
| `--once` | Run a single tick and exit. Serves no board |
| `--debug` | Print every event, including the agent process's own output and the snapshot behind each decision, so you can watch a decision before it becomes a write |
| `--ui-port <port>` | The board's port. Default `4545` |
| `--headless` | Serve no board and open no browser. `--no-ui` is an older name for it |
| `--telemetry` | Export every event to an OpenTelemetry collector (sets `LANDRACE_ENABLE_TELEMETRY=1`) |
| `--otel KEY=VALUE` | Set one telemetry variable, over `.env` and the shell. Repeatable. See [Configuration](configuration.md#telemetry) |

Before the first tick, `start` loads the configuration and every workflow, runs `validate`'s checks with a few differences ([listed there](validate.md#what-start-checks-differently)), runs each hook's preflight — the GitHub integration's checks the token's permissions — and resolves the executors and their MCP servers. Any problem refuses to start, naming it. A start that serves a board also refuses when another start already serves this workspace's board, naming its URL and process id; a record a crashed start left behind does not block it ([landrace port](#landrace-port)).

Ticks overlap: the lock is per item, so an item busy with a ten-minute agent run delays only itself. **A step run spends real money**, and the round caps are the `$lt` counters in your workflow, not something the engine imposes. The first time, escalate: `validate`, then `status`, then `start --once --debug`, then `start`.

Ctrl-C stops: nothing new starts, agent runs in flight are cancelled, and the locks are released as it exits. Press it twice to stop at once; the locks this process holds are left behind, and since they name its process id, the next run reclaims them.

Locks, worktrees, the wake file and the board's record live under `$TMPDIR/landrace/<repo>/`.

### Stopping a running step

To stop a step while it runs, close its item or take its admit label (`lr:auto` in this repository) off it — from an MCP client, `landrace_update_item` with `state: closed`. The next tick that lists the item kills the agent's process group and logs `item.aborted`. The stopped round writes nothing to the item, so putting the label back runs that same round again. An item the tracker stops listing is left running.

### The board

`start` serves a **board**, the triage page, at `http://127.0.0.1:4545/`, and opens it in your default browser once, when its output is a terminal. A start under a supervisor, in CI or with its output piped serves the board and opens nothing. A browser that fails to open prints `landrace: could not open a browser (<reason>); the board is at <url>`, and the start carries on. The board shows every candidate item, with its sub-items and pull requests nested beneath it, in lanes:

- **Needs you** — an item at a `waits: person` or `waits: pairing` stage, and every halt;
- **Agent running** — an agent this process started is running on it;
- **Held elsewhere** — held outside this process: a person's pairing, an MCP conversation, another instance;
- **Waiting**;
- **Not admitted** and **Done**, collapsed.

It costs no tracker calls: it polls the process every two seconds and shows what the tick already fetched and what the process knows is running. `--ui-port` moves it, `--headless` turns it off, and `--once` never serves it. It binds loopback only and answers only its own host name.

**Before the first tick.** Until the first tick has listed the tracker, a spinner covers every page with "Waiting for the first tick…", and nothing behind it takes a click or keyboard focus. It goes once the first listing reaches the board and does not come back while the page stays open; later ticks show the last listing as before. If the first listing fails, the spinner stays, and the terminal running `landrace start` says why.

**Pages.** A sidebar lists *Needs You*, then each workflow by name (case-folded, then id); under 640 px it is a row of chips. The top bar, with the tick controls, stays at the top of the window while the list scrolls. From 640 px up the sidebar stays 1.5rem below it, the same gap it has before you scroll, and scrolls on its own when it is taller than the space left; under 640 px it scrolls away with the list. `#/` is Needs You, `#/w/<id>` a workflow, and either takes `?item=<id>` to open that item's panel. Old `#item=<id>` links still open the panel on Needs You, and a workflow the board no longer has shows Needs You. Moving between pages clears the panel's item.

- **Needs You** is the home page: one lane across every workflow, holding only the items that need you, each under its parents. With more than one workflow, each row is tagged with its workflow's name, except a conflict or a clash, whose note names the workflows involved. The sidebar and the browser tab count the items that need you, never their parents — `(3) Landrace`. Empty, it shows a stack of ticked checklist cards and "You're all set!"; a search that matches nothing says "Nothing matches."
- **A workflow page** draws every lane for that workflow's own items, each under its parents. A parent from another workflow appears only as the path to them. The sidebar's count and rose dot count only that workflow's own items that need you. A conflict is on the page of each workflow that claims it, and a clash on the page of each workflow whose source reports the id. Not admitted lists what the workflow's source sees and nobody claims. A closed item shows on the pages whose `eligible` rule admits it — or, when none does, on every page whose source lists it.

**Lanes and parents.** Every item sits in the lane of its own state, with its pull requests and spec pages under it. A parent whose children are in several lanes appears in each of those lanes, and in each it shows only the children that belong there. A parent shown only for context, because it belongs to another lane or another workflow, is drawn muted, with its own state's badge. It still opens its panel; its actions are on its own row, in its own lane. A lane's count is the items filed in it, never a parent shown for context. Each lane remembers on its own which rows you collapsed. A pull request or page whose item is not listed sits in Waiting while open and in Done once closed, on every page whose source lists it.

**Order.** Needs you is a queue: by priority, `P0` first and unprioritised last, then whoever has waited longest. Every other lane is newest first. Both go by when the source says the item or pull request last changed; a row with no time goes last. A tree's rows follow its lane's order. A tree is placed among a lane's others by the first of its items filed in that lane, never by its root's own priority or time. Done holds what the source lists as closed; the GitHub integration lists an item Landrace moved (one with an `lr:stage:*` label) for 30 days after it closes.

**Rows.** Each pull request and document shows what it is, its state — a pull request's glyph is green while open, purple once merged, red once closed — and how long ago it was opened. A search box filters by title or id, and Collapse all / Expand all set every branch at once. An item a security check stopped shows a shield beside its badge and the note "blocked by a security check"; the reason is in the item's comments.

**The panel.** From 640 px up the panel is always open on the right and the board keeps room for it, so the rows never move. With no item selected it says "Select an item to see its details"; opening a row shows that item. ✕, Escape, Back, a click on the board's empty space, or the item leaving the board clears it again. Under 640 px it covers the screen and shows only while an item is open. An item's Related list names each relationship the item has to another item, of any type and either way, in the item's own words — `blocked by #10` on the blocked item and `blocks #12` on its blocker, `child of` and `parent of`, `implements` and `implemented by`, `documents` and `documented by` — with its title and its state. A relationship that reads the same from both ends, such as a Jira Relates link mapped to `relates`, is its type alone, and any other type its type and an arrow, `→` from the item and `←` to it. The state is open, done, dropped, or unreadable where the tracker said which item it is but not what state it is in. Where the tracker keeps a status for the related item, as Jira does, the status shows in place of open, done or dropped. Pull requests and spec pages are under Artifacts. Above the list, what the tracker reports of the item's relationships, in words — "Not all of its related items could be read", "In a dependency cycle".

- A clash has no panel, since a read of an id two trackers report cannot tell which to ask; opened from a link, it shows its number, title and note, and offers nothing. A conflict keeps a read-only panel.
- A read-only workflow's items offer no writes.

**Writes.** Every row has one menu, opened by its "⋯". Its writes come first, where the server offered any:

- **Start work** — on a Not admitted item — admits it to a workflow, as `landrace_admit` does. There is one entry per workflow that would then claim it alone: **Start work** when there is one, **Start work in `<name>`** for each when there are several. None is offered for a workflow that admits nothing or has no operator hook, whose tracker does not list the item, or that would leave the item claimed by another workflow or by none. It asks first, naming the workflow and the labels it adds, and says the next tick starts working the item. The server reads the item afresh before it writes, and shows a refusal in its sentence. The panel's "⋯" offers the same entries.
- **Retry** — first in a blocked or screened item's menu — sends the item back to the step whose failure put it there.
- **Go to step…** — on any open item whose agent is not running and whose stage lists a goto — sends it back to a step its stage names.
- **Clear & retry** — on a screened item only — is a Retry that also clears the refused step's next round of the security check. On a stage that waits for a pairing, that round is the next pairing, which starts and hands in unscreened. See [Security](security.md#clearing-a-refused-step).

Retry, Go to step… and Clear & retry each ask first, then write the same goto record `landrace_goto` does, after reading the item afresh; an item that has moved on, a step its stage does not list, or one past its cap is refused in a sentence the menu shows. Top right are a countdown to the next tick and **Run next tick now**, which starts a tick — or, while one is running, says "queued" and runs one once every tick in flight has ended. The icon-only **Refresh** button re-reads the tracker and reloads the board, one listing and nothing more.

**Chat.** Below the writes, the menu's "Chat" entries open a chat about that item, over the Landrace MCP, in Claude Code (`claude://`, the desktop app's Code tab), Claude Code (CLI) (`claude-cli://`, a terminal running `claude`), Cursor or Codex, plus a "Copy prompt" entry. Each only pre-fills the prompt; nothing is sent on its own. Cursor's link opens in whatever window is active. The CLI's link handler registers itself only after you have run an interactive `claude` session once.

**The panel's writes.** At the panel's foot, a box takes your words for three writes, each the board's form of an [operator tool](#the-operator-tools):

- **Reply** (Ctrl+Enter or ⌘+Enter) posts them as your comment, as `landrace_reply` does. It wakes no tick.
- **Ask the step** asks first, then resumes the step's session with them, as `landrace_ask` does — a paid agent turn.
- **Resolve** hands the item back, as `landrace_resolve` does, with the default reply.

**Pairing…**, in the row's menu and the panel's own "⋯", shows only on an item one workflow owns and may write — never on a Not admitted item, a closed one, a conflict or a read-only workflow's item. With neither Pairing… nor Start work to offer, the panel has no "⋯". Pairing… opens the panel's Pairing section: what may be paired on, or the pairing open now. **Pair on `<stage>`** (or **Continue `<stage>` together**) asks first, then holds that step's round for you and shows the command to run, as `landrace_pair` does. With a pairing open, **Finish…** asks for an optional note and hands the work in — a paid agent turn — and **Release** asks first and gives the step back to the agent, as `landrace_finish` and `landrace_release` do. At a `waits: pairing` stage, Release leaves the item waiting there for the next pairing instead: the agent never runs that step alone ([Worked only with a person](workflows.md#worked-only-with-a-person)).

How every one of these writes is guarded against other websites is in [Security](security.md#the-board).

**Notifications.** The 🔔 beside the theme toggle turns on browser notifications, remembered per browser. With it on, each item that has come into Needs you since the last poll raises one notification — "#29 needs you", with the title and why — and clicking it opens that item's panel. Opening the page announces nothing that was already waiting. If the browser has blocked notifications, the bell turns to 🔕 and says so.

The page follows the system's light or dark preference, or whatever you last toggled, with no flash on load.

## landrace port

```text
landrace port [-w, --workspace <dir>]
```

Prints the URL of the board that the `landrace start` running for this workspace serves, so a script or an editor pane that knows only the folder finds that project's own board when several projects run `landrace start` on one machine. The workspace defaults to `.landrace` in the current folder.

A start that serves a board writes a record once the board listens: its process id, the port it bound, the repository checkout the board shows, and when it started. The record lives under `$TMPDIR/landrace/<repo>/boards/`, keyed by the workspace folder's real path, never inside the working tree. A clean stop removes it. `--headless` and `--once` serve no board and write none.

`port` never trusts the record alone. It asks the board for `/board.json` on `127.0.0.1`, giving up after two seconds, and the board must answer for the record's checkout. When it does, stdout is the URL alone and the exit code is 0:

```text
http://127.0.0.1:4545
```

Otherwise stdout is `offline`, the exit code is 1, and stderr names which check failed:

- `no record for the workspace in <dir>` — no start serves its board;
- `the recorded pid <pid> is gone` — the start that wrote the record crashed or was killed;
- `port <port> does not answer` — nothing serves the port, or it gave no answer in time;
- `port <port> answers, but not with a board` — something serves the port, but its `/board.json` failed;
- `port <port> answers for another workspace, <path>` — the port now serves another project's board.

A missing workspace folder and an unreadable record are each said the same way. Two workspaces in one checkout show the same checkout on their boards, so the last check cannot tell one of their ports from the other's.

## landrace next

```text
landrace next -w, --workspace <dir> [--workflow <id>] -s, --snapshot <file>
```

Prints, as JSON, the decision and the planned effects the engine would make for a saved snapshot: `{ "decision": …, "effects": … }`. It derives the run from the snapshot's `entries` and `run.stage`, imports no hooks and does no I/O beyond reading the files, which makes it the way to test a workflow's routing by hand. With no post hooks to say what is already satisfied, the effects are the plan before reconciling. `--workflow` names the workflow, by its folder under `workflows/`, and is needed when the workspace has several.

## landrace mcp

```text
landrace mcp [-w, --workspace <dir>] [--workflow <id>]
```

Runs Landrace's **operator server**: an MCP server over stdio, through which an editor's agent reads and drives items. `--workflow <id>` scopes it to one workflow — it lists, creates and acts for that workflow alone, and says so in each tool's description.

Like `start`, it runs each hook's preflight before anything else, reads `.landrace/.env` and the shell for telemetry, and refuses `OTEL_LOGS_EXPORTER=console`, which would write into its protocol.

### Connecting an editor

This repository defines the server in `.agsync/mcp/landrace.yaml`, and [agsync](https://github.com/yiftahb/agsync) writes it out per agent — `.mcp.json` for Claude Code, `.codex/config.toml` for Codex:

```bash
agsync sync
```

The generated files are gitignored, so run it after cloning. Then ask your client things like *"what's waiting on me?"*, *"open an item for CSV export"*, or *"reply on #12 that the scope is too broad"*.

### The operator tools

| Tool | What it does |
|---|---|
| `landrace_workflows` | Lists the workspace's workflows: `id`, `name`, `description`, `claimed`, `needsYou`, and `creates` — whether `landrace_create_item` can start an item in it |
| `landrace_items` | Lists every open item a workflow claims, with its workflow, stage and lane, and every item no one workflow may work because two claim it or two trackers report it, with why. An item every workflow turned away is not listed. `workflow` narrows it to one workflow's items and the halts it is party to |
| `landrace_waiting` | Lists the board's Needs you: items at a `waits: person` or `waits: pairing` stage, and the halts — blocked, screened, a conflict, a clash. A closed item is never waiting. Takes `workflow` like `landrace_items` |
| `landrace_status` | Shows an item's workflow, its position, which rounds have run, and whose turn it is (`waitingOnYou`, by the same rule). An item no one workflow claims is shown with `workflow: null` and why |
| `landrace_create_item` | Opens an item: `title`, `body`, `labels`, `start`, `relate`, and `workflow` — required when more than one workflow can create items. By default it adds the workflow's `admit` labels, so the next tick starts work; `start: false` files it without starting anything |
| `landrace_admit` | Starts work on a Not admitted item: `item` and `workflow`, both required. Adds the workflow's `admit` labels the item lacks, so the next tick works it, and answers `{ item, workflow, labels }` with the labels it added. It first predicts the claim with those labels added, and refuses, writing nothing, unless that workflow alone would claim the item. It also refuses an item that is closed, already in a workflow, claimed by two or reported by two trackers, or not listed by the workflow's tracker, and a workflow that admits nothing. It never removes a label. An item that ran in the workflow before keeps its `lr:stage:*` label, so it resumes at the stage it stopped at |
| `landrace_update_item` | Changes an item's `title`, `body`, `state` (`open` or `closed`) or labels (`addLabels`, `removeLabels`), and its relationships (`relate`, `unrelate`). Removing the admit label stops further work |
| `landrace_reply` | Posts a comment as you — approve the work, or ask for changes — exactly as if you had typed it on the tracker |
| `landrace_goto` | Sends an item back to a step its stage lists, within its cap. The step re-runs on the next tick, unless its stage waits for a pairing: then the item waits there for one |
| `landrace_clear` | Overrules the security check on a screened item: the refused step's next round runs unscreened, once. With `stage`, it sends the item to that stage instead — one its stage lists, within its cap, as `landrace_goto` — and that stage's next round runs unscreened. On a stage that waits for a pairing, that round is its next pairing |
| `landrace_ask` | Answers a step's open questions, or asks it something, by resuming the step's own session. Records both halves on the item and returns the reply. A turn takes 5–70 seconds. The workflow stays where it is until `landrace_resolve` |
| `landrace_resolve` | Hands the item back: `why` (by default, that the questions are answered) is posted as your reply, and the workflow's next step reads it on the next tick |
| `landrace_pair` | Works a step together with the agent in your own terminal. Without `stage`, lists what may be paired on and any open pairing. With it, holds that step's round for you — the agent never runs it alone meanwhile — and returns the command to run |
| `landrace_finish` | Hands a pairing's work in: the paired session is asked for the step's answer, which is recorded as yours (`run.lastOutputBy: pair`) and moves the item on. Anything left uncommitted in the pairing's checkout is listed and discarded |
| `landrace_release` | Gives a paired step back to the agent: the pairing ends, its checkout is removed, and the agent runs the step on the next tick. At a `waits: pairing` stage the item waits there for the next pairing instead |

**Routing.** Every tool that takes an item id resolves the workflow by the item's claim. A tool that writes a workflow's state (`landrace_reply`, `landrace_goto`, `landrace_ask`, `landrace_pair` with a stage, …) refuses an item no workflow claims or two do, and refuses while any tracker cannot list. A read (`landrace_status`, `landrace_pair` without a stage) is refused only for an id two trackers report. With one tracker, a tool about one item reads that item rather than listing the tracker.

**Edits.** `landrace_update_item` is an edit, as on the tracker — a workflow's admit labels included, so taking `lr:auto` off stops an item and taking `lr:fast` off sends a fastlane item to full-cycle. The engine's own labels — `lr:working`, `lr:awaiting`, `lr:blocked`, `lr:screened` and every `lr:stage:*` — are refused, there and in `landrace_create_item`. An item no one workflow claims is edited through the one operator every workflow that could claim it shares, and refused, naming them, when they edit through different ones. How `relate` and `unrelate` are checked is in [Workflows](workflows.md#relating-items).

**Waking the loop.** Every write — reply, goto, clear, ask, resolve, create, admit or update — wakes `landrace start`, so a person does not wait out the interval. The MCP server is a separate process: it touches a `wake` file beside the locks, and `start` checks that file every second. On the board, Start work, Retry, Clear & retry, "Go to step…" and every panel write but Reply wake it too.

### The child server

```text
landrace mcp --workspace <dir> --workflow <id> --child <parent> --stage <stage> --round <round>
```

The runner starts this itself, beside the agent of a step that declares `items:create`. It serves exactly one tool, `landrace_create_child`, bound on its command line to the parent item, the creating stage and round, and the workflow. `--child` needs `--stage`, `--round` and `--workflow`. See [Workflows](workflows.md#splitting-work-into-sub-items).

## landrace version

```text
landrace version
```

Prints `landrace <version>`, then what npm has: a newer version and how to get it, "This is the latest version.", or that npm gave no latest version to compare with.

## landrace update

```text
landrace update
```

Updates the copy of Landrace that is running to the latest version on npm. That copy is the one a hook's `landrace/*` imports resolve to ([Hook modules](hooks.md#hook-modules)), so:

- When the running copy is the current folder's own — the real path of `node_modules/landrace` is the running package — and the folder's `package.json` lists `landrace`, it updates that dependency with the package manager the folder's lockfile names: `pnpm add -D landrace@latest`, `yarn add -D landrace@latest` or `npm install --save-dev landrace@latest` (without `-D` for a runtime dependency). Two lockfiles in one folder are refused, naming both: run the update with your package manager yourself.
- Otherwise it updates the global install: `npm install -g landrace@latest`. That is the usual case, and it holds even when the folder's `package.json` lists `landrace` as well.

It prints the command before running it, and runs nothing when this is already the latest version. When the command fails, it says so and names it, to run by hand.

### Checking for a newer version

`landrace start` and `landrace version` ask npm's registry for the latest version (`https://registry.npmjs.org/landrace/latest`). It is the one request Landrace makes that no hook asked for. The check sends nothing about your project, gives up after two seconds, and never fails the command it runs beside. `landrace mcp` never checks, because its stdout is the MCP protocol.

It is off in CI (when `CI` is set) and when `LANDRACE_NO_UPDATE_CHECK` is set to anything but `0`.
