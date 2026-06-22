import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'

const PORT = process.env.PORT || 3000
const botStatus = {}

http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/health') {
    const uptime = Math.floor(process.uptime())
    const status = {
      ok: true,
      service: process.env.BOT_SET ? 'bot-set-' + process.env.BOT_SET : 'bot-all',
      uptime_seconds: uptime,
      bots: Object.fromEntries(Object.entries(botStatus).map(([id, s]) => [id, s]))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Bot läuft! Ping: /ping')
  }
}).listen(PORT, () => console.log(`Ping-Server läuft auf Port ${PORT} — Status: /ping`))

const __dirname = dirname(fileURLToPath(import.meta.url))
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API
const GITHUB_REPO = 'manfrankfurt15-lgtm/Afk-bot'

const SERVER_HOST = 'blockbande.de'
const SERVER_PORT = 19132
const TRIGGER_PLAYER = '!Pranav123237'
const TPA_COMMAND = `/tpa ${TRIGGER_PLAYER}`
const RECONNECT_DELAY_MS = 15000
const RECONNECT_DELAY_SESSION_MS = 180000
const COMMAND_COOLDOWN_MS = 5000
const DEVICE_CODE_WAIT_MS = 20 * 60 * 1000

const ALL_ACCOUNTS = [
  { id: 'account1', username: 'Bot1' },
  { id: 'account2', username: 'Bot2' },
  { id: 'account3', username: 'Bot3' },
  { id: 'account4', username: 'Bot4' },
  { id: 'account5', username: 'Bot5' },
  { id: 'account6', username: 'Bot6' },
]

// BOT_SET=1 → Bots 1-3, BOT_SET=2 → Bots 4-6, kein Wert → alle 6
const BOT_SET = process.env.BOT_SET
let ACCOUNTS
if (BOT_SET === '1') {
  ACCOUNTS = ALL_ACCOUNTS.slice(0, 3)
  console.log('🎯 BOT_SET=1 — lädt Accounts 1-3')
} else if (BOT_SET === '2') {
  ACCOUNTS = ALL_ACCOUNTS.slice(3, 6)
  console.log('🎯 BOT_SET=2 — lädt Accounts 4-6')
} else {
  ACCOUNTS = ALL_ACCOUNTS
  console.log('🎯 Kein BOT_SET — alle 6 Accounts')
}

let globalStopped = false
const allBots = []
const STOP_DURATION_MS = 10 * 60 * 1000

function stripColors(str) {
  return str.replace(/§[0-9a-fk-orA-FK-OR]/g, '')
}

function parseChat(raw) {
  const clean = stripColors(raw)
  const colonIdx = clean.indexOf(': ')
  if (colonIdx === -1) return { sender: '', content: clean }
  return { sender: clean.slice(0, colonIdx).trim(), content: clean.slice(colonIdx + 2).trim() }
}

async function loadTokensFromGitHub(accountId, cacheDir) {
  if (!GITHUB_TOKEN) {
    console.log(`[${accountId}] ⚠️ Kein GITHUB_TOKEN/GITHUB_API gesetzt — kein Token-Download`)
    return
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/auth-cache/${accountId}`, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    })
    if (!r.ok) {
      console.log(`[${accountId}] ℹ️ Noch keine Tokens in GitHub — warte auf Device-Code-Auth`)
      return
    }
    const files = await r.json()
    if (!Array.isArray(files) || files.length === 0) {
      console.log(`[${accountId}] ℹ️ Token-Ordner leer in GitHub — warte auf Device-Code-Auth`)
      return
    }
    mkdirSync(cacheDir, { recursive: true })
    let loaded = 0
    for (const file of files) {
      if (file.type !== 'file') continue
      const fr = await fetch(file.download_url, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
      })
      if (fr.ok) {
        const content = await fr.text()
        writeFileSync(join(cacheDir, file.name), content, 'utf8')
        loaded++
      }
    }
    console.log(`[${accountId}] ✅ ${loaded} Token-Datei(en) von GitHub geladen`)
  } catch (err) {
    console.log(`[${accountId}] ⚠️ Token-Download fehlgeschlagen: ${err.message}`)
  }
}

async function saveTokensToGitHub(accountId, cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    const files = readdirSync(cacheDir)
    for (const file of files) {
      const content = readFileSync(join(cacheDir, file))
      const base64 = content.toString('base64')
      const githubPath = `auth-cache/${accountId}/${file}`
      let sha
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${githubPath}`, {
          headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
        })
        if (r.ok) sha = (await r.json()).sha
      } catch {}
      const body = { message: `[auto] Token: ${accountId}/${file}`, content: base64 }
      if (sha) body.sha = sha
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${githubPath}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    }
    console.log(`[${accountId}] 💾 Tokens in GitHub gespeichert`)
  } catch (err) {
    console.log(`[${accountId}] ⚠️ GitHub-Speicher fehlgeschlagen: ${err.message}`)
  }
}

function stopAllBots() {
  globalStopped = true
  console.log(`[System] 🛑 Alle Bots gestoppt — reconnect in 10 Minuten`)
  allBots.forEach(b => b.shutdown())
  setTimeout(() => {
    globalStopped = false
    console.log(`[System] 🟢 10 Minuten vorbei — Bots reconnecten...`)
    allBots.forEach((bot, i) => setTimeout(() => bot.forceConnect(), i * 3000))
  }, STOP_DURATION_MS)
}

function createBot(account) {
  const cacheDir = join(__dirname, 'auth-cache', account.id)
  mkdirSync(cacheDir, { recursive: true })
  let client = null
  let reconnecting = false
  let lastCommandTime = 0
  let spawnTimer = null
  let hasSpawned = false
  let antiAfkInterval = null
  let entityRuntimeId = BigInt(0)
  let lastPos = { x: 0, y: 64, z: 0 }
  let lastYaw = 0

  function log(msg) {
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [${account.id}] ${msg}`)
  }

  function clearCache() {
    try {
      rmSync(cacheDir, { recursive: true, force: true })
      mkdirSync(cacheDir, { recursive: true })
      log('🗑️ Auth-Cache geleert — neuer Login-Code kommt...')
    } catch {}
  }

  function sendCommand(command) {
    try {
      client.queue('command_request', {
        command,
        origin: { type: 'player', uuid: '00000000-0000-0000-0000-000000000000', request_id: '', player_entity_id: 0n },
        internal: false,
        version: '52',
      })
      log(`➡️ ${command}`)
    } catch (err) { log(`Fehler: ${err.message}`) }
  }

  function scheduleReconnect(delay = RECONNECT_DELAY_MS, resetCache = false) {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    if (reconnecting || globalStopped) return
    reconnecting = true
    if (resetCache) clearCache()
    log(`🔄 Reconnect in ${delay / 1000}s...`)
    setTimeout(() => {
      if (globalStopped) { reconnecting = false; return }
      reconnecting = false
      connect()
    }, delay)
  }

  function connect() {
    if (reconnecting || globalStopped) return
    hasSpawned = false
    log(`Verbinde...`)

    try {
      client = bedrock.createClient({
        host: SERVER_HOST,
        port: SERVER_PORT,
        username: account.username,
        offline: false,
        connectTimeout: 20000,
        skipPing: false,
        profilesFolder: cacheDir,
      })
    } catch (err) {
      log(`Fehler beim Erstellen: ${err.message}`)
      scheduleReconnect(RECONNECT_DELAY_MS, true)
      return
    }

    spawnTimer = setTimeout(() => {
      if (hasSpawned) return
      log(`⏰ Timeout — kein Spawn nach ${DEVICE_CODE_WAIT_MS / 60000} Minuten`)
      log(`💡 Falls ein Device-Code angezeigt wurde: Im Browser authentifizieren!`)
      try { client?.disconnect() } catch {}
      const hasTokenFiles = (() => { try { return readdirSync(cacheDir).length > 0 } catch { return false } })()
      scheduleReconnect(RECONNECT_DELAY_MS, hasTokenFiles)
    }, DEVICE_CODE_WAIT_MS)

    client.on('start_game', (packet) => {
      try {
        entityRuntimeId = packet.runtime_entity_id ?? BigInt(0)
        if (packet.player_position) lastPos = packet.player_position
      } catch {}
    })

    client.on('move_player', (packet) => {
      try {
        if (packet.runtime_entity_id === entityRuntimeId) {
          if (packet.position) lastPos = packet.position
          if (packet.yaw != null) lastYaw = packet.yaw
        }
      } catch {}
    })

    client.on('spawn', () => {
      hasSpawned = true
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      botStatus[account.id] = { online: true, since: new Date().toISOString() }
      log('✅ Im Server!')
      setTimeout(() => sendCommand('/home 1'), 2000)
      setTimeout(() => saveTokensToGitHub(account.id, cacheDir), 5000)

      // Anti-AFK: alle 4 Minuten Arm schwingen (sicher, kein Kick)
      if (antiAfkInterval) clearInterval(antiAfkInterval)
      antiAfkInterval = setInterval(() => {
        if (!hasSpawned || !client) return
        try {
          client.write('animate', { action_id: 1, runtime_entity_id: entityRuntimeId })
        } catch {}
      }, 4 * 60 * 1000)
      log('🔄 Anti-AFK aktiv (schwingt alle 4min)')
    })

    client.on('text', (packet) => {
      const raw = packet.message || ''
      const sourceName = packet.source_name || ''
      const { sender, content } = parseChat(raw)
      const effectiveSender = sourceName || sender
      const cleanRaw = stripColors(raw)
      log(`[Chat] <${effectiveSender}> ${content || cleanRaw}`)
      const isWhisper = cleanRaw.includes('-> Du')
      const isFromTrigger = effectiveSender === TRIGGER_PLAYER || (isWhisper && cleanRaw.includes(TRIGGER_PLAYER))
      if (isFromTrigger) {
        const now = Date.now()
        if (now - lastCommandTime < COMMAND_COOLDOWN_MS) return
        const msgContent = content || cleanRaw
        if (msgContent.includes('!home')) {
          lastCommandTime = now
          log(`🏠 → /sethome 1`)
          sendCommand('/sethome 1')
          setTimeout(() => sendCommand(`/msg ${effectiveSender} Home wurde gesetzt!`), 1500)
        } else if (msgContent.includes('!tpa')) {
          lastCommandTime = now; log(`📩 → ${TPA_COMMAND}`); sendCommand(TPA_COMMAND)
        } else if (msgContent.includes('!stop')) {
          lastCommandTime = now; log(`🛑 Stop-Befehl empfangen — Bots pausieren 10 Minuten`); stopAllBots()
        } else {
          log(`⏭️ Ignoriert: "${msgContent}"`)
        }
      }
    })

    client.on('disconnect', (reason) => {
      const msg = reason?.message || ''
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      botStatus[account.id] = { online: false, since: new Date().toISOString() }
      if (antiAfkInterval) { clearInterval(antiAfkInterval); antiAfkInterval = null }
      log(isSession ? `⏳ Session aktiv — warte 3min...` : `⚠️ Disconnect: ${stripColors(msg)}`)
      scheduleReconnect(isSession ? RECONNECT_DELAY_SESSION_MS : RECONNECT_DELAY_MS)
    })

    client.on('error', (err) => {
      // 'device_code has already been used' = User hat sich eingeloggt, Code wurde verbraucht
      // In diesem Fall Cache NICHT löschen — Tokens sind evtl. gültig, einfach reconnecten
      const codeAlreadyUsed = err.message?.includes('device_code') && err.message?.includes('already been used')
      const isAuthError = !codeAlreadyUsed && (err.message?.includes('invalid_grant') || err.message?.includes('expired_token') || err.message?.includes('AADSTS'))
      log(`❌ ${err.message}`)
      if (codeAlreadyUsed) log(`♻️ Login erkannt — reconnecte mit neuen Tokens`)
      else if (isAuthError) log(`🗑️ Auth-Fehler — Cache wird geleert`)
      scheduleReconnect(RECONNECT_DELAY_MS, isAuthError)
    })

    client.on('close', () => {
      if (antiAfkInterval) { clearInterval(antiAfkInterval); antiAfkInterval = null }
      log('Geschlossen.')
      scheduleReconnect()
    })
  }

  function forceConnect() { reconnecting = false; connect() }

  function shutdown() {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    reconnecting = true
    if (client) try { client.disconnect() } catch {}
  }

  return { connect, forceConnect, shutdown, loadTokens: () => loadTokensFromGitHub(account.id, cacheDir) }
}

console.log('🚀 Multi-Bot startet...')
console.log(`🔑 GitHub-Token: ${GITHUB_TOKEN ? '✅ gesetzt' : '❌ FEHLT — setze GITHUB_TOKEN auf Render!'}`)

const bots = ACCOUNTS.map(acc => createBot(acc))
bots.forEach(b => allBots.push(b))

console.log('📥 Lade Auth-Tokens von GitHub...')
Promise.all(bots.map(b => b.loadTokens())).then(() => {
  console.log('🔗 Alle Tokens geladen — verbinde Bots...')
  bots.forEach((bot, i) => setTimeout(() => bot.connect(), i * 3000))
})

process.on('SIGINT', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
process.on('SIGTERM', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
