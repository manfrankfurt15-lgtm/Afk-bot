import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'fs'
import http from 'http'

const PORT = process.env.PORT || 3000
http.createServer((req, res) => { res.writeHead(200); res.end('Bot läuft!') })
  .listen(PORT, () => console.log(`Ping-Server läuft auf Port ${PORT}`))

const __dirname = dirname(fileURLToPath(import.meta.url))
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPO = 'manfrankfurt15-lgtm/Afk-bot'

const SERVER_HOST = 'blockbande.de'
const SERVER_PORT = 19132
const TRIGGER_PLAYER = '!Pranav123237'
const TPA_COMMAND = `/tpa ${TRIGGER_PLAYER}`
const RECONNECT_DELAY_MS = 15000
const RECONNECT_DELAY_SESSION_MS = 180000
const COMMAND_COOLDOWN_MS = 5000
const AUTH_TIMEOUT_MS = 90000  // 90s — wenn kein Spawn, Cache leeren & neu versuchen

const ACCOUNTS = [
  { id: 'account1', username: 'Bot1' },
  { id: 'account2', username: 'Bot2' },
  { id: 'account3', username: 'Bot3' },
  { id: 'account4', username: 'Bot4' },
  { id: 'account5', username: 'Bot5' },
  { id: 'account6', username: 'Bot6' },
]

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
    console.log(`[${accountId}] 💾 Tokens in GitHub gespeichert — bleibt dauerhaft eingeloggt!`)
  } catch (err) {
    console.log(`[${accountId}] ⚠️ GitHub-Speicher fehlgeschlagen: ${err.message}`)
  }
}

function stopAllBots() {
  globalStopped = true
  console.log(`[System] 🛑 Alle Bots gestoppt — reconnect in 10 Minuten automatisch`)
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

    // Wenn nach 90s kein Spawn → Auth gescheitert → Cache leeren & neu
    spawnTimer = setTimeout(() => {
      log(`⏰ Timeout — kein Spawn nach ${AUTH_TIMEOUT_MS/1000}s, Cache leeren & neu verbinden`)
      try { client?.disconnect() } catch {}
      scheduleReconnect(RECONNECT_DELAY_MS, true)
    }, AUTH_TIMEOUT_MS)

    client.on('spawn', () => {
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      log('✅ Im Server!')
      setTimeout(() => sendCommand('/home 1'), 2000)
      setTimeout(() => saveTokensToGitHub(account.id, cacheDir), 5000)
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
          lastCommandTime = now; log(`🏠 → /sethome 1`); sendCommand('/sethome 1')
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
      log(isSession ? `⏳ Session aktiv — warte 3min...` : `⚠️ Disconnect: ${stripColors(msg)}`)
      scheduleReconnect(isSession ? RECONNECT_DELAY_SESSION_MS : RECONNECT_DELAY_MS)
    })

    client.on('error', (err) => {
      const isAuthError = err.message?.includes('invalid_grant') || err.message?.includes('expired_token')
      log(`❌ ${err.message}`)
      scheduleReconnect(RECONNECT_DELAY_MS, isAuthError)
    })

    client.on('close', () => { log('Geschlossen.'); scheduleReconnect() })
  }

  function forceConnect() { reconnecting = false; connect() }

  function shutdown() {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    reconnecting = true
    if (client) try { client.disconnect() } catch {}
  }

  return { connect, forceConnect, shutdown }
}

console.log('🚀 Multi-Bot startet...')
const bots = ACCOUNTS.map(acc => createBot(acc))
bots.forEach(b => allBots.push(b))
bots.forEach((bot, i) => setTimeout(() => bot.connect(), i * 3000))
process.on('SIGINT', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
process.on('SIGTERM', () => { bots.forEach(b => b.shutdown()); setTimeout(() => process.exit(0), 2000) })
