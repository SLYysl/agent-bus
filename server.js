#!/usr/bin/env node
// agent-bus — ZERO-DEPENDENCY MCP (stdio) shared "blackboard" + trackable task flow
// for AI coding agents working on the same machine (Claude Code, Codex, or any other
// MCP client). One JSON file is the shared state; each agent's MCP client spawns its
// own copy of this server pointing at the SAME file, so everything is visible to all.
//
// Layers (every UI/watcher only talks to these tools — clean interface, no spaghetti):
//   status board :  post / get / board
//   task flow    :  handoff -> inbox -> ack -> complete | fail   (each task has an id
//                   and a state: new -> picked -> done | failed)
//   coordination :  claim -> release   (lock a topic before an outward action so the
//                   other agents never duplicate it — the de-dup mechanism)
//
// Run:  node server.js     (board -> ./board.json ; override with AGENT_BUS_FILE)

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const BOARD_FILE = process.env.AGENT_BUS_FILE || path.join(__dirname, 'board.json')
const SERVER = { name: 'agent-bus', version: '0.5.0' }
const CLAIM_TTL_MS = 30 * 60 * 1000 // an active claim older than this is treated as stale (claimer likely died)

const LOCK_FILE = BOARD_FILE + '.lock'
const LOCK_WAIT_MS = 5000   // give up waiting for the lock after this long
const LOCK_STALE_MS = 10000 // a lock file older than this belongs to a dead process

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
// Every agent runs its own server process against the same file, so a mutating tool
// must hold an exclusive lock across its read-modify-write. Without it two agents
// calling `claim` at the same moment could both be told "claimed".
function withLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK_FILE, 'wx'))
      break
    } catch (e) {
      // Windows reports EPERM/EACCES/EBUSY instead of EEXIST while another process is
      // still deleting the lock file — that is contention too, not a failure.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_FILE); continue }
      } catch { continue } // lock vanished between open and stat — retry now
      if (Date.now() > deadline) throw new Error('board is locked by another agent — try again')
      sleepMs(10 + Math.floor(Math.random() * 20))
    }
  }
  try { return fn() } finally { try { fs.unlinkSync(LOCK_FILE) } catch {} }
}

function newId() {
  return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}
function readBoard() {
  // Corrupt / missing file -> fresh board (self-healing). Always normalize shape.
  let b
  try { b = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')) } catch { b = {} }
  b.values = b.values || {}
  b.log = b.log || []
  b.tasks = b.tasks || {}    // ACTIVE tasks only (new / picked)
  b.archive = b.archive || [] // closed tasks (done / failed), newest first, capped
  b.claims = b.claims || {}  // topic -> { topic, by, at, state:'active'|'released', note, result }
  return b
}
function writeBoard(b) {
  // write-then-rename = readers never see a half-written file. Short retry covers
  // Windows briefly refusing the rename while a reader has the file open.
  const tmp = BOARD_FILE + '.' + process.pid + '.tmp'
  let lastErr
  for (let i = 0; i < 20; i++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(b, null, 2))
      fs.renameSync(tmp, BOARD_FILE)
      return
    } catch (e) {
      lastErr = e
      sleepMs(15)
    }
  }
  try { fs.unlinkSync(tmp) } catch {}
  throw lastErr
}
function logLine(b, by, kind, text) {
  b.log.push({ at: new Date().toISOString(), by, kind, text })
  if (b.log.length > 300) b.log = b.log.slice(-300)
}
// Move a closed task out of the active list into the archive (newest first, capped),
// so `tasks` only ever holds live work and the next task isn't cluttered.
function archiveTask(b, t) {
  delete b.tasks[t.id]
  b.archive.unshift(t)
  if (b.archive.length > 300) b.archive.length = 300
}

const TOOLS = [
  { name: 'post', description: 'STATUS — write a value to the shared board so the OTHER agents see it. Always include `by` (your own agent name, e.g. "claude" or "codex").',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, by: { type: 'string' } }, required: ['key', 'value', 'by'] } },
  { name: 'get', description: 'STATUS — read the latest value posted under a key.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'board', description: 'STATUS + TASKS — dump the whole board: values, open/recent tasks (with ids + states), and recent activity.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'handoff', description: 'TASK — hand a task to ANOTHER agent. Creates a tracked task (state=new) and returns its id. e.g. claude hands "deploy X" to codex.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'name of the agent that should do it, e.g. "codex"' }, task: { type: 'string' }, note: { type: 'string' }, by: { type: 'string' } }, required: ['to', 'task', 'by'] } },
  { name: 'inbox', description: 'TASK — list the OPEN tasks (new or picked) handed to YOU. Read-only; call `ack` to claim one. Pass your own name as `agent`.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  { name: 'ack', description: 'TASK — claim a task you were handed: state new -> picked. Pass the task id and your name.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, by: { type: 'string' } }, required: ['taskId', 'by'] } },
  { name: 'complete', description: 'TASK — mark a task done with a short result. state -> done.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, by: { type: 'string' }, result: { type: 'string' } }, required: ['taskId', 'by'] } },
  { name: 'fail', description: 'TASK — mark a task failed with a reason. state -> failed.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, by: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId', 'by'] } },
  { name: 'claim', description: 'COORDINATION — BEFORE any outward action (draft/send an email, post to social, write shared data/files), claim its topic so no other agent duplicates your work. Returns "claimed" if it is yours, or "ALREADY CLAIMED" with who holds it. Always include `by`.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'stable id of the action, e.g. "email:acme-reply"' }, by: { type: 'string' }, note: { type: 'string' } }, required: ['topic', 'by'] } },
  { name: 'release', description: 'COORDINATION — mark a claimed topic done (with a short result) so the other agents see it is handled and can build on it instead of redoing it.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, by: { type: 'string' }, result: { type: 'string' } }, required: ['topic', 'by'] } },
]

function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '… [clipped — read board.json for full]' : s }
function fmtTask(t) {
  return `  ${t.id}  [${t.state}]  ${t.from}->${t.to}: ${clip(t.task, 120)}` +
    (t.result ? `  (result: ${clip(t.result, 160)})` : '') + (t.reason ? `  (failed: ${clip(t.reason, 160)})` : '')
}

const READ_ONLY = new Set(['get', 'board', 'inbox'])
function callTool(name, args) {
  return READ_ONLY.has(name) ? runTool(name, args) : withLock(() => runTool(name, args))
}
function runTool(name, args) {
  args = args || {}
  const b = readBoard()
  const at = () => new Date().toISOString()

  if (name === 'post') {
    const { key, value, by } = args
    if (!key || value == null || !by) throw new Error('post needs key, value, by')
    b.values[String(key)] = { value: String(value), by: String(by), at: at() }
    logLine(b, String(by), 'status', `${key}: ${value}`)
    writeBoard(b)
    return `posted [${key}] by ${by}`
  }
  if (name === 'get') {
    const e = b.values[String(args.key)]
    return e ? `[${args.key}] = ${JSON.stringify(e.value)}  (by ${e.by} @ ${e.at})` : `[${args.key}] not set yet`
  }
  if (name === 'board') {
    const vals = Object.entries(b.values).map(([k, e]) => `  ${k}: ${JSON.stringify(e.value)}  (by ${e.by})`).join('\n') || '  (none)'
    const open = Object.values(b.tasks)
    const recentDone = (b.archive || []).slice(0, 5)
    const tasksStr = (open.length ? open.map(fmtTask).join('\n') : '  (no open tasks)') +
      (recentDone.length ? '\n  --- recently closed ---\n' + recentDone.map(fmtTask).join('\n') : '')
    const logStr = b.log.slice(-10).map((l) => `  ${l.at.slice(11, 19)}  ${l.by} [${l.kind}] ${l.text}`).join('\n') || '  (none)'
    const activeClaims = Object.values(b.claims).filter((c) => c.state === 'active')
    const claimsStr = activeClaims.length
      ? activeClaims.map((c) => `  ${c.topic} — held by ${c.by} @ ${c.at.slice(11, 19)}${c.note ? ` (${c.note})` : ''}`).join('\n')
      : '  (none)'
    return `VALUES:\n${vals}\n\nCLAIMS (in-flight — do NOT duplicate these):\n${claimsStr}\n\nTASKS:\n${tasksStr}\n\nACTIVITY:\n${logStr}`
  }
  if (name === 'handoff') {
    const { to, task, note, by } = args
    if (!to || !task || !by) throw new Error('handoff needs to, task, by')
    const id = newId()
    b.tasks[id] = { id, from: String(by), to: String(to), task: String(task), note: note ? String(note) : '', state: 'new', createdAt: at() }
    logLine(b, String(by), 'handoff', `${id} -> ${to}: ${task}`)
    writeBoard(b)
    return `handed off as ${id} -> ${to}: "${task}" (state=new). They ack it to pick it up.`
  }
  if (name === 'inbox') {
    const who = String(args.agent || '')
    if (!who) throw new Error('inbox needs agent')
    const mine = Object.values(b.tasks).filter((t) => t.to === who && (t.state === 'new' || t.state === 'picked'))
    if (!mine.length) return `inbox for ${who}: no open tasks.`
    return `inbox for ${who} — ${mine.length} open:\n` + mine.map((t) =>
      `  ${t.id}  [${t.state}]  from ${t.from}: ${t.task}${t.note ? ' — ' + t.note : ''}`).join('\n') +
      `\n(call ack(taskId, by='${who}') to claim, then complete/fail when done)`
  }
  if (name === 'ack') {
    const t = b.tasks[String(args.taskId)]
    if (!t) throw new Error('no such task: ' + args.taskId)
    if (t.state !== 'new') return `${t.id} already ${t.state} (can't ack)`
    t.state = 'picked'; t.pickedAt = at(); t.pickedBy = String(args.by)
    logLine(b, String(args.by), 'ack', `${t.id} picked`)
    writeBoard(b)
    return `acked ${t.id} (state=picked): ${t.task}`
  }
  if (name === 'complete') {
    const t = b.tasks[String(args.taskId)]
    if (!t) throw new Error('no such task: ' + args.taskId)
    t.state = 'done'; t.doneAt = at(); t.result = args.result ? String(args.result) : ''
    archiveTask(b, t)
    logLine(b, String(args.by), 'complete', `${t.id} done${t.result ? ': ' + t.result : ''}`)
    writeBoard(b)
    return `completed ${t.id} (archived, out of the active list)`
  }
  if (name === 'fail') {
    const t = b.tasks[String(args.taskId)]
    if (!t) throw new Error('no such task: ' + args.taskId)
    t.state = 'failed'; t.doneAt = at(); t.reason = args.reason ? String(args.reason) : ''
    archiveTask(b, t)
    logLine(b, String(args.by), 'fail', `${t.id} failed${t.reason ? ': ' + t.reason : ''}`)
    writeBoard(b)
    return `failed ${t.id} (archived, out of the active list)`
  }
  if (name === 'claim') {
    const { topic, by, note } = args
    if (!topic || !by) throw new Error('claim needs topic, by')
    const key = String(topic)
    const ex = b.claims[key]
    const stale = ex && ex.state === 'active' && (Date.now() - new Date(ex.at).getTime()) > CLAIM_TTL_MS
    if (ex && ex.state === 'active' && !stale) {
      return `ALREADY CLAIMED: "${key}" by ${ex.by} @ ${ex.at}${ex.note ? ` — ${ex.note}` : ''}. Do NOT duplicate — review/improve theirs instead.`
    }
    const prevDone = ex && ex.state === 'released' ? ` (previously done by ${ex.by}${ex.result ? ': ' + ex.result : ''} — confirm you are not redoing it)` : ''
    b.claims[key] = { topic: key, by: String(by), at: at(), state: 'active', note: note ? String(note) : '' }
    logLine(b, String(by), 'claim', `${key}${note ? ': ' + note : ''}`)
    writeBoard(b)
    return `claimed "${key}" by ${by}. Other agents will now see it is yours.${prevDone}`
  }
  if (name === 'release') {
    const { topic, by, result } = args
    if (!topic || !by) throw new Error('release needs topic, by')
    const key = String(topic)
    const ex = b.claims[key] || { topic: key, by: String(by), at: at() }
    ex.state = 'released'; ex.result = result ? String(result) : ''; ex.releasedAt = at()
    b.claims[key] = ex
    logLine(b, String(by), 'release', `${key}${result ? ': ' + result : ''}`)
    writeBoard(b)
    return `released "${key}"${result ? ` (${result})` : ''}.`
  }
  throw new Error('unknown tool: ' + name)
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function handle(msg) {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER } })
  } else if (method === 'notifications/initialized' || method === 'initialized') {
    /* notification */
  } else if (method === 'ping') {
    if (isRequest) send({ jsonrpc: '2.0', id, result: {} })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    try {
      const text = callTool(params && params.name, params && params.arguments)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true } })
    }
  } else if (isRequest) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  line = line.trim(); if (!line) return
  let msg; try { msg = JSON.parse(line) } catch { return }
  try { handle(msg) } catch { /* never crash on one bad message */ }
})
process.stderr.write(`agent-bus ${SERVER.version} up (pid ${process.pid}). board=${BOARD_FILE}\n`)
