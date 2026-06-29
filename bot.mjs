import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'

const PORT = process.env.PORT || 3000
const botStatus = {}

// ── Log-Buffer (letzten 200 Zeilen merken für /logs Endpoint) ─
const logBuffer = []
const _origLog = console.log
console.log = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  logBuffer.push({ t: new Date().toISOString(), m: line })
  if (logBuffer.length > 200) logBuffer.shift()
  _origLog(...args)
}

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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!r.ok) return
    const j = await r.json()
    subs = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
  } catch (e) { console.log('[loadSubs] ⚠️ Fehler:', e.message) }
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
    }).catch(e => { try { res.writeHead(500); res.end(JSON.stringify({ ok: false, err: e.message })) } catch {} })
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
  } else if (req.url === '/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, count: logBuffer.length, logs: logBuffer }))
  } else {
    res.writeHead(200); res.end('Bot läuft! Status: /ping | Logs: /logs')
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
  let entityId = BigInt(0)
  let lastPos = null
  let antiAfk = null, lastCmd = 0, awaitingPayout = false
  const COOLDOWN = 1500

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
    // Zufälliger Extra-Delay (0-10s) damit nicht alle Bots gleichzeitig reconnecten
    const accountNum = parseInt(account.id.replace('account','')) || 1
    const jitter = (accountNum - 1) * 5000 + Math.floor(Math.random() * 5000)
    const totalDelay = delay + jitter
    log(`🔄 Reconnect in ${Math.round(totalDelay/1000)}s...`)
    setTimeout(() => { if (globalStopped) { reconnecting=false; return }; reconnecting=false; try { connect() } catch(e) { log(`❌ connect: ${e.message}`) } }, totalDelay)
  }

  function connect() {
    if (reconnecting || globalStopped) return
    hasSpawned = false
    // Alten Client sauber aufräumen (verhindert Memory Leak)
    if (client) {
      try { client.removeAllListeners() } catch {}
      try { client.disconnect() } catch {}
      client = null
    }
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

    client.on('spawn', () => {
      hasSpawned = true
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      botStatus[account.id] = { online: true, since: new Date().toISOString() }
      log('✅ Im Server!')
      // Fallback: /home wird sowieso nach 30s ausgeführt falls loadSubs hängt
      let homeSent = false
      const homeFallback = setTimeout(() => {
        if (!homeSent) {
          homeSent = true
          log('🏠 Fallback → /home 2 (loadSubs Timeout)')
          sendCmd('/home 2')
        }
      }, 30000)
      // Nach Spawn: Subs neu laden und prüfen ob Bot noch zugewiesen ist
      loadSubs().then(() => {
        if (homeSent) return
        homeSent = true
        clearTimeout(homeFallback)
        const assignedPlayer = getAssignedPlayer(account.id)
        if (assignedPlayer) {
          log(`🏠 Spieler ${assignedPlayer} aktiv → /home 1`)
          setTimeout(() => sendCmd('/home 1'), 5000)
        } else {
          log('🏠 Kein aktiver Spieler → /home 2')
          setTimeout(() => sendCmd('/home 2'), 5000)
        }
      }).catch(e => {
        clearTimeout(homeFallback)
        if (!homeSent) { homeSent = true; sendCmd('/home 2') }
        log(`⚠️ loadSubs@spawn: ${e.message}`)
      })
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

      // /money Antwort auswerten (nach !payout)
      if (awaitingPayout) {
        const balMatch = clean.match(/Kontostand:\s*\$?([\d.]+)/i)
        if (balMatch) {
          const amount = parseInt(balMatch[1].replace(/\./g, ''))
          awaitingPayout = false
          if (amount > 0) {
            log(`💸 Payout: ${amount} → ${OWNER}`)
            sendCmd(`/pay ${OWNER} ${amount}`)
            setTimeout(() => sendCmd(`/pay ${OWNER} ${amount} confirm`), 3000)
            setTimeout(() => sendCmd(`/msg ${OWNER} Auszahlung von ${amount}$ wurde erfolgreich gesendet!`), 5000)
          } else {
            sendCmd(`/msg ${OWNER} Es ist kein Guthaben vorhanden zum Auszahlen.`)
          }
        }
      }

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
            sendCmd(`/msg ${t2} Ich hab dir eine tpahere anfrage geschickt!`)
            setTimeout(() => sendCmd(`/tpahere ${t2}`), 400)
          } else if (msg2.includes('!tpa')) {
            lastCmd = now2
            sendCmd(`/msg ${t2} Teleportationsanfrage gesendet, bitte annehmen!`)
            setTimeout(() => sendCmd(`/tpa ${t2}`), 400)
          } else if (msg2.includes('!home')) {
            lastCmd = now2
            sendCmd(`/msg ${t2} Dein Home wurde erfolgreich gesetzt!`)
            sendCmd('/sethome 1')
          } else if (msg2.includes('!info')) {
            lastCmd = now2
            const entry2 = subs[ap2]
            const timeStr2 = entry2?.lifetime ? 'Lifetime' : entry2?.expiresAt ? `bis ${new Date(entry2.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}` : '?'
            const gt2 = readGamertag(cacheDir)
            sendCmd(`/msg ${t2} Dein Bot: ${gt2 ? '!'+gt2 : account.id} | Gueltig: ${timeStr2}`)
          }
        }).catch(() => {})
        return
      }

      // DEBUG: !ping testet ob /msg funktioniert
      const msgPre = content || clean
      if (msgPre.includes('!ping') && isOwner) {
        sendCmd(`/msg ${OWNER} PONG ok`)
        return
      }

      const now = Date.now()
      if (now - lastCmd < COOLDOWN) return
      const msg = content || clean

      if (msg.includes('!home')) {
        lastCmd = now
        if (isOwner && /!home\s+2/.test(msg)) {
          // Nur Owner: !home 2 → /sethome 2
          sendCmd('/sethome 2')
          sendCmd(`/msg ${OWNER} Home 2 wurde erfolgreich gesetzt!`)
        } else {
          // Alle (!home oder !home 1) → /sethome 1
          const t = extractName(sender)
          sendCmd('/sethome 1')
          setTimeout(() => sendCmd(`/msg ${isOwner ? OWNER : t} Home 1 wurde erfolgreich gesetzt!`), 600)
        }
      } else if (msg.includes('!tpahere')) {
        lastCmd = now
        const targetName = extractName(sender)
        setTimeout(() => sendCmd(`/tpahere ${isOwner ? OWNER : targetName}`), 400)
        setTimeout(() => sendCmd(`/msg ${isOwner ? OWNER : targetName} Ich hab dir eine tpahere anfrage geschickt!`), 600)
      } else if (msg.includes('!tpa')) {
        lastCmd = now
        const targetName = extractName(sender)
        setTimeout(() => sendCmd(`/tpa ${isOwner ? OWNER : targetName}`), 400)
        setTimeout(() => sendCmd(`/msg ${isOwner ? OWNER : targetName} Teleportationsanfrage gesendet, bitte annehmen!`), 600)
      } else if (msg.includes('!payout') && isOwner) {
        lastCmd = now
        log('💸 Payout angefragt — checke Guthaben...')
        awaitingPayout = true
        sendCmd('/money')
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
      const msg = e.message || ''
      // Read/Parse-Fehler sind harmlose Protokoll-Warnungen — kein Reconnect noetig
      if (msg.includes('Read error') || msg.includes('Invalid tag')) return
      const used = msg.includes('device_code') && msg.includes('already been used')
      const authErr = !used && (msg.includes('invalid_grant') || msg.includes('AADSTS'))
      log(`❌ ${msg}`)
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
    if (client) {
      try { client.removeAllListeners() } catch {}
      try { client.disconnect() } catch {}
      client = null
    }
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

process.on('unhandledRejection', (reason) => { console.log('[System] ⚠️ Unhandled rejection:', reason?.message || String(reason)) })
process.on('uncaughtException', (e) => { console.log('[System] ❌ Uncaught exception:', e.message); /* kein crash */ })
process.on('SIGINT',  () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
process.on('SIGTERM', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
