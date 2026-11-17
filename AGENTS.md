# agent-bus working rules

You share a blackboard (the `agent-bus` MCP server) with other AI agents on this machine.
Tools: `post` / `get` / `board` / `handoff` / `inbox` / `ack` / `complete` / `fail` / `claim` / `release`.

Paste this file into each agent's instructions (`CLAUDE.md`, `AGENTS.md`, …) and edit the
names and the strengths map to match your setup.

## Before you start a task, ask two questions

1. **Can I actually do this?** If you lack the tool, the permission or the access, hand it off.
2. **Would another agent do it better?** If so, hand it off even if you could manage.

Holding on to work you do badly is the most expensive mistake here: it is slow and it gets redone.

> Example strengths map — replace with your own:
> **touches the outside world → codex** (browser automation, image generation, posting);
> **touches the codebase → claude** (multi-file changes, long context, local environment).

## Rules

1. **Claim before any outward action.** Before you draft or send an email, post publicly,
   open a PR, or write shared data: `claim(topic='email:acme-reply', by='<you>')`.
   - `ALREADY CLAIMED` → do not redo it. Read what the holder produced and improve that.
   - `claimed` → it is yours. When done: `release(topic, by, result='<one line>')`.
2. **Do not poll the board.** Check `inbox` / `board` only when the user asks ("check the
   board") or when you are about to start something another agent may already own.
   `claim` is a single lock call, not polling — always use it.
3. **Keep board entries to one line.** `post` / `complete` / `release` carry a short
   status or conclusion. Full output goes to the user in your own conversation.
   The exception is `handoff`: the receiver works from it, so include what they need.
4. **Hand off with `handoff`, finish with `complete` or `fail`.** Work you finish silently
   in your own session is invisible to everyone else.
5. **`by` is always your own name**, spelled the same way every time.

## When the user says "check the board"

Run `inbox(agent='<you>')` and `board()`. `ack` what was handed to you, do it, then
`complete` or `fail` it. Tell the user what is claimed and what is in flight.
