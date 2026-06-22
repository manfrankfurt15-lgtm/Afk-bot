import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'

const PORT = process.env.PORT || 3000
const __dirname = dirname(fileURLToPath(import.meta.url))
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API
const GITHUB_REPO  = 'manfrankfurt15-lgtm/Afk-bot'
const SERVER_HOST  = 'blockbande.de'
const SERVER_PORT  = 19132
const OWNER        = process.env.OWNER_PLAYER || '!Pranav123237'
const RECONNECT_MS = 15000
const SESSION_MS   = 180000
const TIMEOUT_MS   = 20 * 60 * 1000

// Alle möglichen Haupt-Bots (account1-6)
const MAIN_BOTS = ['account1','account2','account3','account4','account5','account6']

// Tiers: min. Betrag → Sekunden (0 = lifetime)
const TIERS = [
  { min: 1250000, seconds: 0 },
  { min: 150000,  seconds: 28*24*3600 },
  { min: 45000,   seconds:  7*24*3600 },
  { min: 1,       seconds: 1 },
]

function calcSeconds(amount) {
  for (const t of TIERS) {
    if (amount >= t.min) {
      if (t.seconds === 0) return 0
      const factor = Math.floor(amount / t.min)
      return factor * t.seconds
    }
  }
  return 0
}

// ── GitHub helpers ────────────────────────────────────────────
let subsSha = null
let subs = {} // { "Player": { assignedBot, expiresAt, lifetime } }

async function loadSubs() {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) { console.log('[PayBot] ℹ️ Noch keine subscriptions.json'); return }
    const j = await r.json()
    subsSha = j.sha
    subs = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
    console.log(`[PayBot] 📂 Subscriptions geladen — ${Object.keys(subs).length} Einträge`)
  } catch (e) { console.log('[PayBot] ⚠️ Laden:', e.message) }
}


async function loadGamertags() {
  if (!GITHUB_TOKEN) return {}
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/gamertags.json`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) return {}
    const j = await r.json()
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
  } catch { return {} }
}

async function saveSubs() {
  if (!GITHUB_TOKEN) return
  try {
    const b64 = Buffer.from(JSON.stringify(subs, null, 2)).toString('base64')
    const body = { message: '[auto] Subscriptions', content: b64 }
    if (subsSha) body.sha = subsSha
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (r.ok) { const j = await r.json(); subsSha = j.content?.sha; console.log('[PayBot] 💾 Gespeichert') }
  } catch (e) { console.log('[PayBot] ⚠️ Speichern:', e.message) }
}

// ── Freien Bot finden ─────────────────────────────────────────
function getFreeBotId() {
  const now = Date.now()
  const taken = new Set(
    Object.values(subs)
      .filter(s => s.assignedBot && (s.lifetime || (s.expiresAt && s.expiresAt > now)))
      .map(s => s.assignedBot)
  )
  return MAIN_BOTS.find(b => !taken.has(b)) || null
}

// ── Zahlung verarbeiten ───────────────────────────────────────
async function processPayment(player, amount, sendMsg) {
  const seconds = calcSeconds(amount)
  if (seconds === -1 || (seconds === 0 && amount < 1)) {
    sendMsg(`/msg ${player} ❌ Betrag zu niedrig. Min: $1`)
    return
  }

  await loadSubs() // immer frisch laden vor Änderung
  const now = Date.now()
  const existing = subs[player]

  if (existing?.lifetime) {
    sendMsg(`/msg ${player} ⭐ Du hast bereits Lifetime! Bot: ${existing.assignedBot}`)
    return
  }

  const isLifetime = seconds === 0

  // Bot zuweisen oder bestehenden behalten
  let botId = existing?.assignedBot || null
  const botStillActive = botId && (existing.lifetime || (existing.expiresAt && existing.expiresAt > now))
  if (!botStillActive) botId = getFreeBotId()

  if (!botId) {
    sendMsg(`/msg ${player} ❌ Alle Bots sind gerade vergeben! Versuch es später.`)
    return
  }

  let newExpiry = null
  if (!isLifetime) {
    const base = botStillActive ? (existing.expiresAt || now) : now
    newExpiry = base + seconds * 1000
  }

  subs[player] = { assignedBot: botId, expiresAt: newExpiry, lifetime: isLifetime }
  await saveSubs()

  const tierLabel = TIERS.find(t => amount >= t.min)
  const timeStr = isLifetime ? 'LIFETIME ⭐' : `bis ${new Date(newExpiry).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`
  const gamertags = await loadGamertags()
  const botName = gamertags[botId] || `Bot ${botId.replace('account', '')}`

  console.log(`[PayBot] ✅ ${player} → ${botId} (${botName}) | ${amount} | ${timeStr}`)
  sendMsg(`/msg ${player} ✅ ${botName} wurde dir zugewiesen! Gültig ${timeStr}`)
  sendMsg(`/msg ${player} 💬 Befehle: !tpa !home !tpahere !stop`)
}

// ── Zahlungsmuster ────────────────────────────────────────────
function detectPayment(raw, cb) {
  const s = raw.replace(/§./g, '').replace(/[,\.]/g, m => m === ',' ? '' : '')
  const pats = [
    /^(\S+)\s+hat\s+dir\s+\$?([\d]+)\s+ge(?:geben|zahlt)/i,
    /Du\s+hast\s+\$?([\d]+)\s+von\s+(\S+)\s+erhalten/i,
    /^(\S+)\s+paid\s+you\s+\$?([\d]+)/i,
    /(\S+)\s*->\s*\$?([\d]+)/,
    /\$?([\d]+)\s+(?:von|from)\s+(\S+)/i,
    /^(\S+)\s+(?:überwiesen?|transferiert?)\s+\$?([\d]+)/i,
  ]
  for (const p of pats) {
    const m = s.match(p)
    if (m) {
      const [player, amount] = p.source.startsWith('Du') || p.source.includes('\\$.*von') 
        ? [m[2], parseFloat(m[1])] 
        : [m[1], parseFloat(m[2])]
      if (player && !isNaN(amount)) { cb(player, amount); return true }
    }
  }
  return false
}

// ── GitHub Tokens ─────────────────────────────────────────────
async function loadTokens(accountId, cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/auth-cache/${accountId}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) return
    const files = await r.json()
    if (!Array.isArray(files)) return
    for (const f of files) {
      const fr = await fetch(f.download_url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
      if (fr.ok) writeFileSync(join(cacheDir, f.name), await fr.text(), 'utf8')
    }
    console.log(`[PayBot] ✅ Tokens geladen`)
  } catch (e) { console.log('[PayBot] ⚠️ Token-Load:', e.message) }
}

async function saveTokens(accountId, cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    for (const file of readdirSync(cacheDir)) {
      const b64 = readFileSync(join(cacheDir, file)).toString('base64')
      const path = `auth-cache/${accountId}/${file}`
      let sha
      try { const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }); if (r.ok) sha = (await r.json()).sha } catch {}
      const body = { message: `[auto] ${accountId}/${file}`, content: b64 }
      if (sha) body.sha = sha
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    console.log('[PayBot] 💾 Tokens gespeichert')
  } catch (e) { console.log('[PayBot] ⚠️ Token-Save:', e.message) }
}

// ── Status HTTP ───────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const now = Date.now()
  const out = Object.entries(subs).map(([p, s]) => ({
    player: p, bot: s.assignedBot,
    active: s.lifetime || (s.expiresAt && s.expiresAt > now),
    lifetime: !!s.lifetime,
    expiresAt: s.expiresAt,
    remainingSecs: s.expiresAt ? Math.max(0, Math.floor((s.expiresAt - now) / 1000)) : null
  }))
  res.end(JSON.stringify({ freeBots: MAIN_BOTS.filter(b => !out.find(o => o.bot===b && o.active)), subscriptions: out }, null, 2))
}).listen(PORT, () => console.log(`[PayBot] Port ${PORT}`))

// ── Payout ───────────────────────────────────────────────────────
let awaitingPayout = false

// ── Bot ───────────────────────────────────────────────────────
function createBot() {
  const id = 'paybot'
  const cacheDir = join(__dirname, 'auth-cache', id)
  mkdirSync(cacheDir, { recursive: true })
  let client, reconnecting = false, spawnTimer = null, hasSpawned = false
  let entityId = BigInt(0), antiAfk = null

  const log = m => console.log(`[${new Date().toLocaleTimeString('de-DE')}] [PayBot] ${m}`)
  const strip = s => s.replace(/§./g, '')

  function sendCmd(cmd) {
    try {
      client.queue('command_request', { command: cmd, origin: { type:'player', uuid:'00000000-0000-0000-0000-000000000000', request_id:'', player_entity_id:0n }, internal:false, version:'52' })
      log(`➡️ ${cmd}`)
    } catch {}
  }

  function scheduleReconnect(delay = RECONNECT_MS, clearCache = false) {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    if (reconnecting) return
    reconnecting = true
    if (clearCache) try { rmSync(cacheDir, { recursive:true, force:true }); mkdirSync(cacheDir, { recursive:true }); log('🗑️ Cache geleert') } catch {}
    log(`🔄 Reconnect in ${delay/1000}s...`)
    setTimeout(() => { reconnecting = false; connect() }, delay)
  }

  function connect() {
    if (reconnecting) return
    hasSpawned = false
    log('Verbinde...')
    try {
      client = bedrock.createClient({ host:SERVER_HOST, port:SERVER_PORT, username:'PayBot', offline:false, connectTimeout:20000, skipPing:false, profilesFolder:cacheDir })
    } catch (e) { log(`❌ ${e.message}`); scheduleReconnect(RECONNECT_MS, true); return }

    spawnTimer = setTimeout(() => {
      if (hasSpawned) return
      log('⏰ Timeout — kein Spawn nach 20min')
      try { client?.disconnect() } catch {}
      const hasFiles = (() => { try { return readdirSync(cacheDir).length > 0 } catch { return false } })()
      scheduleReconnect(RECONNECT_MS, hasFiles)
    }, TIMEOUT_MS)

    client.on('start_game', p => { entityId = p.runtime_entity_id ?? BigInt(0) })

    client.on('spawn', () => {
      hasSpawned = true
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      log('✅ Im Server!')
      setTimeout(() => sendCmd('/home 1'), 2000)
      setTimeout(() => saveTokens(id, cacheDir), 5000)
      if (antiAfk) clearInterval(antiAfk)
      antiAfk = setInterval(() => { try { client?.write('animate', { action_id:1, runtime_entity_id:entityId }) } catch {} }, 4*60*1000)
    })

    client.on('text', packet => {
      const raw = packet.message || ''
      const srcName = strip(packet.source_name || '')
      const clean = strip(raw)
      const ci = clean.indexOf(': ')
      const sender = ci !== -1 ? clean.slice(0, ci).trim() : srcName
      const content = ci !== -1 ? clean.slice(ci+2).trim() : clean
      log(`[Chat] <${sender}> ${content}`)

      // Zahlung erkennen
      const found = detectPayment(clean, (player, amount) => {
        log(`💰 ${player} zahlt $${amount}`)
        processPayment(player, amount, sendCmd)
      })
      if (!found && (clean.includes('$') || /zahlt|paid|überwiesen/i.test(clean))) {
        log(`🔍 Mögliche Zahlung (Muster unbekannt): "${clean}"`)
      }

      // !tpa / !payout nur für Owner
      const isWhisper = clean.includes('-> Du') || clean.includes('-> dir')
      const isOwner = sender === OWNER || sender.endsWith(OWNER) || (isWhisper && clean.includes(OWNER))

      // Balance-Antwort auswerten (nach /geld)
      if (awaitingPayout) {
        const balMatch = clean.match(/(?:Guthaben|Kontostand|Konto|Saldo|Balance|Geld)[^d]*(d[d.,]+)/i)
        if (balMatch) {
          const amount = parseInt(balMatch[1].replace(/[.,]/g, ''))
          awaitingPayout = false
          if (amount > 0) {
            log(`💸 Payout: ${amount} → ${OWNER}`)
            sendCmd(`/pay ${OWNER} ${amount}`)
            setTimeout(() => sendCmd(`/pay ${OWNER} ${amount} confirm`), 2000)
            setTimeout(() => sendCmd(`/msg ${OWNER} ✅ Ausgezahlt: ${amount}`), 1500)
          } else {
            sendCmd(`/msg ${OWNER} ❌ Kein Guthaben vorhanden`)
          }
        }
      }

      if (isOwner && content.includes('!tpa')) {
        sendCmd(`/tpa ${OWNER}`)
        setTimeout(() => sendCmd(`/msg ${OWNER} TPA gesendet! ✅`), 1500)
      }
      if (isOwner && content.includes('!payout')) {
        log('💸 Payout angefragt — checke Guthaben...')
        awaitingPayout = true
        sendCmd('/geld')
      }
    })

    client.on('disconnect', r => {
      const msg = r?.message || ''
      if (antiAfk) { clearInterval(antiAfk); antiAfk = null }
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      log(isSession ? '⏳ Session aktiv — warte 3min...' : `⚠️ ${strip(msg)}`)
      scheduleReconnect(isSession ? SESSION_MS : RECONNECT_MS)
    })

    client.on('error', e => {
      const used = e.message?.includes('device_code') && e.message?.includes('already been used')
      const authErr = !used && (e.message?.includes('invalid_grant') || e.message?.includes('AADSTS'))
      log(`❌ ${e.message}`)
      scheduleReconnect(RECONNECT_MS, authErr)
    })

    client.on('close', () => { if (antiAfk) { clearInterval(antiAfk); antiAfk = null }; log('Geschlossen.'); scheduleReconnect() })
  }

  return { connect, loadTokens: () => loadTokens(id, cacheDir) }
}

// ── Start ─────────────────────────────────────────────────────
console.log('💰 PayBot startet...')
const bot = createBot()
setInterval(loadSubs, 5 * 60 * 1000)

loadSubs().then(() => bot.loadTokens()).then(() => bot.connect())
