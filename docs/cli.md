# Command line

Landrace is one command, `landrace`, with eight subcommands. Each but `init`, `version` and `update` takes the **workspace** — the `.landrace/` folder holding `landrace.yaml`, the workflows and the hooks. Every one of those but `next`, which requires it, defaults to `.landrace` in the current folder.

```text
landrace init     <name>
landrace validate [dir]
landrace status   [-w, --workspace <dir>]
landrace start    [-w, --workspace <dir>] [--once] [--debug] [--ui-port <port>] [--no-ui]
                  [--telemetry] [--otel KEY=VALUE]...
landrace next     -w, --workspace <dir> [--workflow <id>] -s, --snapshot <file>
landrace mcp      [-w, --workspace <dir>] [--workflow <id>]
                  [--child <parent> --stage <stage> --round <round>]
landrace version
landrace update
```

`landrace --version` prints the version alone.

Every subcommand but `init` and `next` imports the project's TypeScript hook modules. Node 22.18 and newer read them unflagged; on an older Node 22, `landrace` re-runs itself once with `--experimental-strip-types` and says so. A command that fails prints `landrace <command>: <reason>` and exits 1, never a stack trace.

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
landrace start [-w, --workspace <dir>] [--once] [--debug] [--ui-port <port>] [--no-ui] [--telemetry] [--otel KEY=VALUE]...
```

Watches the tracker and advances every item a workflow claims. It runs a **tick** every `tick.interval`: each tick lists every workflow's source, then works the claimed items, most urgent first. `tick.concurrency` bounds the agents running at once across the whole workspace, overlapping ticks and every workflow included. [Configuration](configuration.md#landraceyaml) says when a tick leaves an item for a later one.

As it starts, it asks npm whether a newer Landrace is out and, if one is, prints one line to stderr naming it — see [Checking for a newer version](#checking-for-a-newer-version).

| Flag | Meaning |
|---|---|
| `-w, --workspace <dir>` | The workspace. Default `.landrace` |
| `--once` | Run a single tick and exit. Serves no board |
| `--debug` | Print every event, including the agent process's own output and the snapshot behind each decision, so you can watch a decision before it becomes a write |
| `--ui-port <port>` | The board's port. Default `4545` |
| `--no-ui` | Serve no board |
| `--telemetry` | Export every event to an OpenTelemetry collector (sets `LANDRACE_ENABLE_TELEMETRY=1`) |
| `--otel KEY=VALUE` | Set one telemetry variable, over `.env` and the shell. Repeatable. See [Configuration](configuration.md#telemetry) |

Before the first tick, `start` loads the configuration and every workflow, runs `validate`'s checks with a few differences ([listed there](validate.md#what-start-checks-differently)), runs each hook's preflight — the GitHub integration's checks the token's permissions — and resolves the executors and their MCP servers. Any problem refuses to start, naming it.

Ticks overlap: the lock is per item, so an item busy with a ten-minute agent run delays only itself. **A step run spends real money**, and the round caps are the `$lt` counters in your workflow, not something the engine imposes. The first time, escalate: `validate`, then `status`, then `start --once --debug`, then `start`.

Ctrl-C stops: nothing new starts, agent runs in flight are cancelled, and the locks are released as it exits. Press it twice to stop at once; the locks this process holds are left behind, and since they name its process id, the next run reclaims them.

Locks, worktrees and the wake file live under `$TMPDIR/landrace/<repo>/`.

### Stopping a running step

To stop a step while it runs, close its item or take its admit label (`lr:auto` in this repository) off it — from an MCP client, `landrace_update_item` with `state: closed`. The next tick that lists the item kills the agent's process group and logs `item.aborted`. The stopped round writes nothing to the item, so putting the label back runs that same round again. An item the tracker stops listing is left running.

### The board

`start` serves a **board**, the triage page, at `http://127.0.0.1:4545/`. It shows every candidate item, with its sub-items and pull requests nested beneath it, in lanes:

- **Needs you** — an item at a `waits: person` stage, and every halt;
- **Agent running** — an agent this process started is running on it;
- **Held elsewhere** — held outside this process: a person's pairing, an MCP conversation, another instance;
- **Waiting**;
- **Not admitted** and **Done**, collapsed.

It costs no tracker calls: it polls the process every two seconds and shows what the tick already fetched and what the process knows is running. `--ui-port` moves it, `--no-ui` turns it off, and `--once` never serves it. It binds loopback only and answers only its own host name.

**Pages.** A sidebar lists *Needs You*, then each workflow by name (case-folded, then id); under 640 px it is a row of chips. The top bar, with the tick controls, stays at the top of the window while the list scrolls. From 640 px up the sidebar stays just below it, and scrolls on its own when it is taller than the space left; under 640 px it scrolls away with the list. `#/` is Needs You, `#/w/<id>` a workflow, and either takes `?item=<id>` to open that item's panel. Old `#item=<id>` links still open the panel on Needs You, and a workflow the board no longer has shows Needs You. Moving between pages clears the panel's item.

- **Needs You** is the home page: one lane across every workflow. With more than one workflow, each row is tagged with its workflow's name, except a conflict or a clash, whose note names the workflows involved. The sidebar and the browser tab count its branches — `(3) Landrace`. Empty, it shows a stack of ticked checklist cards and "You're all set!"; a search that matches nothing says "Nothing matches."; before the first listing has landed it says "Listing…".
- **A workflow page** draws every lane for that workflow's own items. A branch appears on every workflow page any of its rows belongs to, in its most urgent row's lane; the sidebar's count and rose dot count only that workflow's own rows. A conflict is on the page of each workflow that claims it, and a clash on the page of each workflow whose source reports the id. Not admitted lists what the workflow's source sees and nobody claims. A closed item shows on the pages whose `eligible` rule admits it — or, when none does, on every page whose source lists it.

**Order.** A branch sits in the lane of its most urgent item, so a sub-item that needs you lifts its whole branch into Needs you, opened down to it. Needs you is a queue: by priority, `P0` first and unprioritised last, then whoever has waited longest. Every other lane is newest first. Both go by when the source says the item or pull request last changed; a row with no time goes last. A branch's rows follow its lane's order, and a branch is placed by its root. Done holds what the source lists as closed; the GitHub integration lists an item Landrace moved (one with an `lr:stage:*` label) for 30 days after it closes.

**Rows.** Each pull request and document shows what it is, its state — a pull request's glyph is green while open, purple once merged, red once closed — and how long ago it was opened. A search box filters by title or id, and Collapse all / Expand all set every branch at once. An item a security check stopped shows a shield beside its badge and the note "blocked by a security check"; the reason is in the item's comments.

**The panel.** From 640 px up the panel is always open on the right and the board keeps room for it, so the rows never move. With no item selected it says "Select an item to see its details"; opening a row shows that item. ✕, Escape, Back, a click on the board's empty space, or the item leaving the board clears it again. Under 640 px it covers the screen and shows only while an item is open. An item's Related list names each relationship the item has to another item, of any type and either way — `blocked-by →` and `#10`, its title and its state: open, done, dropped, or unreadable where the tracker said which item it is but not what state it is in. Where the tracker keeps a status for the related item, as Jira does, the status shows in place of open, done or dropped. Pull requests and spec pages are under Artifacts. Above the list, what the tracker reports of the item's relationships, in words — "Not all of its related items could be read", "In a dependency cycle".

- A clash has no panel, since a read of an id two trackers report cannot tell which to ask; opened from a link, it shows its number, title and note, and offers nothing. A conflict keeps a read-only panel.
- A read-only workflow's items offer no writes.

**Writes.** Every row has one menu, opened by its "⋯". Its writes come first, where the server offered any:

- **Retry** — first in a blocked or screened item's menu — sends the item back to the step whose failure put it there.
- **Go to step…** — on any open item whose agent is not running and whose stage lists a goto — sends it back to a step its stage names.
- **Clear & retry** — on a screened item only — is a Retry that also clears the refused step's next round of the security check. See [Security](security.md#clearing-a-refused-step).

Each asks first, then writes the same goto record `landrace_goto` does, after reading the item afresh; an item that has moved on, a step its stage does not list, or one past its cap is refused in a sentence the menu shows. Top right are a countdown to the next tick and **Run next tick now**, which starts a tick — or, while one is running, says "queued" and runs one once every tick in flight has ended. The icon-only **Refresh** button re-reads the tracker and reloads the board, one listing and nothing more.

**Chat.** Below the writes, the menu's "Chat" entries open a chat about that item, over the Landrace MCP, in Claude Code (`claude://`, the desktop app's Code tab), Claude Code (CLI) (`claude-cli://`, a terminal running `claude`), Cursor or Codex, plus a "Copy prompt" entry. Each only pre-fills the prompt; nothing is sent on its own. Cursor's link opens in whatever window is active. The CLI's link handler registers itself only after you have run an interactive `claude` session once.

**The panel's writes.** At the panel's foot, a box takes your words for three writes, each the board's form of an [operator tool](#the-operator-tools):

- **Reply** (Ctrl+Enter or ⌘+Enter) posts them as your comment, as `landrace_reply` does. It wakes no tick.
- **Ask the step** asks first, then resumes the step's session with them, as `landrace_ask` does — a paid agent turn.
- **Resolve** hands the item back, as `landrace_resolve` does, with the default reply.

**Pairing…**, in the row's menu and the panel's own "⋯", opens the panel's Pairing section: what may be paired on, or the pairing open now. **Pair on `<stage>`** (or **Continue `<stage>` together**) asks first, then holds that step's round for you and shows the command to run, as `landrace_pair` does. With a pairing open, **Finish…** asks for an optional note and hands the work in — a paid agent turn — and **Release** asks first and gives the step back to the agent, as `landrace_finish` and `landrace_release` do.

How every one of these writes is guarded against other websites is in [Security](security.md#the-board).

**Notifications.** The 🔔 beside the theme toggle turns on browser notifications, remembered per browser. With it on, each item that has come into Needs you since the last poll raises one notification — "#29 needs you", with the title and why — and clicking it opens that item's panel. Opening the page announces nothing that was already waiting. If the browser has blocked notifications, the bell turns to 🔕 and says so.

The page follows the system's light or dark preference, or whatever you last toggled, with no flash on load.

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
| `landrace_waiting` | Lists the board's Needs you: items at a `waits: person` stage, and the halts — blocked, screened, a conflict, a clash. A closed item is never waiting. Takes `workflow` like `landrace_items` |
| `landrace_status` | Shows an item's workflow, its position, which rounds have run, and whose turn it is (`waitingOnYou`, by the same rule). An item no one workflow claims is shown with `workflow: null` and why |
| `landrace_create_item` | Opens an item: `title`, `body`, `labels`, `start`, `relate`, and `workflow` — required when more than one workflow can create items. By default it adds the workflow's `admit` labels, so the next tick starts work; `start: false` files it without starting anything |
| `landrace_update_item` | Changes an item's `title`, `body`, `state` (`open` or `closed`) or labels (`addLabels`, `removeLabels`), and its relationships (`relate`, `unrelate`). Removing the admit label stops further work |
| `landrace_reply` | Posts a comment as you — approve the work, or ask for changes — exactly as if you had typed it on the tracker |
| `landrace_goto` | Sends an item back to a step its stage lists, within its cap. The step re-runs on the next tick |
| `landrace_clear` | Overrules the security check on a screened item: the refused step's next round runs unscreened, once. With `stage`, it sends the item to that stage instead — one its stage lists, within its cap, as `landrace_goto` — and that stage's next round runs unscreened |
| `landrace_ask` | Answers a step's open questions, or asks it something, by resuming the step's own session. Records both halves on the item and returns the reply. A turn takes 5–70 seconds. The workflow stays where it is until `landrace_resolve` |
| `landrace_resolve` | Hands the item back: `why` (by default, that the questions are answered) is posted as your reply, and the workflow's next step reads it on the next tick |
| `landrace_pair` | Works a step together with the agent in your own terminal. Without `stage`, lists what may be paired on and any open pairing. With it, holds that step's round for you — the agent never runs it alone meanwhile — and returns the command to run |
| `landrace_finish` | Hands a pairing's work in: the paired session is asked for the step's answer, which is recorded as yours (`run.lastOutputBy: pair`) and moves the item on. Anything left uncommitted in the pairing's checkout is listed and discarded |
| `landrace_release` | Gives a paired step back to the agent: the pairing ends, its checkout is removed, and the agent runs the step on the next tick |

**Routing.** Every tool that takes an item id resolves the workflow by the item's claim. A tool that writes a workflow's state (`landrace_reply`, `landrace_goto`, `landrace_ask`, `landrace_pair` with a stage, …) refuses an item no workflow claims or two do, and refuses while any tracker cannot list. A read (`landrace_status`, `landrace_pair` without a stage) is refused only for an id two trackers report. With one tracker, a tool about one item reads that item rather than listing the tracker.

**Edits.** `landrace_update_item` is an edit, as on the tracker — a workflow's admit labels included, so taking `lr:auto` off stops an item and taking `lr:fast` off sends a fastlane item to full-cycle. The engine's own labels — `lr:working`, `lr:awaiting`, `lr:blocked`, `lr:screened` and every `lr:stage:*` — are refused, there and in `landrace_create_item`. An item no one workflow claims is edited through the one operator every workflow that could claim it shares, and refused, naming them, when they edit through different ones. How `relate` and `unrelate` are checked is in [Workflows](workflows.md#relating-items).

**Waking the loop.** Every write — reply, goto, clear, ask, resolve, create or update — wakes `landrace start`, so a person does not wait out the interval. The MCP server is a separate process: it touches a `wake` file beside the locks, and `start` checks that file every second. On the board, Retry, Clear & retry, "Go to step…" and every panel write but Reply wake it too.

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
