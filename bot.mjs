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
  } else if (req.url === '/reload') {
    loadSubs().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, subs: Object.keys(subs).length }))
    })
  } else if (req.url === '/online') {
    const online = {}
    for (const [id, inst] of Object.entries(botInstances)) online[id] = inst.isOnline
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, online }))
  } else if (req.url.startsWith('/cmd')) {
    const p = new URL(req.url, 'http://localhost').searchParams
    const botId  = p.get('bot')
    const cmd    = p.get('cmd')    ? decodeURIComponent(p.get('cmd'))    : null
    const player = p.get('player') ? decodeURIComponent(p.get('player')) : null
    const msg    = p.get('msg')    ? decodeURIComponent(p.get('msg'))    : null
    const b = botInstances[botId]
    if (b && cmd) {
      b.sendCommand(cmd)
      if (player && msg) setTimeout(() => b.sendCommand(`/msg ${player} ${msg}`), 1500)
      res.writeHead(200, {'Content-Type':'application/json'})
      res.end(JSON.stringify({ ok: true, bot: botId, cmd }))
    } else {
      res.writeHead(404, {'Content-Type':'application/json'})
      res.end(JSON.stringify({ ok: false, reason: botId ? 'Bot nicht gefunden' : 'Kein bot= Parameter' }))
    }
  } else {
    res.writeHead(200); res.end('Bot läuft! Status: /ping')
  }
}).listen(PORT, () => console.log(`Status-Server Port ${PORT}`))

// ── Hilfsfunktionen ───────────────────────────────────────────
const stripColors = s => s.replace(/[\u00a7\u00A7§]./g, '').replace(/[\u00a7\u00A7§]/g, '')
// Extrahiert den echten Spielernamen aus Whisper/Rank-Prefix
// '[Nachricht] !Pranav123237 -> Du' → '!Pranav123237'
// '[CLAN] Rank | PlayerName'        → 'PlayerName'
function extractName(raw) {
  if (raw.includes('->')) {
    // Extrahiere Namen zwischen ] und ->, dann strip Rank-Prefix falls vorhanden
    const m = raw.match(/\]\s*(.+?)\s*->/)
    let name = m ? m[1].trim() : raw.replace(/\s*->.*$/, '').trim()
    if (name.includes('| ')) name = name.split('| ').pop().trim()
    return name
  }
  if (raw.includes('| ')) return raw.split('| ').pop().trim()
  return raw.trim()
}

// Prüft ob sender (kann Rank-Prefix haben) dem gespeicherten Spielernamen entspricht
function senderMatches(sender, playerName, isWhisper, clean) {
  if (!playerName) return false
  const low = sender.toLowerCase()
  const pLow = playerName.toLowerCase()
  return (
    low === pLow ||
    low.endsWith(pLow) ||
    low.includes('| ' + pLow) ||
    (isWhisper && clean.toLowerCase().includes(pLow))
  )
}

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


// ── Gamertag lesen & speichern ──────────────────────────────

function readGamertag(cacheDir) {
  try {
    const files = readdirSync(cacheDir).filter(f => f.includes('bed-cache'))
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'))
      const chain = data?.mca?.chain || []
      for (const jwt of chain) {
        const parts = jwt.split('.')
        if (parts.length < 2) continue
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
          if (payload?.extraData?.displayName) return payload.extraData.displayName
        } catch {}
      }
    }
  } catch {}
  return null
}

async function saveGamertag(accountId, gamertag) {
  if (!GITHUB_TOKEN || !gamertag) return
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Immer frische SHA holen um Konflikte zu vermeiden
      let current = {}, sha
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/gamertags.json`, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
      })
      if (r.ok) { const j = await r.json(); sha = j.sha; current = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) }
      if (current[accountId] === gamertag) return // schon gespeichert
      current[accountId] = gamertag
      const body = { message: `[auto] Gamertag: ${accountId}=${gamertag}`, content: Buffer.from(JSON.stringify(current, null, 2)).toString('base64') }
      if (sha) body.sha = sha
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/gamertags.json`, {
        method: 'PUT', headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (res.ok) { console.log(`[${accountId}] 🏷️ Gamertag gespeichert: ${gamertag}`); return }
      // SHA-Konflikt → kurz warten und nochmal
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000))
    } catch (e) { console.log(`[${accountId}] ⚠️ Gamertag-Save (retry ${attempt}): ${e.message}`) }
  }
}

// ── Bot erstellen ─────────────────────────────────────────────
let globalStopped = false
const allBots = []
const botInstances = {}  // accountId → { sendCommand }

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

    let uniqueEntityId = BigInt(0)
    let selfGamertag = null
    client.on('start_game', p => {
      entityId = p.runtime_entity_id ?? BigInt(0)
      uniqueEntityId = p.unique_entity_id ?? BigInt(0)
      if (p.player_position) lastPos = p.player_position
    })

    client.on('player_list', packet => {
      if (selfGamertag) return
      const records = packet?.records?.records || packet?.records || []
      for (const r of records) {
        if (r.entity_unique_id === uniqueEntityId || r.entity_unique_id?.toString() === uniqueEntityId?.toString()) {
          selfGamertag = r.username
          log(`🏷️ Gamertag erkannt: ${selfGamertag}`)
          saveGamertag(account.id, selfGamertag)
          break
        }
      }
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
      setTimeout(() => sendCmd('/home 1'), 5000)
      setTimeout(() => saveTokensToGitHub(account.id, cacheDir), 5000)
      // Gestaffelt speichern: account1=8s, account2=12s, account3=16s, etc.
      const accountNum = parseInt(account.id.replace('account','')) || 1
      setTimeout(() => {
        const gt = readGamertag(cacheDir)
        if (gt) { log(`🏷️ Gamertag: ${gt}`); saveGamertag(account.id, gt) }
        else log('⚠️ Gamertag nicht lesbar (noch kein bed-cache?)')
      }, 8000 + (accountNum - 1) * 4000)

      if (antiAfk) clearInterval(antiAfk)
      antiAfk = setInterval(() => { try { client?.write('animate', { action_id:1, runtime_entity_id:entityId }) } catch {} }, 4*60*1000)
      log('🔄 Anti-AFK aktiv')
    })

    client.on('text', packet => {
      const raw = packet.message || ''
      const srcName = stripColors(packet.source_name || '')
      const clean = stripColors(raw)
      const ci = clean.indexOf(': ')
      const sender = ci !== -1 ? clean.slice(0,ci).trim() : srcName
      const content = ci !== -1 ? clean.slice(ci+2).trim() : clean
      log(`[Chat] <${sender}> ${content}`)

      const isWhisper = clean.includes('-> Du') || clean.includes('-> dir') || clean.includes('-> me') || packet.type === 'whisper'

      // Wer darf mit diesem Bot interagieren?
      // 1. Immer: OWNER (!Pranav123237)
      // 2. Zugewiesener Spieler (wenn aktive Subscription)
      const assignedPlayer = getAssignedPlayer(account.id)
      const ownerBase = OWNER.startsWith('!') ? OWNER.slice(1) : OWNER
      const isWhisperPkt = packet.type === 'whisper'
      const isOwner = sender === OWNER || sender === ownerBase ||
                      sender.endsWith(OWNER) || sender.endsWith(ownerBase) ||
                      srcName === OWNER || srcName === ownerBase ||
                      ((isWhisper || isWhisperPkt) && (clean.includes(OWNER) || clean.includes(ownerBase)))
      const isAssigned = senderMatches(sender, assignedPlayer, isWhisper, clean)

      if (!isOwner && !isAssigned) {
        loadSubs().then(() => {
          const ap2 = getAssignedPlayer(account.id)
          const ia2 = senderMatches(sender, ap2, isWhisper, clean)
          if (!ia2) return
          const now2 = Date.now()
          if (now2 - lastCmd < COOLDOWN) return
          const msg2 = content || clean
          const t2 = extractName(sender)
          if (msg2.includes('!tpahere')) {
            lastCmd = now2
            setTimeout(() => sendCmd(`/tpahere ${t2}`), 400)
            setTimeout(() => sendCmd(`/msg ${t2} TPA-Here gesendet! ✅`), 2000)
          } else if (msg2.includes('!tpa')) {
            lastCmd = now2
            setTimeout(() => sendCmd(`/tpa ${t2}`), 400)
            setTimeout(() => sendCmd(`/msg ${t2} TPA gesendet! ✅`), 2000)
          } else if (msg2.includes('!home')) {
            lastCmd = now2
            sendCmd('/home 1')
            setTimeout(() => sendCmd(`/msg ${t2} Bot ist auf dem Weg zu Home! ✅`), 1500)
          } else if (msg2.includes('!info')) {
            lastCmd = now2
            const entry2 = subs[ap2]
            const timeStr2 = entry2?.lifetime ? 'Lifetime' : entry2?.expiresAt ? `bis ${new Date(entry2.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}` : '?'
            const gt2 = readGamertag(cacheDir)
            sendCmd(`/msg ${t2} Dein Bot: ${gt2 ? '!'+gt2 : account.id} | Gueltig: ${timeStr2}`)
          }
        })
        return
      }

      const now = Date.now()
      if (now - lastCmd < COOLDOWN) return
      const msg = content || clean

      if (msg.includes('!home')) {
        lastCmd = now
        if (isOwner && /!home\s+[12]/.test(msg)) {
          // Nur Owner mit Zahl: !home 1 → /sethome 1 | !home 2 → /sethome 2
          const homeNum = msg.match(/!home\s+([12])/)[1]
          sendCmd(`/sethome ${homeNum}`)
          setTimeout(() => sendCmd(`/msg ${OWNER} Home-${homeNum} gesetzt! ✅`), 1500)
        } else {
          // Subscriber ODER Owner ohne Zahl → Bot geht zu /home 1
          const t = isOwner ? OWNER : extractName(sender)
          sendCmd('/home 1')
          setTimeout(() => sendCmd(`/msg ${t} Bot ist auf dem Weg zu Home! ✅`), 1500)
        }
      } else if (msg.includes('!tpahere')) {
        lastCmd = now
        const targetName = extractName(sender)
        setTimeout(() => sendCmd(`/tpahere ${isOwner ? OWNER : targetName}`), 400)
        setTimeout(() => sendCmd(`/msg ${isOwner ? OWNER : targetName} TPA-Here gesendet! ✅`), 2000)
      } else if (msg.includes('!tpa')) {
        lastCmd = now
        const targetName = extractName(sender)
        setTimeout(() => sendCmd(`/tpa ${isOwner ? OWNER : targetName}`), 400)
        setTimeout(() => sendCmd(`/msg ${isOwner ? OWNER : targetName} TPA gesendet! ✅`), 2000)
      } else if (msg.includes('!stop') && isOwner) {
        lastCmd = now; log('🛑 Stop'); stopAllBots()
      } else if (msg.includes('!info')) {
        lastCmd = now
        if (assignedPlayer) {
          const entry = subs[assignedPlayer]
          const timeStr = entry?.lifetime ? 'Lifetime' : entry?.expiresAt ? `bis ${new Date(entry.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}` : '?'
          const gt = readGamertag(cacheDir)
          const displayName = gt ? `!${gt}` : account.id
          sendCmd(`/msg ${isOwner ? OWNER : extractName(sender)} Dein Bot: ${displayName} | Gueltig: ${timeStr}`)
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

  const inst = { connect, forceConnect, shutdown, loadTokens: () => loadTokensFromGitHub(account.id, cacheDir), sendCommand: cmd => sendCmd(cmd), get isOnline() { return hasSpawned } }
  botInstances[account.id] = inst
  return inst
}

// ── Start ─────────────────────────────────────────────────────
console.log('🚀 Multi-Bot startet...')
console.log(`🔑 GitHub: ${GITHUB_TOKEN ? '✅' : '❌ FEHLT'}`)

const bots = ACCOUNTS.map(a => createBot(a))
bots.forEach(b => allBots.push(b))

// Subscriptions alle 5min neu laden
setInterval(loadSubs, 30 * 1000)

// Alle 60s: abgelaufene Subscriptions erkennen → Bot geht zu /home 2
setInterval(() => {
  const now = Date.now()
  for (const inst of Object.values(botInstances)) {
    if (!inst.isOnline) continue
    const accountId = Object.keys(botInstances).find(k => botInstances[k] === inst)
    if (!accountId) continue
    const wasAssigned = Object.values(subs).some(
      s => s.assignedBot === accountId && !s.lifetime && s.expiresAt && s.expiresAt > now - 65000 && s.expiresAt <= now
    )
    if (wasAssigned) {
      console.log(`[${accountId}] ⏰ Subscription abgelaufen → /home 2`)
      inst.sendCommand('/home 2')
    }
  }
}, 60 * 1000)

console.log('📥 Lade Tokens + Subscriptions...')
Promise.all([loadSubs(), ...bots.map(b => b.loadTokens())]).then(() => {
  console.log('🔗 Verbinde Bots...')
  bots.forEach((b, i) => setTimeout(() => b.connect(), i * 3000))
})

process.on('SIGINT',  () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
process.on('SIGTERM', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
