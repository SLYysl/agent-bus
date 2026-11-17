---
name: agent-bus
description: Coordinate with other AI agents on the same machine through the agent-bus MCP blackboard. Use before any outward action another agent might also take (sending an email, posting, opening a PR, writing shared data), when handing a task to another agent, when the user says "check the board" / "查黑板", or when asked what the other agent is doing.
---

# agent-bus

Several agents (Claude Code, Codex, …) work for the same user and cannot see each
other's sessions. The `agent-bus` MCP server gives them one shared board. If its tools
(`claim`, `handoff`, `board`, …) are not available, tell the user the server is not
connected and point them to the repository README; do not simulate it.

Use the same name for yourself in every call (`by` / `agent`), e.g. `claude`.

## Claim before acting outward

Before you draft or send an email, post publicly, open a PR, deploy, or write data that
another agent could also write:

1. `claim(topic, by)` with a stable topic id such as `email:acme-reply` or `pr:auth-refactor`.
2. If the reply starts with `ALREADY CLAIMED`, stop. Tell the user who holds it, read
   what they produced, and offer to improve it instead of redoing it.
3. If the reply starts with `claimed`, do the work, then
   `release(topic, by, result)` with a one-line result.

A reply that says the topic was "previously done" means someone already finished it:
confirm with the user before doing it again. Active claims expire after 30 minutes so a
crashed agent cannot block a topic forever.

## Hand off work you should not do

Hand off when you lack the tool or access, or when another agent is clearly better at it:
`handoff(to, task, note, by)`. Put everything the receiver needs in `task` and `note`;
they cannot see your conversation. Tell the user the task id and that the receiver must
be told to check its inbox — agents do not wake up on their own unless the watcher runs.

## Take work handed to you

When the user says "check the board": `inbox(agent)` then `board()`. For each task:
`ack(taskId, by)` → do it → `complete(taskId, by, result)` or `fail(taskId, by, reason)`.
Then tell the user what is claimed and what is still open.

## Keep the board short

`post`, `complete` and `release` take one line each. Give the full result to the user in
your own reply. Do not poll `board` or `inbox` between turns; it costs tokens and the
claim call already protects you.
