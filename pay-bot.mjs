import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import http from 'http'

const PORT = process.env.PORT || 3000
const __dirname = dirname(fileURLToPath(import.meta.url))

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API
const GITHUB_REPO = 'manfrankfurt15-lgtm/Afk-bot'
const SERVER_HOST = 'blockbande.de'
const SERVER_PORT = 19132
const RECONNECT_DELAY_MS = 15000
const RECONNECT_DELAY_SESSION_MS = 180000
const DEVICE_CODE_WAIT_MS = 20 * 60 * 1000

// Zahlungs-Tiers: Betrag in Spielgeld → Sekunden (0 = lifetime)
const PAYMENT_TIERS = [
  { amount: 1250000, seconds: 0,         label: 'Lifetime' },
  { amount: 150000,  seconds: 28*24*3600, label: '28 Tage'  },
  { amount: 45000,   seconds: 7*24*3600,  label: '1 Woche'  },
  { amount: 1,       seconds: 1,          label: '1 Sekunde (Test)' },
]

function calcSeconds(amount) {
  for (const tier of PAYMENT_TIERS) {
    if (amount >= tier.amount) {
      // Proportional: mehrfaches zahlen stapelt sich
      const factor = Math.floor(amount / tier.amount)
      if (tier.seconds === 0) return 0 // lifetime
      return factor * tier.seconds
    }
  }
  return 0
}

let subscriptions = {} // { "PlayerName": { expiresAt: timestamp_ms | null (lifetime) } }
let assignments = {}   // { "account3": "PlayerName" } — wird später gesetzt

// ── GitHub: subscriptions.json laden ──────────────────────────
async function loadSubscriptions() {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    })
    if (!r.ok) { console.log('[PayBot] ℹ️ Noch keine subscriptions.json — starte leer'); return }
    const j = await r.json()
    const data = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
    subscriptions = data.subscriptions || {}
    assignments   = data.assignments   || {}
    console.log(`[PayBot] 📂 subscriptions.json geladen — ${Object.keys(subscriptions).length} Spieler`)
  } catch (err) {
    console.log(`[PayBot] ⚠️ Laden fehlgeschlagen: ${err.message}`)
  }
}

// ── GitHub: subscriptions.json speichern ──────────────────────
async function saveSubscriptions() {
  if (!GITHUB_TOKEN) return
  try {
    const content = JSON.stringify({ subscriptions, assignments }, null, 2)
    const base64  = Buffer.from(content).toString('base64')
    let sha
    try {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
      })
      if (r.ok) sha = (await r.json()).sha
    } catch {}
    const body = { message: '[auto] Subscriptions Update', content: base64 }
    if (sha) body.sha = sha
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    console.log('[PayBot] 💾 subscriptions.json gespeichert')
  } catch (err) {
    console.log(`[PayBot] ⚠️ Speichern fehlgeschlagen: ${err.message}`)
  }
}

// ── Zahlung verarbeiten ────────────────────────────────────────
function processPayment(player, amount, client) {
  const seconds = calcSeconds(amount)
  if (seconds === 0 && amount < 1) {
    console.log(`[PayBot] ⚠️ Betrag $${amount} zu niedrig — ignoriert`)
    return
  }

  const isLifetime = seconds === 0
  const now = Date.now()
  const current = subscriptions[player]

  let newExpiry
  if (isLifetime) {
    newExpiry = null // lifetime = null
    console.log(`[PayBot] 🌟 ${player} → LIFETIME! ($${amount})`)
  } else {
    const base = (current?.expiresAt && current.expiresAt > now) ? current.expiresAt : now
    newExpiry = base + seconds * 1000
    const label = PAYMENT_TIERS.find(t => amount >= t.amount)?.label || `${seconds}s`
    console.log(`[PayBot] ✅ ${player} +${label} ($${amount}) → läuft bis ${new Date(newExpiry).toLocaleString('de-DE')}`)
  }

  subscriptions[player] = { expiresAt: newExpiry, lifetime: isLifetime }
  saveSubscriptions()

  // Bestätigung an Zahler senden
  try {
    const msg = isLifetime
      ? `/msg ${player} ✅ Lifetime freigeschaltet! Dein Bot ist dauerhaft aktiv.`
      : `/msg ${player} ✅ Zeit hinzugefügt! Läuft bis: ${new Date(newExpiry).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`
    client.queue('command_request', {
      command: msg,
      origin: { type: 'player', uuid: '00000000-0000-0000-0000-000000000000', request_id: '', player_entity_id: 0n },
      internal: false, version: '52',
    })
  } catch {}
}

// ── Zahlungsmuster erkennen ────────────────────────────────────
function detectPayment(raw, processCallback) {
  const clean = raw.replace(/§[0-9a-fk-orA-FK-OR]/g, '').replace(/,/g, '')

  // Muster 1: "Spieler hat dir $45000 gegeben/gezahlt"
  let m = clean.match(/^(\S+)\s+hat\s+dir\s+\$?([\d.]+)\s+ge(?:geben|zahlt)/i)
  if (m) return processCallback(m[1], parseFloat(m[2]))

  // Muster 2: "Du hast $45000 von Spieler erhalten"
  m = clean.match(/Du\s+hast\s+\$?([\d.]+)\s+von\s+(\S+)\s+erhalten/i)
  if (m) return processCallback(m[2], parseFloat(m[1]))

  // Muster 3: "Spieler paid you $45000"
  m = clean.match(/^(\S+)\s+paid\s+you\s+\$?([\d.]+)/i)
  if (m) return processCallback(m[1], parseFloat(m[2]))

  // Muster 4: "[Economy] Spieler -> $45000"
  m = clean.match(/(\S+)\s*->\s*\$?([\d.]+)/)
  if (m) return processCallback(m[1], parseFloat(m[2]))

  // Muster 5: "$45000 von Spieler" / "Payment: $45000 from Spieler"
  m = clean.match(/\$?([\d.]+)\s+(?:von|from)\s+(\S+)/i)
  if (m) return processCallback(m[2], parseFloat(m[1]))

  // Muster 6: "Spieler überwiesen $45000"
  m = clean.match(/^(\S+)\s+(?:überwiesen?|transferiert?)\s+\$?([\d.]+)/i)
  if (m) return processCallback(m[1], parseFloat(m[2]))

  return false
}

// ── Status-Server ──────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url === '/subscriptions') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const now = Date.now()
    const out = Object.entries(subscriptions).map(([player, sub]) => ({
      player,
      active: sub.lifetime || (sub.expiresAt !== null && sub.expiresAt > now),
      lifetime: sub.lifetime || sub.expiresAt === null,
      expiresAt: sub.expiresAt,
      remaining: sub.expiresAt ? Math.max(0, Math.floor((sub.expiresAt - now) / 1000)) : null
    }))
    res.end(JSON.stringify({ subscriptions: out, assignments }, null, 2))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('PayBot läuft! Subscriptions: /subscriptions')
  }
}).listen(PORT, () => console.log(`[PayBot] Status-Server auf Port ${PORT}`))

// ── Bot erstellen ──────────────────────────────────────────────
function createPayBot() {
  const account = { id: 'paybot', username: 'PayBot' }
  const cacheDir = join(__dirname, 'auth-cache', account.id)
  mkdirSync(cacheDir, { recursive: true })

  let client = null
  let reconnecting = false
  let spawnTimer = null
  let hasSpawned = false
  let entityRuntimeId = BigInt(0)
  let antiAfkInterval = null

  function log(msg) {
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [PayBot] ${msg}`)
  }

  function stripColors(str) { return str.replace(/§[0-9a-fk-orA-FK-OR]/g, '') }

  function clearCache() {
    try { rmSync(cacheDir, { recursive: true, force: true }); mkdirSync(cacheDir, { recursive: true }) } catch {}
    log('🗑️ Cache geleert — neuer Login-Code kommt...')
  }

  function sendCommand(command) {
    try {
      client.queue('command_request', {
        command,
        origin: { type: 'player', uuid: '00000000-0000-0000-0000-000000000000', request_id: '', player_entity_id: 0n },
        internal: false, version: '52',
      })
      log(`➡️ ${command}`)
    } catch (err) { log(`Fehler: ${err.message}`) }
  }

  function scheduleReconnect(delay = RECONNECT_DELAY_MS, resetCache = false) {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    if (reconnecting) return
    reconnecting = true
    if (resetCache) clearCache()
    log(`🔄 Reconnect in ${delay / 1000}s...`)
    setTimeout(() => { reconnecting = false; connect() }, delay)
  }

  async function loadTokensFromGitHub() {
    if (!GITHUB_TOKEN) return
    try {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/auth-cache/${account.id}`, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
      })
      if (!r.ok) { log('ℹ️ Noch keine Tokens in GitHub'); return }
      const files = await r.json()
      if (!Array.isArray(files) || !files.length) return
      let loaded = 0
      for (const file of files) {
        const fr = await fetch(file.download_url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` } })
        if (fr.ok) { writeFileSync(join(cacheDir, file.name), await fr.text(), 'utf8'); loaded++ }
      }
      log(`✅ ${loaded} Token(s) von GitHub geladen`)
    } catch (err) { log(`⚠️ Token-Download: ${err.message}`) }
  }

  async function saveTokensToGitHub() {
    if (!GITHUB_TOKEN) return
    try {
      const files = readdirSync(cacheDir)
      for (const file of files) {
        const content = readFileSync(join(cacheDir, file))
        const base64 = content.toString('base64')
        const githubPath = `auth-cache/${account.id}/${file}`
        let sha
        try {
          const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${githubPath}`, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
          })
          if (r.ok) sha = (await r.json()).sha
        } catch {}
        const body = { message: `[auto] Token: ${account.id}/${file}`, content: base64 }
        if (sha) body.sha = sha
        await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${githubPath}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      }
      log('💾 Tokens in GitHub gespeichert')
    } catch (err) { log(`⚠️ Token-Speicher: ${err.message}`) }
  }

  function connect() {
    if (reconnecting) return
    hasSpawned = false
    log('Verbinde...')

    try {
      client = bedrock.createClient({
        host: SERVER_HOST, port: SERVER_PORT,
        username: account.username,
        offline: false, connectTimeout: 20000, skipPing: false,
        profilesFolder: cacheDir,
      })
    } catch (err) {
      log(`Fehler: ${err.message}`)
      scheduleReconnect(RECONNECT_DELAY_MS, true)
      return
    }

    spawnTimer = setTimeout(() => {
      if (hasSpawned) return
      log(`⏰ Kein Spawn nach 20min`)
      try { client?.disconnect() } catch {}
      const hasTokens = (() => { try { return readdirSync(cacheDir).length > 0 } catch { return false } })()
      scheduleReconnect(RECONNECT_DELAY_MS, hasTokens)
    }, DEVICE_CODE_WAIT_MS)

    client.on('start_game', (p) => {
      entityRuntimeId = p.runtime_entity_id ?? BigInt(0)
    })

    client.on('spawn', () => {
      hasSpawned = true
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      log('✅ PayBot ist im Server!')
      setTimeout(() => sendCommand('/home 1'), 2000)
      setTimeout(() => saveTokensToGitHub(), 5000)

      if (antiAfkInterval) clearInterval(antiAfkInterval)
      antiAfkInterval = setInterval(() => {
        if (!hasSpawned || !client) return
        try { client.write('animate', { action_id: 1, runtime_entity_id: entityRuntimeId }) } catch {}
      }, 4 * 60 * 1000)
    })

    client.on('text', (packet) => {
      const raw = packet.message || ''
      const sourceName = packet.source_name || ''
      const cleanRaw = stripColors(raw)
      const colonIdx = cleanRaw.indexOf(': ')
      const sender = colonIdx !== -1 ? cleanRaw.slice(0, colonIdx).trim() : (sourceName || '')
      const content = colonIdx !== -1 ? cleanRaw.slice(colonIdx + 2).trim() : cleanRaw

      log(`[Chat] <${sender}> ${content}`)

      // Zahlung erkennen — alle Muster versuchen
      const detected = detectPayment(cleanRaw, (player, amount) => {
        log(`💰 Zahlung erkannt: ${player} → $${amount}`)
        processPayment(player, amount, client)
      })

      // Wenn nicht erkannt aber könnte Zahlung sein → loggen für Debugging
      if (!detected && (cleanRaw.includes('$') || cleanRaw.toLowerCase().includes('zahlt') || cleanRaw.toLowerCase().includes('paid') || cleanRaw.toLowerCase().includes('überwiesen'))) {
        log(`🔍 Mögliche Zahlung (Muster unbekannt): "${cleanRaw}"`)
      }

      // !tpa Befehl — nur vom Owner
      const isWhisper = cleanRaw.includes('-> Du') || cleanRaw.includes('-> dir')
      const owner = process.env.OWNER_PLAYER || '!Pranav123237'
      const isOwner = sender === owner || (isWhisper && cleanRaw.includes(owner))
      if (isOwner && content.includes('!tpa')) {
        sendCommand(`/tpa ${owner}`)
        setTimeout(() => sendCommand(`/msg ${owner} TPA gesendet!`), 1500)
      }
    })

    client.on('disconnect', (reason) => {
      const msg = reason?.message || ''
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      if (antiAfkInterval) { clearInterval(antiAfkInterval); antiAfkInterval = null }
      log(isSession ? '⏳ Session aktiv — warte 3min...' : `⚠️ Disconnect: ${stripColors(msg)}`)
      scheduleReconnect(isSession ? RECONNECT_DELAY_SESSION_MS : RECONNECT_DELAY_MS)
    })

    client.on('error', (err) => {
      const codeAlreadyUsed = err.message?.includes('device_code') && err.message?.includes('already been used')
      const isAuthError = !codeAlreadyUsed && (err.message?.includes('invalid_grant') || err.message?.includes('AADSTS'))
      log(`❌ ${err.message}`)
      scheduleReconnect(RECONNECT_DELAY_MS, isAuthError)
    })

    client.on('close', () => {
      if (antiAfkInterval) { clearInterval(antiAfkInterval); antiAfkInterval = null }
      log('Geschlossen.'); scheduleReconnect()
    })
  }

  return { connect, loadTokens: loadTokensFromGitHub }
}

// ── Start ──────────────────────────────────────────────────────
console.log('💰 PayBot startet...')
const bot = createPayBot()

loadSubscriptions().then(() => {
  bot.loadTokens().then(() => {
    bot.connect()
  })
})

// Subscriptions alle 5 Minuten neu laden (für Updates von anderen Services)
setInterval(loadSubscriptions, 5 * 60 * 1000)
