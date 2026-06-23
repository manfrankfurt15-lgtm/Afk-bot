import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'

const PORT         = process.env.PORT || 3000
const __dirname    = dirname(fileURLToPath(import.meta.url))
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API
const GITHUB_REPO  = 'manfrankfurt15-lgtm/Afk-bot'
const SERVER_HOST  = 'blockbande.de'
const SERVER_PORT  = 19132
const OWNER        = process.env.OWNER_PLAYER || '!Pranav123237'
const BOT_ACCOUNT  = process.env.BOT_ACCOUNT  || 'account7'
const BOT_USERNAME = process.env.BOT_USERNAME  || 'Bot7'
const RECONNECT_MS = 15000
const SESSION_MS   = 180000
const TIMEOUT_MS   = 20 * 60 * 1000

// Alle Haupt-Bots (für Subscription-Zuweisung)
const MAIN_BOTS = ['account1','account2','account3','account4','account5','account6']

const TIERS = [
  { min: 1250000, seconds: 0 },           // Lifetime
  { min: 150000,  seconds: 28*24*3600 },  // 28 Tage
  { min: 45000,   seconds:  7*24*3600 },  // 7 Tage
  { min: 15000,   seconds:  3*24*3600 },  // 3 Tage
  { min: 5000,    seconds:  1*24*3600 },  // 1 Tag
  { min: 1,       seconds:  1*24*3600 },  // Test: $1 = 1 Tag
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

const stripColors = s => s.replace(/[\u00a7\u00A7§]./g, '').replace(/[\u00a7\u00A7§]/g, '')

function extractName(raw) {
  if (raw.includes('->')) {
    const m = raw.match(/\]\s*(.+?)\s*->/)
    return m ? m[1].trim() : raw.trim()
  }
  if (raw.includes('| ')) return raw.split('| ').pop().trim()
  return raw.trim()
}

// ── GitHub / Subscriptions ────────────────────────────────────
let subsSha = null
let subs = {}

async function loadSubs() {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/subscriptions.json`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) { console.log('[Bot] ℹ️ Noch keine subscriptions.json'); return }
    const j = await r.json()
    subsSha = j.sha
    subs = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
    console.log(`[Bot] 📂 Subscriptions: ${Object.keys(subs).length}`)
  } catch (e) { console.log('[Bot] ⚠️ loadSubs:', e.message) }
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
    if (r.ok) { const j = await r.json(); subsSha = j.content?.sha }
  } catch (e) { console.log('[Bot] ⚠️ saveSubs:', e.message) }
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
async function processPayment(player, amount, sendCmd) {
  const seconds = calcSeconds(amount)
  if (seconds === 0 && amount < 1) {
    sendCmd(`/msg ${player} Betrag zu niedrig. Min: $1`)
    return
  }

  await loadSubs()
  const now = Date.now()
  const existing = subs[player]

  if (existing?.lifetime) {
    sendCmd(`/msg ${player} Du hast bereits Lifetime! Bot: ${existing.assignedBot}`)
    return
  }

  const isLifetime = seconds === 0
  let botId = existing?.assignedBot || null
  const botStillActive = botId && (existing?.lifetime || (existing?.expiresAt && existing.expiresAt > now))
  if (!botStillActive) botId = getFreeBotId()

  if (!botId) {
    sendCmd(`/msg ${player} Alle Bots vergeben! Versuch spaeter.`)
    return
  }

  let newExpiry = null
  if (!isLifetime) {
    const base = botStillActive ? (existing.expiresAt || now) : now
    newExpiry = base + seconds * 1000
  }

  subs[player] = { assignedBot: botId, expiresAt: newExpiry, lifetime: isLifetime }
  await saveSubs()
  // Sofort beide AFK-Bot-Services benachrichtigen → Kunden bekommt sofort Zugang
  const BOT_URLS = [
    'https://pranav-afk-bot.onrender.com/reload',
    'https://pranav-afk-bot-2.onrender.com/reload'
  ]
  BOT_URLS.forEach(url => fetch(url).catch(() => {}))

  const gamertags = await loadGamertags()
  const botName = gamertags[botId] || `Bot ${botId.replace('account', '')}`
  const timeStr = isLifetime ? 'LIFETIME' : `bis ${new Date(newExpiry).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`

  console.log(`[Bot] ✅ ${player} → ${botId} (${botName}) | $${amount} | ${timeStr}`)
  sendCmd(`/msg ${player} Dir wurde der Bot !${botName} hinzugefuegt! Zeit: ${timeStr}`)
  sendCmd(`/msg ${player} Befehl: !tpa`)
}

// ── Zahlungsmuster ────────────────────────────────────────────
function detectPayment(raw, cb) {
  const s = raw.replace(/[\u00a7\u00A7§]./g, '').replace(/[\u00a7\u00A7§]/g, '').replace(/[,.]/g, m => m === ',' ? '' : '')
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
async function loadTokens(cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/auth-cache/${BOT_ACCOUNT}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) { console.log('[Bot] ℹ️ Noch keine Tokens'); return }
    const files = await r.json()
    if (!Array.isArray(files)) return
    for (const f of files) {
      const fr = await fetch(f.download_url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
      if (fr.ok) writeFileSync(join(cacheDir, f.name), await fr.text(), 'utf8')
    }
    console.log('[Bot] ✅ Tokens geladen')
  } catch (e) { console.log('[Bot] ⚠️ Token-Load:', e.message) }
}

async function saveTokens(cacheDir) {
  if (!GITHUB_TOKEN) return
  try {
    for (const file of readdirSync(cacheDir)) {
      const b64 = readFileSync(join(cacheDir, file)).toString('base64')
      const path = `auth-cache/${BOT_ACCOUNT}/${file}`
      let sha
      try { const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }); if (r.ok) sha = (await r.json()).sha } catch {}
      const body = { message: `[auto] ${BOT_ACCOUNT}/${file}`, content: b64 }
      if (sha) body.sha = sha
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    console.log('[Bot] 💾 Tokens gespeichert')
  } catch (e) { console.log('[Bot] ⚠️ Token-Save:', e.message) }
}

// ── HTTP Status ───────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, service: 'single-bot', account: BOT_ACCOUNT, uptime: Math.floor(process.uptime()) }))
}).listen(PORT, () => console.log(`[Bot] Status-Server Port ${PORT}`))

// ── Bot ───────────────────────────────────────────────────────
function createBot() {
  const cacheDir = join(__dirname, 'auth-cache', BOT_ACCOUNT)
  mkdirSync(cacheDir, { recursive: true })
  let client, reconnecting = false, spawnTimer = null, hasSpawned = false
  let entityId = BigInt(0), antiAfk = null, lastCmd = 0
  const COOLDOWN = 5000

  const log = m => console.log(`[${new Date().toLocaleTimeString('de-DE')}] [Bot] ${m}`)

  function sendCmd(cmd) {
    try {
      client.queue('command_request', { command: cmd, origin: { type:'player', uuid:'00000000-0000-0000-0000-000000000000', request_id:'', player_entity_id:0n }, internal:false, version:'52' })
      log(`➡️ ${cmd}`)
    } catch (e) { log(`Fehler: ${e.message}`) }
  }

  function scheduleReconnect(delay = RECONNECT_MS, reset = false) {
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
    if (reconnecting) return
    reconnecting = true
    if (reset) try { rmSync(cacheDir, { recursive:true, force:true }); mkdirSync(cacheDir, { recursive:true }) } catch {}
    log(`🔄 Reconnect in ${delay/1000}s...`)
    setTimeout(() => { reconnecting = false; connect() }, delay)
  }

  function connect() {
    if (reconnecting) return
    hasSpawned = false
    log('Verbinde...')
    try {
      client = bedrock.createClient({ host:SERVER_HOST, port:SERVER_PORT, username:BOT_USERNAME, offline:false, connectTimeout:20000, skipPing:false, profilesFolder:cacheDir })
    } catch (e) { log(`❌ ${e.message}`); scheduleReconnect(RECONNECT_MS, true); return }

    spawnTimer = setTimeout(() => {
      if (hasSpawned) return
      log('⏰ Timeout — kein Spawn')
      try { client?.disconnect() } catch {}
      scheduleReconnect(RECONNECT_MS, readdirSync(cacheDir).length > 0)
    }, TIMEOUT_MS)

    client.on('start_game', p => { entityId = p.runtime_entity_id ?? BigInt(0) })

    client.on('spawn', () => {
      hasSpawned = true
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      log('✅ Im Server!')
      setTimeout(() => sendCmd('/home 1'), 5000)
      setTimeout(() => saveTokens(cacheDir), 5000)
      if (antiAfk) clearInterval(antiAfk)
      antiAfk = setInterval(() => { try { client?.write('animate', { action_id:1, runtime_entity_id:entityId }) } catch {} }, 4*60*1000)
    })

    client.on('text', packet => {
      const raw = packet.message || ''
      const srcName = stripColors(packet.source_name || '')
      const clean = stripColors(raw)
      const ci = clean.indexOf(': ')
      const sender = ci !== -1 ? clean.slice(0, ci).trim() : srcName
      const content = ci !== -1 ? clean.slice(ci+2).trim() : clean
      log(`[Chat] <${sender}> ${content}`)

      // Zahlung erkennen
      const found = detectPayment(clean, (player, amount) => {
        log(`💰 ${player} zahlt $${amount}`)
        processPayment(player, amount, sendCmd)
      })
      if (!found && (clean.includes('$') || /hat dir|erhalten|zahlt|paid|überwiesen/i.test(clean))) {
        log(`🔍 Unbekanntes Muster: "${clean}"`)
      }

      // Nur Owner (!Pranav123237) darf Befehle benutzen
      const isWhisper = clean.includes('-> Du') || clean.includes('-> dir')
      const isOwner = sender === OWNER || sender.endsWith(OWNER) || (isWhisper && clean.includes(OWNER))

      if (!isOwner) return
      if (Date.now() - lastCmd < COOLDOWN) return

      const msg2 = content || clean
      if (msg2.includes('!home')) {
        lastCmd = Date.now()
        sendCmd('/sethome 1')
        setTimeout(() => sendCmd(`/msg ${extractName(sender)} Home wurde gesetzt!`), 1500)
      } else if (msg2.includes('!tpahere')) {
        lastCmd = Date.now()
        const target = extractName(sender)
        sendCmd(`/tpahere ${target}`)
        setTimeout(() => sendCmd(`/msg ${target} TPA Here gesendet!`), 1500)
      } else if (msg2.includes('!tpa')) {
        lastCmd = Date.now()
        const target = extractName(sender)
        sendCmd(`/tpa ${target}`)
        setTimeout(() => sendCmd(`/msg ${target} TPA gesendet!`), 1500)
      } else if (msg2.includes('!stop') && isOwner) {
        lastCmd = Date.now()
        log('🛑 Stop vom Owner')
        process.exit(0)
      } else if (msg2.includes('!status') && isOwner) {
        lastCmd = Date.now()
        const now3 = Date.now()
        const active = Object.entries(subs).filter(([, s]) =>
          s.assignedBot && (s.lifetime || (s.expiresAt && s.expiresAt > now3))
        )
        loadGamertags().then(gts => {
          if (active.length === 0) {
            sendCmd(`/msg ${OWNER} Keine aktiven Subscriptions.`)
          } else {
            sendCmd(`/msg ${OWNER} Aktive Subs: ${active.length}`)
            active.forEach(([player, s], idx) => {
              const timeStr = s.lifetime ? 'Lifetime' : `bis ${new Date(s.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`
              setTimeout(() => sendCmd(`/msg ${OWNER} ${idx+1}. ${player} -> !${gts[s.assignedBot] || s.assignedBot} | ${timeStr}`), (idx+1)*600)
            })
          }
        })
      }
    })

    client.on('disconnect', r => {
      const msg = r?.message || ''
      if (antiAfk) { clearInterval(antiAfk); antiAfk = null }
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      log(isSession ? '⏳ Session — warte 3min...' : `⚠️ ${stripColors(msg)}`)
      scheduleReconnect(isSession ? SESSION_MS : RECONNECT_MS)
    })

    client.on('error', e => {
      const authErr = e.message?.includes('invalid_grant') || e.message?.includes('AADSTS')
      log(`❌ ${e.message}`)
      scheduleReconnect(RECONNECT_MS, authErr)
    })

    client.on('close', () => { if (antiAfk) { clearInterval(antiAfk); antiAfk = null }; log('Geschlossen.'); scheduleReconnect() })
  }

  return { connect, loadTokens: () => loadTokens(cacheDir) }
}

// ── Start ─────────────────────────────────────────────────────
console.log(`🤖 Single-Bot startet... (${BOT_ACCOUNT} / ${BOT_USERNAME})`)
console.log(`🔑 GitHub: ${GITHUB_TOKEN ? '✅' : '❌ FEHLT'}`)

const bot = createBot()
setInterval(loadSubs, 30 * 1000)

loadSubs().then(() => bot.loadTokens()).then(() => bot.connect())
