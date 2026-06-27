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
const AFK_SET1_URL = 'https://pranav-afk-bot.onrender.com'
const AFK_SET2_URL = 'https://pranav-afk-bot-2.onrender.com'
const MAIN_BOTS = ['account1','account2','account3','account4','account5','account6']

// Nur diese exakten Beträge sind erlaubt
const VALID_AMOUNTS = {
  45000:   { seconds: 7*24*3600,  label: '1 Woche' },
  150000:  { seconds: 30*24*3600, label: '1 Monat' },
  1250000: { seconds: 0,          label: 'Lifetime' },
}

function getTier(amount) {
  return VALID_AMOUNTS[amount] || null
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

async function getOnlineBots() {
  const online = new Set()
  try {
    const [r1, r2] = await Promise.allSettled([
      fetch(AFK_SET1_URL + '/online', { signal: AbortSignal.timeout(4000) }).then(r => r.json()),
      fetch(AFK_SET2_URL + '/online', { signal: AbortSignal.timeout(4000) }).then(r => r.json())
    ])
    if (r1.status === 'fulfilled' && r1.value?.online) {
      for (const [id, on] of Object.entries(r1.value.online)) if (on) online.add(id)
    }
    if (r2.status === 'fulfilled' && r2.value?.online) {
      for (const [id, on] of Object.entries(r2.value.online)) if (on) online.add(id)
    }
  } catch {}
  return online
}

async function getFreeBotId() {
  const now = Date.now()
  const taken = new Set(
    Object.values(subs)
      .filter(s => s.assignedBot && (s.lifetime || (s.expiresAt && s.expiresAt > now)))
      .map(s => s.assignedBot)
  )
  const online = await getOnlineBots()
  // Nur online Bots zuweisen; falls keiner online → alle als Fallback
  const available = MAIN_BOTS.filter(b => !taken.has(b) && online.has(b))
  if (available.length > 0) return available[0]
  // Kein Online-Bot frei
  return null
}

// ── Zahlung verarbeiten ───────────────────────────────────────
async function processPayment(player, amount, sendCmd) {
  const tier = getTier(amount)
  if (!tier) {
    sendCmd(`/msg ${player} Ungültiger Betrag! Erlaubt: $45.000 | $150.000 | $1.250.000`)
    sendCmd(`/pay ${player} ${amount}`)
    setTimeout(() => sendCmd(`/pay ${player} ${amount} confirm`), 3000)
    log(`[Refund] Ungültiger Betrag $${amount} von ${player} → zurückgezahlt`)
    return
  }
  const seconds = tier.seconds

  await loadSubs()
  const now = Date.now()
  const existing = subs[player]

  if (existing?.lifetime) {
    sendCmd(`/msg ${player} Du hast bereits Lifetime! Bot: ${existing.assignedBot}`)
    return
  }

  const isLifetime = tier.seconds === 0
  let botId = existing?.assignedBot || null
  const botStillActive = botId && (existing?.lifetime || (existing?.expiresAt && existing.expiresAt > now))
  if (!botStillActive) botId = await getFreeBotId()

  if (!botId) {
    log(`[Refund] Alle Bots voll — zahle $${amount} zurueck an ${player}`)
    sendCmd(`/msg ${player} Alle Bots vergeben! Dein Geld wird zurueckgegeben.`)
    sendCmd(`/pay ${player} ${amount}`)
    setTimeout(() => sendCmd(`/pay ${player} ${amount} confirm`), 3000)
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
  let entityId = BigInt(0), antiAfk = null, lastCmd = 0, awaitingPayout = false
  const COOLDOWN = 1500

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

      // Zahlung erkennen — NUR wenn [BlockBande] am Anfang steht (Server-Nachricht)
      // Wenn ein Spielername VOR [BlockBande] steht → ignorieren
      const isServerMsg = /^\[Blockbande\]/i.test(clean.trim())
      const found = isServerMsg && detectPayment(clean, (player, amount) => {
        log(`💰 ${player} zahlt $${amount}`)
        processPayment(player, amount, sendCmd)
      })
      if (!found && isServerMsg && (clean.includes('$') || /hat dir|erhalten|zahlt|paid|überwiesen/i.test(clean))) {
        log(`🔍 Unbekanntes Muster: "${clean}"`)
      }

      // Nur Owner (!Pranav123237) darf Befehle benutzen
      const isWhisper = clean.includes('-> Du') || clean.includes('-> dir') || clean.includes('-> me') || packet.type === 'whisper'
      const ownerBase = OWNER.startsWith('!') ? OWNER.slice(1) : OWNER
      const isOwner = sender === OWNER || sender === ownerBase ||
                      sender.endsWith(OWNER) || sender.endsWith(ownerBase) ||
                      srcName === OWNER || srcName === ownerBase ||
                      (isWhisper && (clean.includes(OWNER) || clean.includes(ownerBase)))


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
            setTimeout(() => sendCmd(`/say Ausgezahlt: ${amount}`), 5000)
          } else {
            sendCmd(`/say Kein Guthaben vorhanden`)
          }
        }
      }

      if (!isOwner) return
      // DEBUG: !ping — testet ob /msg funktioniert (beide Formate)
      if ((content || clean).includes('!ping') && isOwner) {
        sendCmd(`/say PONG ok`)
        return
      }
      if (Date.now() - lastCmd < COOLDOWN) return

      const msg2 = content || clean
      if (msg2.includes('!home')) {
        lastCmd = Date.now()
        const homeNum = /!home\s+2/.test(msg2) ? '2' : '1'
        sendCmd(`/msg ${ownerBase} Home ${homeNum} gesetzt`)
        sendCmd(`/sethome ${homeNum}`)
      } else if (msg2.includes('!tpahere') && isOwner) {
        lastCmd = Date.now()
        const t = extractName(sender)
        sendCmd(`/msg ${ownerBase} TPA-Here gesendet`)
        setTimeout(() => sendCmd(`/tpahere ${OWNER}`), 400)
      } else if (msg2.includes('!tpa') && isOwner) {
        lastCmd = Date.now()
        const t = extractName(sender)
        sendCmd(`/msg ${ownerBase} TPA gesendet`)
        setTimeout(() => sendCmd(`/tpa ${OWNER}`), 400)
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
            sendCmd(`/say Keine aktiven Subscriptions.`)
          } else {
            sendCmd(`/say Aktive Subs: ${active.length}`)
            active.forEach(([player, s], idx) => {
              const timeStr = s.lifetime ? 'Lifetime' : `bis ${new Date(s.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`
              setTimeout(() => sendCmd(`/msg ${ownerBase} ${idx+1}. ${player} -> !${gts[s.assignedBot] || s.assignedBot} | ${timeStr}`), (idx+1)*600)
            })
          }
        })
      } else if (msg2.includes('!payout') && isOwner) {
        lastCmd = Date.now()
        log('💸 Payout angefragt — checke Guthaben...')
        awaitingPayout = true
        sendCmd('/money')
      } else if (msg2.includes('!addbot') && isOwner) {
        lastCmd = Date.now()
        const parts = (content || clean).trim().split(/\s+/)
        const addPlayer = parts[1]
        const addDays = parseInt(parts[2])
        if (!addPlayer || isNaN(addDays) || addDays < 1) {
          sendCmd(`/say Nutzung: !addbot SpielerName Tage`)
        } else {
          ;(async () => {
            await loadSubs()
            const nowA = Date.now()
            const ex = subs[addPlayer]
            let botId = ex?.assignedBot || null
            const stillActive = botId && (ex?.lifetime || (ex?.expiresAt && ex.expiresAt > nowA))
            if (!stillActive) botId = await getFreeBotId()
            if (!botId) {
              sendCmd(`/say Alle Bots vergeben! Kein freier Bot fuer ${addPlayer}.`)
            } else {
              const newExpiry = (stillActive ? (ex.expiresAt || nowA) : nowA) + addDays * 24 * 3600 * 1000
              subs[addPlayer] = { assignedBot: botId, expiresAt: newExpiry, lifetime: false }
              await saveSubs()
              const gts = await loadGamertags()
              const botName = gts[botId] || botId
              const until = new Date(newExpiry).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
              sendCmd(`/say ${addPlayer} -> Bot !${botName} | ${addDays} Tage (bis ${until})`)
              log(`[AddBot] ${addPlayer} -> ${botId} | ${addDays} Tage`)
            }
          })()
        }
      } else if (msg2.includes('!removebot') && isOwner) {
        lastCmd = Date.now()
        const parts2 = (content || clean).trim().split(/\s+/)
        const remPlayer = parts2[1]
        if (!remPlayer) {
          sendCmd(`/say Nutzung: !removebot SpielerName`)
        } else {
          ;(async () => {
            await loadSubs()
            if (!subs[remPlayer]) {
              sendCmd(`/say ${remPlayer} hat keine aktive Subscription.`)
            } else {
              delete subs[remPlayer]
              await saveSubs()
              sendCmd(`/say ${remPlayer} entfernt.`)
              log(`[RemoveBot] ${remPlayer} entfernt`)
            }
          })()
        }
      } else if (msg2.includes('!extend') && isOwner) {
        lastCmd = Date.now()
        const eParts = (content || clean).trim().split(/\s+/)
        const ePlayer = eParts[1]
        const eDays   = parseInt(eParts[2])
        if (!ePlayer || isNaN(eDays) || eDays < 1) {
          sendCmd(`/say Nutzung: !extend SpielerName Tage`)
        } else {
          ;(async () => {
            await loadSubs()
            const eNow = Date.now()
            const eEx  = subs[ePlayer]
            if (!eEx?.assignedBot) {
              sendCmd(`/say ${ePlayer} hat keine aktive Subscription.`)
            } else if (eEx.lifetime) {
              sendCmd(`/say ${ePlayer} hat bereits Lifetime — kein Extend noetig.`)
            } else {
              const base   = (eEx.expiresAt && eEx.expiresAt > eNow) ? eEx.expiresAt : eNow
              const newExp = base + eDays * 24 * 3600 * 1000
              subs[ePlayer] = { ...eEx, expiresAt: newExp }
              await saveSubs()
              const gts  = await loadGamertags()
              const bName = gts[eEx.assignedBot] || eEx.assignedBot
              const until = new Date(newExp).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
              sendCmd(`/say ${ePlayer} -> !${bName} | +${eDays} Tage (neu: bis ${until})`)
              log(`[Extend] ${ePlayer} +${eDays} Tage -> bis ${until}`)
            }
          })()
        }
      } else if (msg2.includes('!kick') && isOwner) {
        lastCmd = Date.now()
        const kParts = (content || clean).trim().split(/\s+/)
        const kPlayer = kParts[1]
        if (!kPlayer) {
          sendCmd(`/say Nutzung: !kick SpielerName`)
        } else {
          ;(async () => {
            await loadSubs()
            const kSub = subs[kPlayer]
            if (!kSub?.assignedBot) {
              sendCmd(`/say ${kPlayer} hat keine Subscription.`)
            } else {
              const kBotId = kSub.assignedBot
              delete subs[kPlayer]
              await saveSubs()
              const kSet1 = ['account1','account2','account3'].includes(kBotId)
              const kBase = kSet1 ? AFK_SET1_URL : AFK_SET2_URL
              fetch(`${kBase}/cmd?bot=${encodeURIComponent(kBotId)}&cmd=${encodeURIComponent('/home 2')}`).catch(() => {})
              sendCmd(`/say ${kPlayer} gekickt. Bot geht zu Home 2.`)
              log(`[Kick] ${kPlayer} -> ${kBotId} -> /home 2`)
            }
          })()
        }
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
