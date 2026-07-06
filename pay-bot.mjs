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
const MAIN_BOTS = ['account1','account2','account3','account4','account5','account6','account7']

// HTTP-Adressen der AFK-Bots (für /reload nach Payment)
const ACCOUNT_URLS = {
  'account1': 'http://localhost:3001',
  'account2': 'http://localhost:3002',
  'account3': 'http://localhost:3003',
  'account4': 'http://localhost:3005',
  'account5': 'http://localhost:3006',
  'account6': 'http://localhost:3007',
  'account7': 'http://localhost:3008',
}

// Nur diese exakten Beträge sind erlaubt
const VALID_AMOUNTS = {
  45000:   { seconds: 7*24*3600,  label: '1 Woche' },
  150000:  { seconds: 30*24*3600, label: '1 Monat' },
  1250000: { seconds: 0,          label: 'Lifetime' },
}

function getTier(amount) {
  return VALID_AMOUNTS[amount] || null
}

function payWithConfirm(sendCmd, player, amount) {
  sendCmd(`/pay ${player} ${amount}`)
  if (amount >= 5000) setTimeout(() => sendCmd(`/pay ${player} ${amount} confirm`), 3000)
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

// ── Online-Status der AFK-Bots prüfen (30s Cache) ───────────
let _onlineBotCache = null
let _onlineBotCacheTime = 0
async function getOnlineBots(force = false) {
  const now = Date.now()
  if (!force && _onlineBotCache && (now - _onlineBotCacheTime) < 30000) return _onlineBotCache
  const online = new Set()
  try {
    const results = await Promise.allSettled(
      Object.entries(ACCOUNT_URLS).map(([id, url]) =>
        fetch(url + '/online', { signal: AbortSignal.timeout(2500) })
          .then(r => r.json())
          .then(j => ({ id, isOnline: j?.online === true }))
      )
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.isOnline) online.add(r.value.id)
    }
  } catch {}
  _onlineBotCache = online
  _onlineBotCacheTime = now
  return online
}

// ── Gamertag-Cache (5min) ────────────────────────────────────
let _gamertagCache = null
let _gamertagCacheTime = 0
async function loadGamertagsCached() {
  const now = Date.now()
  if (_gamertagCache && (now - _gamertagCacheTime) < 5 * 60 * 1000) return _gamertagCache
  _gamertagCache = await loadGamertags()
  _gamertagCacheTime = now
  return _gamertagCache
}

// ── Zahlung verarbeiten ───────────────────────────────────────
async function processPayment(player, amount, sendMsg) {
  const tier = getTier(amount)
  if (!tier) {
    sendMsg(`/msg ${player} Ungueltiger Betrag! Erlaubt: $45.000 | $150.000 | $1.250.000`)
    payWithConfirm(sendMsg, player, amount)
    console.log(`[PayBot] [Refund] Ungueltiger Betrag ${amount} von ${player} — zurueckgezahlt`)
    return
  }

  await loadSubs()
  const now = Date.now()
  const existing = subs[player]

  if (existing?.lifetime) {
    sendMsg(`/msg ${player} Du hast bereits Lifetime! Bot: ${existing.assignedBot}`)
    return
  }

  const isLifetime = tier.seconds === 0

  // Online-Bots ermitteln (einmalig für alle Checks)
  const onlineBots = await getOnlineBots()

  // Kein einziger Bot online → sofort zurückzahlen
  if (onlineBots.size === 0) {
    console.log(`[PayBot] [Refund] Kein Bot online — zahle ${amount} zurueck an ${player}`)
    sendMsg(`/msg ${player} Aktuell ist kein Bot online. Dein Geld wird zurueckgegeben.`)
    payWithConfirm(sendMsg, player, amount)
    return
  }

  let botId = existing?.assignedBot || null
  const botStillActive = botId && (existing?.lifetime || (existing?.expiresAt && existing.expiresAt > now))

  // Prüfen ob der bereits zugewiesene Bot auch wirklich online ist
  if (botStillActive && !onlineBots.has(botId)) {
    console.log(`[PayBot] [Info] Zugewiesener Bot ${botId} ist offline — suche freien Online-Bot`)
    botId = MAIN_BOTS.filter(b => {
      const s = Object.values(subs).find(s => s.assignedBot === b && (s.lifetime || (s.expiresAt && s.expiresAt > now)))
      return !s && onlineBots.has(b)
    })[0] || null
  } else if (!botStillActive) {
    botId = MAIN_BOTS.filter(b => {
      const s = Object.values(subs).find(s => s.assignedBot === b && (s.lifetime || (s.expiresAt && s.expiresAt > now)))
      return !s && onlineBots.has(b)
    })[0] || null
  }

  if (!botId) {
    console.log(`[PayBot] [Refund] Kein freier Online-Bot — zahle ${amount} zurueck an ${player}`)
    sendMsg(`/msg ${player} Aktuell sind alle Bots vergeben. Dein Geld wird zurueckgegeben.`)
    payWithConfirm(sendMsg, player, amount)
    return
  }

  let newExpiry = null
  if (!isLifetime) {
    const base = botStillActive ? (existing.expiresAt || now) : now
    newExpiry = base + tier.seconds * 1000
  }

  subs[player] = { assignedBot: botId, expiresAt: newExpiry, lifetime: isLifetime }
  await saveSubs()
  Object.values(ACCOUNT_URLS).forEach(url => fetch(url + '/reload').catch(() => {}))

  const timeStr = isLifetime ? 'LIFETIME' : `bis ${new Date(newExpiry).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' })}`
  const gamertags = await loadGamertagsCached()
  const botName = gamertags[botId] || `Bot ${botId.replace('account', '')}`

  console.log(`[PayBot] OK ${player} -> ${botId} (${botName}) | ${amount} | ${timeStr}`)
  sendMsg(`/msg ${player} Dir wurde der Bot !${botName} hinzugefuegt! Zeit: ${timeStr}`)
}

// ── Zahlungsmuster ────────────────────────────────────────────
function detectPayment(raw, cb) {
  const s = raw.replace(/[\u00a7§]./g, '').replace(/[\u00a7§]/g, '').replace(/[,\.]/g, m => m === ',' ? '' : '')
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
  if (req.url === '/ping' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, service: 'pay-bot', uptime: Math.floor(process.uptime()) }))
  }
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

// ── Befehl-Erkennung: exaktes Wort-Matching (verhindert !tpao → !tpa) ─
const hasCmd = (msg, cmd) => msg.trim().split(/\s+/).includes(cmd)

// ── Payout ───────────────────────────────────────────────────────
let awaitingPayout = false

// ── Bot ───────────────────────────────────────────────────────
function createBot() {
  const id = 'paybot'
  const cacheDir = join(__dirname, 'auth-cache', id)
  mkdirSync(cacheDir, { recursive: true })
  let client, reconnecting = false, spawnTimer = null, hasSpawned = false, failStreak = 0
  let entityId = BigInt(0), antiAfk = null

  const log = m => console.log(`[${new Date().toLocaleTimeString('de-DE')}] [PayBot] ${m}`)
  const strip = s => s.replace(/§./g, '')
  let lastCmd = 0
  const COOLDOWN = 1500

  function extractName(raw) {
    if (raw.includes('->')) {
      const m = raw.match(/\]\s*(.+?)\s*->/)
      return m ? m[1].trim() : raw.trim()
    }
    if (raw.includes('| ')) return raw.split('| ').pop().trim()
    return raw.trim()
  }

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
    failStreak++
    const forceCache = clearCache || failStreak >= 5
    if (forceCache) {
      try { rmSync(cacheDir, { recursive:true, force:true }); mkdirSync(cacheDir, { recursive:true }) } catch {}
      if (failStreak >= 5) { log(`🗑️ Cache geleert nach ${failStreak} Fehlversuchen — frische Auth`); failStreak = 0 }
      else log('🗑️ Cache geleert')
    }
    log(`🔄 Reconnect in ${delay/1000}s...`)
    setTimeout(() => { reconnecting = false; connect() }, delay + Math.floor(Math.random() * 4000))
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
      scheduleReconnect(RECONNECT_MS, false) // failStreak wird hochgezählt, nach 5x auto-Cache-Clear
    }, TIMEOUT_MS)

    client.on('start_game', p => { entityId = p.runtime_entity_id ?? BigInt(0) })

    client.on('spawn', () => {
      hasSpawned = true
      failStreak = 0
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

      // Zahlung erkennen — nur echte Server-Nachrichten von [BlockBande]
      const isServerMsg = /^\[Blockbande\]/i.test(clean.trim())
      const found = isServerMsg && detectPayment(clean, (player, amount) => {
        log(`💰 ${player} zahlt ${amount}`)
        processPayment(player, amount, sendCmd)
      })
      // !tpa / !payout nur für Owner
      const isWhisper = clean.includes('-> Du') || clean.includes('-> dir')
      const isOwner = sender === OWNER || sender.endsWith(OWNER) || (isWhisper && clean.includes(OWNER))

      // Balance-Antwort auswerten (nach /money)
      if (awaitingPayout) {
        const balMatch = clean.match(/Kontostand:\s*\$?([\d.]+)/i)
        if (balMatch) {
          const amount = parseInt(balMatch[1].replace(/\./g, ''))
          awaitingPayout = false
          if (amount > 0) {
            log(`💸 Payout: ${amount} → ${OWNER}`)
            sendCmd(`/pay ${OWNER} ${amount}`)
            setTimeout(() => sendCmd(`/pay ${OWNER} ${amount} confirm`), 3000)
            setTimeout(() => sendCmd(`/msg ${OWNER} Ausgezahlt: ${amount}$`), 5000)
          } else {
            sendCmd(`/msg ${OWNER} Kein Guthaben vorhanden`)
          }
        }
      }

      if (!isOwner) return
      if (hasCmd(content || clean, '!ping')) {
        sendCmd(`/msg ${OWNER} PONG ok`)
        return
      }
      if (Date.now() - lastCmd < COOLDOWN) return

      const msg2 = content || clean
      if (hasCmd(msg2, '!home')) {
        lastCmd = Date.now()
        const homeNum = /!home\s+2/.test(msg2) ? '2' : '1'
        sendCmd(`/msg ${OWNER} Home ${homeNum} gesetzt!`)
        sendCmd(`/sethome ${homeNum}`)
      } else if (hasCmd(msg2, '!tpahere')) {
        lastCmd = Date.now()
        sendCmd(`/msg ${OWNER} Ich teleportiere mich zu dir, bitte annehmen!`)
        setTimeout(() => sendCmd(`/tpahere ${OWNER}`), 400)
      } else if (hasCmd(msg2, '!tpa')) {
        lastCmd = Date.now()
        sendCmd(`/msg ${OWNER} Teleportationsanfrage gesendet, bitte annehmen!`)
        setTimeout(() => sendCmd(`/tpa ${OWNER}`), 400)
      } else if (hasCmd(msg2, '!stop')) {
        lastCmd = Date.now()
        log('🛑 Stop vom Owner')
        process.exit(0)
      } else if (hasCmd(msg2, '!payout')) {
        lastCmd = Date.now()
        log('💸 Payout angefragt — checke Guthaben...')
        awaitingPayout = true
        sendCmd('/money')
      } else if (hasCmd(msg2, '!status')) {
        lastCmd = Date.now()
        const now3 = Date.now()
        const active = Object.entries(subs).filter(([, s]) =>
          s.assignedBot && (s.lifetime || (s.expiresAt && s.expiresAt > now3))
        )
        loadGamertagsCached().then(gts => {
          if (active.length === 0) {
            sendCmd(`/msg ${OWNER} Keine aktiven Subscriptions.`)
          } else {
            sendCmd(`/msg ${OWNER} Aktive Subs: ${active.length}`)
            active.forEach(([player, s], idx) => {
              const timeStr = s.lifetime ? 'Lifetime' : `bis ${new Date(s.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' })}`
              setTimeout(() => sendCmd(`/msg ${OWNER} ${idx+1}. ${player} -> !${gts[s.assignedBot] || s.assignedBot} | ${timeStr}`), (idx+1)*600)
            })
          }
        }).catch(e => log(`❌ status: ${e.message}`))
      } else if (hasCmd(msg2, '!addbot')) {
        lastCmd = Date.now()
        const addMatch = msg2.match(/!addbot\s+(\S+)\s+(\d+)/)
        const addPlayer = addMatch ? addMatch[1] : null
        const addDays   = addMatch ? parseInt(addMatch[2]) : NaN
        if (!addPlayer || isNaN(addDays) || addDays < 1) {
          sendCmd(`/msg ${OWNER} Nutzung: !addbot SpielerName Tage`)
        } else {
          ;(async () => {
            await loadSubs()
            const nowA = Date.now()
            const ex = subs[addPlayer]
            let botId = ex?.assignedBot || null
            const stillActive = botId && (ex?.lifetime || (ex?.expiresAt && ex.expiresAt > nowA))
            if (!stillActive) {
              botId = MAIN_BOTS.filter(b => {
                const taken = Object.values(subs).find(s =>
                  s.assignedBot === b && (s.lifetime || (s.expiresAt && s.expiresAt > nowA))
                )
                return !taken
              })[0] || null
            }
            if (!botId) {
              sendCmd(`/msg ${OWNER} Alle Bots vergeben! Kein freier Bot fuer ${addPlayer}.`)
            } else {
              const newExpiry = (stillActive ? (ex.expiresAt || nowA) : nowA) + addDays * 24 * 3600 * 1000
              subs[addPlayer] = { assignedBot: botId, expiresAt: newExpiry, lifetime: false }
              await saveSubs()
              Object.values(ACCOUNT_URLS).forEach(url => fetch(url + '/reload').catch(() => {}))
              const gts = await loadGamertags()
              const botName = gts[botId] || botId
              const until = new Date(newExpiry).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' })
              sendCmd(`/msg ${OWNER} ${addPlayer} -> Bot !${botName} | ${addDays} Tage (bis ${until})`)
              log(`[AddBot] ${addPlayer} -> ${botId} | ${addDays} Tage`)
            }
          })().catch(e => log(`❌ addbot: ${e.message}`))
        }
      } else if (hasCmd(msg2, '!removebot')) {
        lastCmd = Date.now()
        const remMatch = msg2.match(/!removebot\s+(\S+)/)
        const remPlayer = remMatch ? remMatch[1] : null
        if (!remPlayer) {
          sendCmd(`/msg ${OWNER} Nutzung: !removebot SpielerName`)
        } else {
          ;(async () => {
            await loadSubs()
            if (!subs[remPlayer]) {
              sendCmd(`/msg ${OWNER} ${remPlayer} hat keine aktive Subscription.`)
            } else {
              delete subs[remPlayer]
              await saveSubs()
              Object.values(ACCOUNT_URLS).forEach(url => fetch(url + '/reload').catch(() => {}))
              sendCmd(`/msg ${OWNER} ${remPlayer} wurde erfolgreich entfernt.`)
              log(`[RemoveBot] ${remPlayer} entfernt`)
            }
          })().catch(e => log(`❌ removebot: ${e.message}`))
        }
      } else if (hasCmd(msg2, '!extend')) {
        lastCmd = Date.now()
        const extMatch = msg2.match(/!extend\s+(\S+)\s+(\d+)/)
        const ePlayer = extMatch ? extMatch[1] : null
        const eDays   = extMatch ? parseInt(extMatch[2]) : NaN
        if (!ePlayer || isNaN(eDays) || eDays < 1) {
          sendCmd(`/msg ${OWNER} Nutzung: !extend SpielerName Tage`)
        } else {
          ;(async () => {
            await loadSubs()
            const eNow = Date.now()
            const eEx  = subs[ePlayer]
            if (!eEx?.assignedBot) {
              sendCmd(`/msg ${OWNER} ${ePlayer} hat keine aktive Subscription.`)
            } else if (eEx.lifetime) {
              sendCmd(`/msg ${OWNER} ${ePlayer} hat bereits Lifetime, kein Extend noetig.`)
            } else {
              const base   = (eEx.expiresAt && eEx.expiresAt > eNow) ? eEx.expiresAt : eNow
              const newExp = base + eDays * 24 * 3600 * 1000
              subs[ePlayer] = { ...eEx, expiresAt: newExp }
              await saveSubs()
              const gts  = await loadGamertags()
              const bName = gts[eEx.assignedBot] || eEx.assignedBot
              const until = new Date(newExp).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' })
              sendCmd(`/msg ${OWNER} ${ePlayer} -> !${bName} | +${eDays} Tage (neu: bis ${until})`)
              log(`[Extend] ${ePlayer} +${eDays} Tage -> bis ${until}`)
            }
          })().catch(e => log(`❌ extend: ${e.message}`))
        }
      } else if (hasCmd(msg2, '!kick')) {
        lastCmd = Date.now()
        const kickMatch = msg2.match(/!kick\s+(\S+)/)
        const kPlayer = kickMatch ? kickMatch[1] : null
        if (!kPlayer) {
          sendCmd(`/msg ${OWNER} Nutzung: !kick SpielerName`)
        } else {
          ;(async () => {
            await loadSubs()
            const kSub = subs[kPlayer]
            if (!kSub?.assignedBot) {
              sendCmd(`/msg ${OWNER} ${kPlayer} hat keine Subscription.`)
            } else {
              const kBotId = kSub.assignedBot
              delete subs[kPlayer]
              await saveSubs()
              Object.values(ACCOUNT_URLS).forEach(url => fetch(url + '/reload').catch(() => {}))
              const kBase = ACCOUNT_URLS[kBotId] || Object.values(ACCOUNT_URLS)[0]
              fetch(`${kBase}/cmd?bot=${encodeURIComponent(kBotId)}&cmd=${encodeURIComponent('/home 2')}`).catch(() => {})
              sendCmd(`/msg ${OWNER} ${kPlayer} wurde gekickt. Bot geht zu Home 2.`)
              log(`[Kick] ${kPlayer} -> ${kBotId} -> /home 2`)
            }
          })().catch(e => log(`❌ kick: ${e.message}`))
        }
      }
    })

    client.on('disconnect', r => {
      const msg = r?.message || ''
      if (antiAfk) { clearInterval(antiAfk); antiAfk = null }
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      const isRateLimit = msg.includes('zu schnell') || msg.includes('warte etwas') || msg.includes('too fast') || msg.includes('Too Many') || msg.includes('Bitte warte')
      if (isSession) log('⏳ Session aktiv — warte 3min...')
      else if (isRateLimit) log('🕐 Rate-Limit — warte 75s...')
      else log(`⚠️ ${strip(msg)}`)
      scheduleReconnect(isSession ? SESSION_MS : isRateLimit ? 75000 : RECONNECT_MS)
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
process.on('unhandledRejection', (reason) => { console.log('[System] ⚠️ Unhandled rejection:', reason?.message || String(reason)) })
process.on('uncaughtException', (e) => { console.log('[System] ❌ Uncaught exception:', e.message) })
