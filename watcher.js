#!/usr/bin/env node
// agent-bus watcher — wakes the recipient agent when a NEW task is handed to it.
// MCP is pull-only, so this daemon is what removes the human from the relay loop.
//
// Robustness (per review):
//  - keyed by task id (not text+time) -> no duplicate pings
//  - remembers what it already woke in watcher-state.json -> a restart won't re-fire
//  - retries only LAUNCH failures (up to MAX_RETRY); never re-pings a task it reached
//
// SAFE BY DEFAULT: dry-run (prints intent). Add `--go` to actually run the triggers.
//   node watcher.js          (dry-run)
//   node watcher.js --go      (live)

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const BOARD = process.env.AGENT_BUS_FILE || path.join(__dirname, 'board.json')
const STATE = path.join(path.dirname(BOARD), 'watcher-state.json')
const GO = process.argv.includes('--go')
const MAX_RETRY = 3

// How to wake each agent for a task. The task is passed in the prompt so the agent
// can ack/complete it. Edit freely. Codex/Claude both have headless modes.
const TRIGGERS = {
  codex: (t) => ['codex', ['exec', '--skip-git-repo-check',
    `agent-bus task ${t.id} from ${t.from}: ${t.task}. ${t.note || ''} Use agent-bus tools: ack('${t.id}','codex'), do it, then complete('${t.id}','codex',<result>) or fail('${t.id}','codex',<reason>).`]],
  claude: (t) => ['claude', ['-p',
    `agent-bus task ${t.id} from ${t.from}: ${t.task}. ${t.note || ''} Use agent-bus tools ack/complete/fail with id ${t.id}.`]],
}

const readBoard = () => { try { return JSON.parse(fs.readFileSync(BOARD, 'utf8')) } catch { return null } }
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { wakes: {} } } }
const saveState = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch {} }

const state = loadState()

function tick() {
  const b = readBoard()
  if (!b || !b.tasks) return
  let dirty = false
  for (const t of Object.values(b.tasks)) {
    if (t.state !== 'new') continue                 // only brand-new tasks need a wake
    const w = state.wakes[t.id] || { attempts: 0, status: 'pending' }
    if (w.status === 'launched') continue           // already pinged this task once
    if (w.attempts >= MAX_RETRY) continue            // gave up after retries
    const trig = TRIGGERS[t.to]
    const stamp = new Date().toISOString().slice(11, 19)
    if (!trig) { console.log(`[${stamp}] no trigger for "${t.to}" (task ${t.id})`); state.wakes[t.id] = { ...w, status: 'skip' }; dirty = true; continue }
    const [cmd, args] = trig(t)
    w.attempts++
    w.lastAt = stamp
    if (!GO) {
      console.log(`[${stamp}] DRY-RUN would wake ${t.to} for ${t.id}: ${cmd} … "${t.task}"`)
      w.status = 'launched'                          // dry-run counts as pinged (no spam)
    } else {
      console.log(`[${stamp}] waking ${t.to} for ${t.id} (attempt ${w.attempts}/${MAX_RETRY})`)
      try {
        const child = spawn(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32', detached: true })
        child.on('error', (e) => { console.log(`  launch failed: ${e.message} (will retry)`); const s = loadState(); s.wakes[t.id] = { ...w, status: 'failed', lastError: e.message }; saveState(s) })
        child.unref()
        w.status = 'launched'
      } catch (e) { console.log(`  ${e.message}`); w.status = 'failed'; w.lastError = e.message }
    }
    state.wakes[t.id] = w
    dirty = true
  }
  if (dirty) saveState(state)
}

console.log(`agent-bus watcher ${GO ? '(LIVE — runs triggers)' : '(dry-run — prints intent)'}`)
console.log(`watching tasks: ${BOARD}`)
console.log(`wake memory:    ${STATE}  (restart won't re-fire old wakes)\n`)
tick()
setInterval(tick, 1500)
