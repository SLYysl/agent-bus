// Self-test: spawn server.js, speak real MCP, exercise the status board + the full
// task lifecycle (handoff -> inbox -> ack -> complete | fail) + edge cases.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const TEST_BOARD = path.join(__dirname, 'board.test.json')
try { fs.unlinkSync(TEST_BOARD) } catch {}
try { fs.unlinkSync(TEST_BOARD + '.lock') } catch {}

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, AGENT_BUS_FILE: TEST_BOARD },
})
let buf = ''; const pending = {}
srv.stdout.on('data', (d) => {
  buf += d.toString(); let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id] }
  }
})
let idc = 0
const req = (method, params) => new Promise((res) => { const id = ++idc; pending[id] = res; srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const call = async (name, args) => (await req('tools/call', { name, arguments: args })).result.content[0].text
const idOf = (s) => (s.match(/\b(t-[a-z0-9-]+)\b/) || [])[1]

let fails = 0
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fails++ }

;(async () => {
  const init = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  notify('notifications/initialized')
  const tools = (await req('tools/list', {})).result.tools.map((t) => t.name)
  console.log('server:', JSON.stringify(init.result.serverInfo), '\ntools:', tools.join(', '), '\n')
  check('exposes all tools', ['post', 'get', 'board', 'handoff', 'inbox', 'ack', 'complete', 'fail', 'claim', 'release'].every((n) => tools.includes(n)))

  // status board (Layer 1)
  await call('post', { key: 'status', value: 'building task flow', by: 'codex' })
  check('Layer 1: claude reads codex status', (await call('get', { key: 'status' })).includes('building task flow'))

  // full task lifecycle: handoff -> inbox -> ack -> complete
  const h1 = await call('handoff', { to: 'codex', task: 'deploy feature X', note: 'on prod', by: 'claude' })
  const t1 = idOf(h1)
  console.log('handoff ->', h1)
  check('handoff returns a task id', !!t1)
  check('inbox shows the open task', (await call('inbox', { agent: 'codex' })).includes(t1))
  const a1 = await call('ack', { taskId: t1, by: 'codex' })
  check('ack: new -> picked', a1.includes('picked'))
  check('re-ack a picked task is guarded', (await call('ack', { taskId: t1, by: 'codex' })).includes('already'))
  const c1 = await call('complete', { taskId: t1, by: 'codex', result: 'deployed, live' })
  check('complete archives the task (out of active list)', c1.includes('archived'))
  check('completing an archived task errors', (await call('complete', { taskId: t1, by: 'codex' })).includes('ERROR'))
  check('done task no longer in inbox', !(await call('inbox', { agent: 'codex' })).includes(t1))
  check('completed task shows in board archive', (await call('board', {})).includes(t1))

  // fail path
  const t2 = idOf(await call('handoff', { to: 'claude', task: 'fix flaky test', by: 'codex' }))
  await call('ack', { taskId: t2, by: 'claude' })
  check('fail: -> failed', (await call('fail', { taskId: t2, by: 'claude', reason: 'cannot reproduce' })).includes('failed'))

  // duplicate handoff = two DISTINCT ids
  const d1 = idOf(await call('handoff', { to: 'codex', task: 'same task', by: 'claude' }))
  const d2 = idOf(await call('handoff', { to: 'codex', task: 'same task', by: 'claude' }))
  check('duplicate handoff -> distinct ids', d1 && d2 && d1 !== d2)

  // bad id guarded
  check('ack unknown id errors', (await call('ack', { taskId: 'nope', by: 'codex' })).includes('ERROR'))

  // coordination: claim de-dups an outward action across agents (the anti-double-draft mechanism)
  check('claude can claim a topic', (await call('claim', { topic: 'email:acme-reply', by: 'claude', note: 'drafting reply' })).includes('claimed'))
  check('codex sees the topic is already claimed', (await call('claim', { topic: 'email:acme-reply', by: 'codex' })).includes('ALREADY CLAIMED'))
  check('active claim shows on the board', (await call('board', {})).includes('email:acme-reply'))
  check('release marks it done', (await call('release', { topic: 'email:acme-reply', by: 'claude', result: 'draft created' })).includes('released'))
  check('after release, re-claim is allowed but warns', (await call('claim', { topic: 'email:acme-reply', by: 'codex' })).includes('previously done'))

  // concurrency: every agent runs its OWN server process on the same file. Fire the
  // same claim from many processes at once — exactly one may win.
  // Start all processes first, release them together once every one is up, so the
  // read-modify-write windows really overlap.
  const N = 12
  const procs = Array.from({ length: N }, () => spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_BUS_FILE: TEST_BOARD } }))
  await Promise.all(procs.map((p) => new Promise((resolve) => p.stderr.once('data', resolve))))
  const racers = await Promise.all(procs.map((p, i) => new Promise((resolve) => {
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', () => resolve(out))
    const calls = Array.from({ length: 25 }, (_, r) => JSON.stringify({ jsonrpc: '2.0', id: r + 1, method: 'tools/call', params: { name: 'claim', arguments: { topic: 'race:' + r, by: 'agent-' + i } } })).join('\n')
    p.stdin.end(calls + '\n')
  })))
  let wins = 0, refusals = 0
  for (const o of racers) { wins += (o.match(/"claimed \\"race:/g) || []).length; refusals += (o.match(/ALREADY CLAIMED/g) || []).length }
  check(`${N} processes race for 25 topics -> exactly 25 winners (got ${wins} won, ${refusals} refused)`, wins === 25 && refusals === 25 * (N - 1))
  check('no lock file left behind', !fs.existsSync(TEST_BOARD + '.lock'))

  // corrupt board.json recovery
  fs.writeFileSync(TEST_BOARD, '{ this is not valid json ]]')
  const recovered = await call('post', { key: 'after-corrupt', value: 'ok', by: 'claude' })
  check('recovers from a corrupt board.json', recovered.includes('posted') && fs.existsSync(TEST_BOARD))

  console.log('\nboard dump:\n' + await call('board', {}))
  console.log('\n' + (fails === 0 ? 'ALL TESTS PASS  — task flow + edge cases solid.' : `${fails} FAILED`))
  try { fs.unlinkSync(TEST_BOARD) } catch {}
  srv.kill(); process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.error('test crashed:', e); srv.kill(); process.exit(1) })
