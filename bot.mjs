import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'

const PORT = process.env.PORT || 3000
const botStatus = {}
const __dirname = dirname(fileURLToPath(import.meta.url))
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API
const GITHUB_REPO = 'manfrankfurt15-lgtm/Afk-bot'
const SERVER_HOST = 'blockbande.de'
const SERVER_PORT = 19132
const OWNER = '!Pranav123237'          // hat immer Zugriff auf alle Bots
const RECONNECT_MS = 15000
const SESSION_MS = 180000
const TIMEOUT_MS = 20 * 60 * 1000

const ALL_ACCOUNTS = [
  { id: 'account1', username: 'Bot1' },
  { id: 'account2', username: 'Bot2' },
  { id: 'account3', username: 'Bot3' },
  { id: 'account4', username: 'Bot4' },
  { id: 'account5', username: 'Bot5' },
  { id: 'account6', username: 'Bot6' },
]
const BOT_SET = process.env.BOT_SET
const ACCOUNTS = BOT_SET === '1' ? ALL_ACCOUNTS.slice(0,3)
               : BOT_SET === '2' ? ALL_ACCOUNTS.slice(3,6)
               : ALL_ACCOUNTS
console.log(`🎯 BOT_SET=${BOT_SET||'alle'} — ${ACCOUNTS.length} Accounts`)

// ── Subscription Store ────────────────────────────────────────
let subs = {}   // { "PlayerName": { assignedBot, expiresAt, lifetime } }

async function loadSubs() {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) return
    const j = await r.json()
    subs = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
  } catch {}
}

// Wer ist dem Bot gerade zugewiesen (und noch aktiv)?
function getAssignedPlayer(accountId) {
  const now = Date.now()
  const entry = Object.entries(subs).find(([, s]) =>
    s.assignedBot === accountId && (s.lifetime || (s.expiresAt && s.expiresAt > now))
  )
  return entry ? entry[0] : null
}

// ── HTTP Status ───────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      service: BOT_SET ? 'bot-set-' + BOT_SET : 'bot-all',
      uptime: Math.floor(process.uptime()),
      bots: botStatus
    }))
  } else {
    res.writeHead(200); res.end('Bot läuft! Status: /ping')
  }
}).listen(PORT, () => console.log(`Status-Server Port ${PORT}`))

// ── Hilfsfunktionen ───────────────────────────────────────────
const stripColors = s => s.replace(/§[0-9a-fk-orA-FK-OR]/g, '')

async function loadTokensFromGitHub(accountId, cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/auth-cache/${accountId}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) { console.log(`[${accountId}] ℹ️ Noch keine Tokens`); return }
    const files = await r.json()
    if (!Array.isArray(files)) return
    let n = 0
    for (const f of files) {
      const fr = await fetch(f.download_url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
      if (fr.ok) { writeFileSync(join(cacheDir, f.name), await fr.text(), 'utf8'); n++ }
    }
    console.log(`[${accountId}] ✅ ${n} Token(s) geladen`)
  } catch (e) { console.log(`[${accountId}] ⚠️ Token-Load: ${e.message}`) }
}

async function saveTokensToGitHub(accountId, cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    for (const file of readdirSync(cacheDir)) {
      const b64 = readFileSync(join(cacheDir, file)).toString('base64')
      const path = `auth-cache/${accountId}/${file}`
      let sha
      try { const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }); if (r.ok) sha = (await r.json()).sha } catch {}
      const body = { message: `[auto] ${accountId}/${file}`, content: b64 }
      if (sha) body.sha = sha
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { method:'PUT', headers:{ Authorization:`Bearer ${GITHUB_TOKEN}`, Accept:'application/vnd.github+json', 'Content-Type':'application/json' }, body: JSON.stringify(body) })
    }
    console.log(`[${accountId}] 💾 Tokens gespeichert`)
  } catch (e) { console.log(`[${accountId}] ⚠️ Token-Save: ${e.message}`) }
}

// ── Bot erstellen ─────────────────────────────────────────────
let globalStopped = false
const allBots = []

function stopAllBots() {
  globalStopped = true
  console.log('[System] 🛑 Alle Bots gestoppt — 10 Minuten Pause')
  allBots.forEach(b => b.shutdown())
  setTimeout(() => {
    globalStopped = false
    console.log('[System] 🟢 Reconnect...')
    allBots.forEach((b, i) => setTimeout(() => b.forceConnect(), i * 3000))
  }, 10 * 60 * 1000)
}

function createBot(account) {
  const cacheDir = join(__dirname, 'auth-cache', account.id)
  mkdirSync(cacheDir, { recursive: true })
  let client, reconnecting = false, spawnTimer = null, hasSpawned = false
  let entityId = BigInt(0), lastPos = { x:0, y:64, z:0 }, lastYaw = 0
  let antiAfk = null, lastCmd = 0
  const COOLDOWN = 5000

  const log = m => console.log(`[${new Date().toLocaleTimeString('de-DE')}] [${account.id}] ${m}`)

  function sendCmd(cmd) {
    try {
      client.queue('command_request', { command: cmd, origin: { type:'player', uuid:'00000000-0000-0000-0000-000000000000', request_id:'', player_entity_id:0n }, internal:false, version:'52' })
      log(`➡️ ${cmd}`)
    } catch (e) { log(`Fehler: ${e.message}`) }
  }

  function clearCache() {
    try { rmSync(cacheDir, { recursive:true, force:true }); mkdirSync(cacheDir, { recursive:true }) } catch {}
    log('🗑️ Cache geleert')
  }

  function scheduleReconnect(delay = RECONNECT_MS, reset = false) {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    if (reconnecting || globalStopped) return
    reconnecting = true
    if (reset) clearCache()
    log(`🔄 Reconnect in ${delay/1000}s...`)
    setTimeout(() => { if (globalStopped) { reconnecting=false; return }; reconnecting=false; connect() }, delay)
  }

  function connect() {
    if (reconnecting || globalStopped) return
    hasSpawned = false
    log('Verbinde...')
    try {
      client = bedrock.createClient({ host:SERVER_HOST, port:SERVER_PORT, username:account.username, offline:false, connectTimeout:20000, skipPing:false, profilesFolder:cacheDir })
    } catch (e) { log(`❌ ${e.message}`); scheduleReconnect(RECONNECT_MS, true); return }

    spawnTimer = setTimeout(() => {
      if (hasSpawned) return
      log(`⏰ Timeout — kein Spawn nach 20min`)
      try { client?.disconnect() } catch {}
      const hasFiles = (() => { try { return readdirSync(cacheDir).length > 0 } catch { return false } })()
      scheduleReconnect(RECONNECT_MS, hasFiles)
    }, TIMEOUT_MS)

    client.on('start_game', p => {
      entityId = p.runtime_entity_id ?? BigInt(0)
      if (p.player_position) lastPos = p.player_position
    })

    client.on('move_player', p => {
      if (p.runtime_entity_id === entityId) {
        if (p.position) lastPos = p.position
        if (p.yaw != null) lastYaw = p.yaw
      }
    })

    client.on('spawn', () => {
      hasSpawned = true
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      botStatus[account.id] = { online: true, since: new Date().toISOString() }
      log('✅ Im Server!')
      setTimeout(() => sendCmd('/home 1'), 2000)
      setTimeout(() => saveTokensToGitHub(account.id, cacheDir), 5000)
      if (antiAfk) clearInterval(antiAfk)
      antiAfk = setInterval(() => { try { client?.write('animate', { action_id:1, runtime_entity_id:entityId }) } catch {} }, 4*60*1000)
      log('🔄 Anti-AFK aktiv')
    })

    client.on('text', packet => {
      const raw = packet.message || ''
      const srcName = packet.source_name || ''
      const clean = stripColors(raw)
      const ci = clean.indexOf(': ')
      const sender = ci !== -1 ? clean.slice(0,ci).trim() : srcName
      const content = ci !== -1 ? clean.slice(ci+2).trim() : clean
      log(`[Chat] <${sender}> ${content}`)

      const isWhisper = clean.includes('-> Du') || clean.includes('-> dir')

      // Wer darf mit diesem Bot interagieren?
      // 1. Immer: OWNER (!Pranav123237)
      // 2. Zugewiesener Spieler (wenn aktive Subscription)
      const assignedPlayer = getAssignedPlayer(account.id)
      const isOwner = sender === OWNER || (isWhisper && clean.includes(OWNER))
      const isAssigned = assignedPlayer && (sender === assignedPlayer || (isWhisper && clean.includes(assignedPlayer)))

      if (!isOwner && !isAssigned) return

      const now = Date.now()
      if (now - lastCmd < COOLDOWN) return
      const msg = content || clean

      if (msg.includes('!home')) {
        lastCmd = now; sendCmd('/sethome 1')
        setTimeout(() => sendCmd(`/msg ${sender} Home wurde gesetzt! ✅`), 1500)
      } else if (msg.includes('!tpahere')) {
        lastCmd = now; sendCmd(`/tpahere ${sender}`)
        setTimeout(() => sendCmd(`/msg ${sender} TPA Here gesendet! ✅`), 1500)
      } else if (msg.includes('!tpa')) {
        lastCmd = now; sendCmd(`/tpa ${sender}`)
        setTimeout(() => sendCmd(`/msg ${sender} TPA gesendet! ✅`), 1500)
      } else if (msg.includes('!stop') && isOwner) {
        lastCmd = now; log('🛑 Stop'); stopAllBots()
      } else if (msg.includes('!info')) {
        lastCmd = now
        if (assignedPlayer && sender !== OWNER) {
          const entry = subs[assignedPlayer]
          const timeStr = entry?.lifetime ? 'Lifetime ⭐' : entry?.expiresAt ? `bis ${new Date(entry.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}` : '?'
          sendCmd(`/msg ${sender} 🤖 Dein Bot: ${account.id} | Gültig: ${timeStr}`)
        }
      }
    })

    client.on('disconnect', r => {
      const msg = r?.message || ''
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      botStatus[account.id] = { online: false, since: new Date().toISOString() }
      if (antiAfk) { clearInterval(antiAfk); antiAfk = null }
      log(isSession ? '⏳ Session — warte 3min...' : `⚠️ ${stripColors(msg)}`)
      scheduleReconnect(isSession ? SESSION_MS : RECONNECT_MS)
    })

    client.on('error', e => {
      const used = e.message?.includes('device_code') && e.message?.includes('already been used')
      const authErr = !used && (e.message?.includes('invalid_grant') || e.message?.includes('AADSTS'))
      log(`❌ ${e.message}`)
      scheduleReconnect(RECONNECT_MS, authErr)
    })

    client.on('close', () => {
      if (antiAfk) { clearInterval(antiAfk); antiAfk = null }
      log('Geschlossen.'); scheduleReconnect()
    })
  }

  function forceConnect() { reconnecting = false; connect() }
  function shutdown() {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    reconnecting = true
    try { client?.disconnect() } catch {}
  }

  return { connect, forceConnect, shutdown, loadTokens: () => loadTokensFromGitHub(account.id, cacheDir) }
}

// ── Start ─────────────────────────────────────────────────────
console.log('🚀 Multi-Bot startet...')
console.log(`🔑 GitHub: ${GITHUB_TOKEN ? '✅' : '❌ FEHLT'}`)

const bots = ACCOUNTS.map(a => createBot(a))
bots.forEach(b => allBots.push(b))

// Subscriptions alle 5min neu laden
setInterval(loadSubs, 5 * 60 * 1000)

console.log('📥 Lade Tokens + Subscriptions...')
Promise.all([loadSubs(), ...bots.map(b => b.loadTokens())]).then(() => {
  console.log('🔗 Verbinde Bots...')
  bots.forEach((b, i) => setTimeout(() => b.connect(), i * 3000))
})

process.on('SIGINT',  () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
process.on('SIGTERM', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
