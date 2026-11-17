#!/usr/bin/env node
// agent-bus dashboard — status board + task-lifecycle + "nudge" alerts (read-only).
// Because chat agents don't poll the board on their own, this page is your radar: it
// pops a desktop notification + a top banner the instant a task needs you to act,
// and tells you exactly WHO to nudge next. The page is already open and polling, so
// no extra daemon / no modules.
//   node dashboard.js   ->   http://127.0.0.1:4317   (override: PORT, AGENT_BUS_FILE)

const http = require('http')
const fs = require('fs')
const path = require('path')

const BOARD_FILE = process.env.AGENT_BUS_FILE || path.join(__dirname, 'board.json')
const PORT = Number(process.env.PORT || 4317)

function readBoard() {
  try {
    const b = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'))
    return { values: b.values || {}, log: b.log || [], tasks: b.tasks || {}, archive: b.archive || [], claims: b.claims || {} }
  } catch { return { values: {}, log: [], tasks: {}, archive: [], claims: {} } }
}
function agentStates(board) {
  // One card per agent that has ever shown up on the board; latest activity wins.
  const out = {}
  for (const t of [...Object.values(board.tasks), ...board.archive]) { for (const n of [t.from, t.to]) if (n && !(n in out)) out[n] = null }
  for (const l of board.log) { if (l.by) out[l.by] = { text: `[${l.kind}] ${l.text}`, at: l.at } }
  return out
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-bus</title>
<style>
  :root{--bg:#0b0c0e;--card:#15171b;--line:#262a31;--ink:#e7e3d8;--sub:#8b8f98;--gold:#ffb347;--red:#ff5a52;--green:#3ad17a;--cyan:#69d2e7;--amber:#ffc861}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header{padding:16px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
  header h1{font-size:15px;margin:0;letter-spacing:.18em;font-weight:600}
  header .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green)}
  header .sub{color:var(--sub);font-size:11px;margin-left:auto}
  header button{background:var(--paper-char,#1c1f24);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font:inherit;font-size:11px;cursor:pointer}
  main{max-width:1040px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:16px}
  /* nudge banner */
  #nudges:empty{display:none}
  #nudges{display:flex;flex-direction:column;gap:8px}
  .nudge{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:10px;border:1px solid;font-size:13.5px;animation:pop .25s}
  @keyframes pop{from{transform:translateY(-4px);opacity:0}to{transform:none;opacity:1}}
  .nudge.new{background:rgba(255,200,97,.10);border-color:rgba(255,200,97,.5)}
  .nudge.done{background:rgba(58,209,122,.10);border-color:rgba(58,209,122,.45)}
  .nudge.failed{background:rgba(255,90,82,.10);border-color:rgba(255,90,82,.5)}
  .nudge b{color:var(--ink)} .nudge .x{margin-left:auto;cursor:pointer;color:var(--sub);padding:0 6px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
  .lanes{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  @media(max-width:760px){.lanes{grid-template-columns:1fr 1fr}}
  @media(max-width:480px){.lanes{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card .role{font-size:11px;letter-spacing:.16em;color:var(--sub)}
  .card .name{font-size:18px;font-weight:600;margin:2px 0 10px;display:flex;align-items:center;gap:9px}
  .pulse{width:9px;height:9px;border-radius:50%;background:#444}
  .pulse.on{background:var(--green);box-shadow:0 0 9px var(--green)}
  .card .status{min-height:38px} .card .status.idle{color:var(--sub);font-style:italic}
  .card .when{color:var(--sub);font-size:11px;margin-top:8px}
  .lane{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;min-height:90px}
  .lane h3{font-size:11px;letter-spacing:.12em;margin:0 0 9px;display:flex;justify-content:space-between;align-items:center}
  .lane.new h3{color:var(--amber)} .lane.picked h3{color:var(--cyan)} .lane.done h3{color:var(--green)} .lane.failed h3{color:var(--red)}
  .count{background:#1c1f24;border-radius:10px;padding:0 8px;font-size:11px;color:var(--sub)}
  .task{border-top:1px solid #1c1f24;padding:7px 0;font-size:12.5px} .task:first-of-type{border-top:none}
  .task .tt{color:var(--ink)} .task .meta{color:var(--sub);font-size:10.5px}
  .lane .empty{color:#555;font-style:italic;font-size:12px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .panel h2{font-size:11px;letter-spacing:.16em;color:var(--sub);margin:0 0 10px;font-weight:600}
  .feed{max-height:280px;overflow:auto}
  .ln{padding:5px 0;border-top:1px solid #1c1f24;display:flex;gap:10px;font-size:12.5px} .ln:first-child{border-top:none}
  .ln .t{color:var(--sub);white-space:nowrap}
  .by{font-weight:600;white-space:nowrap;color:var(--gold)}
  .k{font-size:10px;padding:0 5px;border-radius:4px;background:#1c1f24;color:var(--sub)}
  .k.handoff{color:var(--amber)} .k.ack{color:var(--cyan)} .k.complete{color:var(--green)} .k.fail{color:var(--red)}
  .empty{color:var(--sub);font-style:italic}
</style></head><body>
<header><span class="dot"></span><h1>AGENT-BUS</h1><button id="notif-btn" onclick="enableNotifs()">Enable desktop notifications</button><span class="sub">read-only view of board.json</span></header>
<main>
  <div id="nudges"></div>
  <div class="cards" id="cards"><div class="empty">Waiting for the first agent to post…</div></div>
  <div class="panel"><h2>CLAIMS · in flight, do not duplicate</h2><div id="claims"><div class="empty">—</div></div></div>
  <div class="lanes">
    <div class="lane new"><h3>NEW<span class="count" id="c-new">0</span></h3><div id="l-new"><div class="empty">—</div></div></div>
    <div class="lane picked"><h3>PICKED<span class="count" id="c-picked">0</span></h3><div id="l-picked"><div class="empty">—</div></div></div>
    <div class="lane done"><h3>DONE<span class="count" id="c-done">0</span></h3><div id="l-done"><div class="empty">—</div></div></div>
    <div class="lane failed"><h3>FAILED<span class="count" id="c-failed">0</span></h3><div id="l-failed"><div class="empty">—</div></div></div>
  </div>
  <div class="panel"><h2>ACTIVITY</h2><div class="feed" id="feed"><div class="empty">Waiting for the first agent to post…</div></div></div>
</main>
<script>
const ago=t=>{if(!t)return'';const s=(Date.now()-new Date(t))/1000;if(s<60)return Math.floor(s)+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago'}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
function lane(id,arr){const el=document.getElementById('l-'+id);document.getElementById('c-'+id).textContent=arr.length;el.innerHTML=arr.length?arr.slice(-12).reverse().map(t=>'<div class="task"><div class="tt">'+esc(t.task)+'</div><div class="meta">'+esc(t.id)+' · '+esc(t.from)+'→'+esc(t.to)+(t.result?' · '+esc(t.result):'')+(t.reason?' · '+esc(t.reason):'')+'</div></div>').join(''):'<div class="empty">—</div>'}

// ── nudges: who should you poke next ──
const dismissed=new Set(), alerted=new Set(); let primed=false, notifsOn=false
function enableNotifs(){ if(!('Notification'in window))return; Notification.requestPermission().then(p=>{notifsOn=(p==='granted');document.getElementById('notif-btn').textContent=notifsOn?'Notifications on':'Blocked (allow in browser settings)'}) }
function beep(){ try{const a=new (window.AudioContext||window.webkitAudioContext)();const o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.type='sine';o.frequency.value=880;g.gain.setValueAtTime(.0001,a.currentTime);g.gain.exponentialRampToValueAtTime(.2,a.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,a.currentTime+.35);o.start();o.stop(a.currentTime+.36)}catch(e){} }
function toast(text){ if(notifsOn&&Notification.permission==='granted'){try{new Notification('agent-bus',{body:text})}catch(e){}} beep() }
function nudgesFrom(all){
  const now=Date.now(), out=[]
  for(const t of all){
    if(t.state==='new') out.push({key:t.id+':new',sev:'new',text:'Tell <b>'+esc(t.to)+'</b> to check its agent-bus inbox: “'+esc(t.task)+'”'})
    else if((t.state==='done'||t.state==='failed') && (now-new Date(t.doneAt||t.createdAt))/60000<10)
      out.push({key:t.id+':'+t.state,sev:t.state,text:'Tell <b>'+esc(t.from)+'</b>: '+esc(t.to)+(t.state==='done'?' finished':' failed')+' “'+esc(t.task)+'”'+(t.result?' — '+esc(t.result):'')+(t.reason?' — '+esc(t.reason):'')})
  }
  return out.filter(n=>!dismissed.has(n.key))
}
let lastNudgeSig=''
function renderNudges(all){
  const ns=nudgesFrom(all)
  // Re-render the banners ONLY when the set of nudges changes; otherwise the 1.5s tick
  // rebuilds the nodes every time and replays the pop-in animation (= constant flashing).
  const sig=ns.map(n=>n.sev+':'+n.key).join('|')
  if(sig!==lastNudgeSig){
    lastNudgeSig=sig
    document.getElementById('nudges').innerHTML=ns.map(n=>'<div class="nudge '+n.sev+'">'+n.text+'<span class="x" onclick="dismiss(\\''+n.key+'\\')">✕</span></div>').join('')
  }
  // toast each nudge we haven't alerted yet; on first load just seed (no burst)
  for(const n of ns){
    if(!primed){ alerted.add(n.key); continue }
    if(!alerted.has(n.key)){ alerted.add(n.key); toast(n.text.replace(/<[^>]+>/g,'')) }
  }
  primed=true
}
function dismiss(k){ dismissed.add(k); }

async function tick(){
  let d; try{ d=await (await fetch('/api/board')).json() }catch{ return }
  const names=Object.keys(d.agents||{}).sort()
  document.getElementById('cards').innerHTML=names.length?names.map(a=>{const st=d.agents[a],on=st&&(Date.now()-new Date(st.at))/1000<90
    return '<div class="card"><div class="role">AGENT</div><div class="name"><span class="pulse'+(on?' on':'')+'"></span>'+esc(a)+'</div><div class="status'+(st?'':' idle')+'">'+(st?esc(st.text):'— no activity yet —')+'</div><div class="when">'+(st?ago(st.at):'')+'</div></div>'}).join(''):'<div class="empty">Waiting for the first agent to post…</div>'
  const claims=Object.values(d.claims||{}).filter(c=>c.state==='active')
  document.getElementById('claims').innerHTML=claims.length?claims.map(c=>'<div class="ln"><span class="t">'+ago(c.at)+'</span><span class="by">'+esc(c.by)+'</span><span>'+esc(c.topic)+(c.note?' — '+esc(c.note):'')+'</span></div>').join(''):'<div class="empty">—</div>'
  const all=[...Object.values(d.tasks||{}), ...(d.archive||[])]
  renderNudges(all)
  lane('new',all.filter(t=>t.state==='new'))
  lane('picked',all.filter(t=>t.state==='picked'))
  lane('done',all.filter(t=>t.state==='done'))
  lane('failed',all.filter(t=>t.state==='failed'))
  const feed=document.getElementById('feed'), log=(d.log||[]).slice(-40).reverse()
  feed.innerHTML=log.length?log.map(l=>'<div class="ln"><span class="t">'+ago(l.at)+'</span><span class="by">'+esc(l.by)+'</span><span class="k '+esc(l.kind)+'">'+esc(l.kind)+'</span><span>'+esc(l.text)+'</span></div>').join(''):'<div class="empty">Waiting for the first agent to post…</div>'
}
if('Notification'in window && Notification.permission==='granted'){ notifsOn=true; document.getElementById('notif-btn').textContent='Notifications on' }
tick(); setInterval(tick,1500)
</script></body></html>`

http.createServer((req, res) => {
  if (req.url === '/api/board') {
    const b = readBoard()
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ agents: agentStates(b), values: b.values, log: b.log, tasks: b.tasks, archive: b.archive, claims: b.claims }))
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`agent-bus dashboard -> http://127.0.0.1:${PORT}  (board=${BOARD_FILE})\n`)
})
