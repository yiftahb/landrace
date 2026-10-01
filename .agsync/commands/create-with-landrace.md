---
description: File an idea from this conversation as a Landrace item, through the orchestrator rather than the tracker
argument-hint: "[what to file] [no-start]"
---

File an item through Landrace's own `landrace_create_item` MCP tool: $ARGUMENTS

Never create the issue with `gh` or a tracker API directly. The tool goes
through the project's operator hook, which creates, labels and links the
item the way the orchestrator reads it back. An issue filed around it can
lack the labels the workflow routes on.

## What to file

The arguments name the idea. When they are empty or brief, the idea is the
one this conversation has been working on: take what was agreed, not
everything that was said.

## Which workflow

An item is started in one workflow, and each works it differently. Call
`landrace_workflows` to list them. When there is more than one and neither
the arguments nor the conversation name one, ask the person which — show
each one's id, name and description — and wait for the answer. Never pick
one yourself. Pass the chosen id as `workflow`; with a single workflow,
pass nothing.

## The body

The body is the item's whole brief. The workflow's first step — `spec`, in
`main` — reads it cold, with none of this conversation, and works from it.
Write it for that reader:

- **Goal**: one or two sentences saying what changes for the person using it.
- **Why**: the problem, with the concrete case that exposed it (an item
  number, an error, a failed run).
- **Decided**: every choice already made, one line each, with the reason. The
  spec step must not reopen these.
- **Open**: questions not yet settled, for the spec step to raise.
- **Out of scope**: anything discussed and deliberately left out.
- **Depends on**: work that must land first, if any.

Name files, stages, hooks and settings exactly as they appear in the
repository. Do not paste secrets, tokens, local paths under a home
directory, or anything the person did not mean to publish. Anyone who can
read the tracker can read the item.

## Starting it

The tool starts the orchestrator on the item by default. Pass
`start: false` when the arguments say `no-start`, when the person said not
to start it, or when **Depends on** names work that has not merged. An
item started before its dependency lands is built against code that
cannot support it. Say which of these applied.

## Afterwards

Report the item's id, link and workflow from the tool's answer, and
whether it was started. If the tool refuses, show its message and stop. Do not retry
through another route.
