import bedrock from 'bedrock-protocol'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'

const PORT         = process.env.PORT || 3000
// ── Log-Buffer & Status ───────────────────────────────────────
let botOnline = false
const logBuffer = []
const _origLog = console.log
console.log = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  logBuffer.push({ t: new Date().toISOString(), m: line })
  if (logBuffer.length > 200) logBuffer.shift()
  _origLog(...args)
}

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

const log = m => console.log(`[${new Date().toLocaleTimeString('de-DE')}] [Bot] ${m}`)

const stripColors = s => s.replace(/[\u00a7\u00A7§]./g, '').replace(/[\u00a7\u00A7§]/g, '')

function extractName(raw) {
  if (raw.includes('->')) {
    const m = raw.match(/\]\s*(.+?)\s*->/)
    return m ? m[1].trim() : raw.trim()
  }
  if (raw.includes('| ')) return raw.split('| ').pop().trim()
  return raw.trim()
}

// ── GitHub / Subscriptions (nur lesen) ───────────────────────
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
  if (req.url === '/reload') { loadSubs().catch(() => {}); res.end(JSON.stringify({ ok: true })); return }
  if (req.url === '/logs') {
    res.end(JSON.stringify({ ok: true, count: logBuffer.length, logs: logBuffer }))
  } else {
    res.end(JSON.stringify({ ok: true, service: 'single-bot', account: BOT_ACCOUNT, uptime: Math.floor(process.uptime()), online: botOnline }))
  }
}).listen(PORT, () => console.log(`[Bot] Status-Server Port ${PORT}`))

// ── Befehl-Erkennung: exaktes Wort-Matching (verhindert !tpao → !tpa) ─
const hasCmd = (msg, cmd) => msg.trim().split(/\s+/).includes(cmd)

// ── Bot ───────────────────────────────────────────────────────
function hasActiveSub() {
  const now = Date.now()
  return Object.values(subs).some(s =>
    s.assignedBot === BOT_ACCOUNT &&
    (s.lifetime || (s.expiresAt && s.expiresAt > now))
  )
}

function createBot() {
  const cacheDir = join(__dirname, 'auth-cache', BOT_ACCOUNT)
  mkdirSync(cacheDir, { recursive: true })
  let client, reconnecting = false, spawnTimer = null, hasSpawned = false, homeRetried = false, failStreak = 0
  let entityId = BigInt(0), antiAfk = null, subCheckInterval = null, wasActiveSub = false, lastCmd = 0, awaitingPayout = false
  const COOLDOWN = 1500

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
    failStreak++
    const forceReset = reset || failStreak >= 5
    if (forceReset) {
      try { rmSync(cacheDir, { recursive:true, force:true }); mkdirSync(cacheDir, { recursive:true }) } catch {}
      if (failStreak >= 5) { log(`🗑️ Cache geleert nach ${failStreak} Fehlversuchen — frische Auth`); failStreak = 0 }
    }
    log(`🔄 Reconnect in ${delay/1000}s...`)
    setTimeout(() => { reconnecting = false; try { connect() } catch(e) { log(`❌ connect: ${e.message}`) } }, delay + Math.floor(Math.random() * 4000))
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
      scheduleReconnect(RECONNECT_MS, false) // failStreak wird hochgezählt, nach 5x auto-Cache-Clear
    }, TIMEOUT_MS)

    client.on('start_game', p => { entityId = p.runtime_entity_id ?? BigInt(0) })

    client.on('spawn', () => {
      hasSpawned = true
      homeRetried = false
      failStreak = 0
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null }
      botOnline = true
      log('✅ Im Server!')
      wasActiveSub = hasActiveSub()
      setTimeout(() => { if (hasSpawned) sendCmd(hasActiveSub() ? '/home 1' : '/home 2') }, 5000)
      setTimeout(() => saveTokens(cacheDir), 5000)
      if (antiAfk) clearInterval(antiAfk)
      antiAfk = setInterval(() => { try { client?.write('animate', { action_id:1, runtime_entity_id:entityId }) } catch {} }, 4*60*1000)
      if (subCheckInterval) clearInterval(subCheckInterval)
      subCheckInterval = setInterval(() => {
        if (!hasSpawned) return
        const nowHasSub = hasActiveSub()
        if (wasActiveSub && !nowHasSub) {
          log('📭 Subscription abgelaufen → /home 2')
          sendCmd('/home 2')
        }
        wasActiveSub = nowHasSub
      }, 60 * 1000)
    })

    client.on('text', packet => {
      const raw = packet.message || ''
      const srcName = stripColors(packet.source_name || '')
      const clean = stripColors(raw)
      const ci = clean.indexOf(': ')
      const sender = ci !== -1 ? clean.slice(0, ci).trim() : srcName
      const content = ci !== -1 ? clean.slice(ci+2).trim() : clean
      log(`[Chat] <${sender}> ${content}`)

      // /home retry loop: immer wieder bis die Welt geladen wird
      if (hasSpawned && !homeRetried && clean.includes('Zielwelt konnte nicht gestartet werden')) {
        homeRetried = true
        log('Home-Welt Fehler -- retry in 12s...')
        setTimeout(() => {
          homeRetried = false
          if (hasSpawned) sendCmd(hasActiveSub() ? '/home 1' : '/home 2')
        }, 12000)
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
            setTimeout(() => sendCmd(`/msg ${OWNER} Auszahlung von ${amount}$ wurde erfolgreich gesendet!`), 5000)
          } else {
            sendCmd(`/msg ${OWNER} Es ist kein Guthaben vorhanden zum Auszahlen.`)
          }
        }
      }

      // Subscriber-Check: Spieler die diesem Bot zugewiesen sind duerfen !tpa benutzen
      const nowCheck = Date.now()
      const rawSender  = extractName(sender)
      const senderClean = rawSender.startsWith('!') ? rawSender.slice(1) : rawSender
      const srcClean    = srcName.startsWith('!') ? srcName.slice(1) : srcName

      // Debug: bei Bot-Commands loggen was empfangen wurde
      const msgCheck = content || clean
      if (hasCmd(msgCheck, '!tpa') || hasCmd(msgCheck, '!tpahere') || hasCmd(msgCheck, '!home') || hasCmd(msgCheck, '!status') || hasCmd(msgCheck, '!info')) {
        log('[Debug] cmd: sender=' + sender + ' | srcName=' + srcName + ' | senderClean=' + senderClean + ' | srcClean=' + srcClean + ' | BOT=' + BOT_ACCOUNT + ' | subs=' + JSON.stringify(Object.keys(subs)))
      }

      const matchedEntry = Object.entries(subs).find(([player, s]) => {
        if (s.assignedBot !== BOT_ACCOUNT) return false
        if (!s.lifetime && !(s.expiresAt && s.expiresAt > nowCheck)) return false
        const p = player.startsWith('!') ? player.slice(1) : player
        return p.toLowerCase() === senderClean.toLowerCase() ||
               p.toLowerCase() === srcClean.toLowerCase() ||
               player.toLowerCase() === sender.toLowerCase() ||
               player.toLowerCase() === srcName.toLowerCase()
      })
      const isSubscriber = !!matchedEntry

      if (isSubscriber && !isOwner) {
        const msg3 = content || clean
        const subName = matchedEntry ? matchedEntry[0] : null
        const subTarget = rawSender || subName || senderClean || srcName || sender
        if (hasCmd(msg3, '!tpahere')) {
          log('🎮 Subscriber ' + subTarget + ' -> !tpahere')
          sendCmd(`/msg ${subTarget} Ich hab dir eine tpahere anfrage geschickt!`)
          setTimeout(() => sendCmd(`/tpahere ${subTarget}`), 400)
        } else if (hasCmd(msg3, '!tpa')) {
          log('🎮 Subscriber ' + subTarget + ' -> !tpa')
          sendCmd(`/msg ${subTarget} Ich hab dir eine Tpa anfrage geschickt!`)
          setTimeout(() => sendCmd(`/tpa ${subTarget}`), 400)
        } else if (hasCmd(msg3, '!home')) {
          log('🎮 Subscriber ' + subTarget + ' -> !home')
          sendCmd('/sethome 1')
          setTimeout(() => sendCmd(`/msg ${subTarget} Dein Home wurde erfolgreich gesetzt!`), 600)
        } else if (hasCmd(msg3, '!info')) {
          log('🎮 Subscriber ' + subTarget + ' -> !info')
          const subEntry = matchedEntry ? matchedEntry[1] : null
          const timeStr = subEntry?.lifetime ? 'Lifetime' : subEntry?.expiresAt ? `bis ${new Date(subEntry.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' })}` : '?'
          sendCmd(`/msg ${subTarget} Dein Bot: ${BOT_USERNAME} | Gueltig: ${timeStr}`)
        }
        return
      }

      if (!isOwner) return

      // DEBUG: !ping — testet ob /msg funktioniert
      if (hasCmd(content || clean, '!ping') && isOwner) {
        sendCmd(`/msg ${OWNER} PONG ok`)
        return
      }
      if (Date.now() - lastCmd < COOLDOWN) return

      const msg2 = content || clean
      if (hasCmd(msg2, '!home')) {
        lastCmd = Date.now()
        const homeNum = /!home\s+2/.test(msg2) ? '2' : '1'
        sendCmd(`/msg ${OWNER} Home ${homeNum} wurde erfolgreich gesetzt!`)
        sendCmd(`/sethome ${homeNum}`)
      } else if (hasCmd(msg2, '!tpahere') && isOwner) {
        lastCmd = Date.now()
        sendCmd(`/msg ${OWNER} Ich teleportiere mich zu dir, bitte annehmen!`)
        setTimeout(() => sendCmd(`/tpahere ${OWNER}`), 400)
      } else if (hasCmd(msg2, '!tpa') && isOwner) {
        lastCmd = Date.now()
        sendCmd(`/msg ${OWNER} Teleportationsanfrage gesendet, bitte annehmen!`)
        setTimeout(() => sendCmd(`/tpa ${OWNER}`), 400)
      } else if (hasCmd(msg2, '!stop') && isOwner) {
        lastCmd = Date.now()
        log('🛑 Stop vom Owner')
        process.exit(0)
      } else if (hasCmd(msg2, '!status') && isOwner) {
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
              const timeStr = s.lifetime ? 'Lifetime' : `bis ${new Date(s.expiresAt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' })}`
              setTimeout(() => sendCmd(`/msg ${OWNER} ${idx+1}. ${player} -> !${gts[s.assignedBot] || s.assignedBot} | ${timeStr}`), (idx+1)*600)
            })
          }
        }).catch(e => log(`❌ status: ${e.message}`))
      } else if (hasCmd(msg2, '!payout') && isOwner) {
        lastCmd = Date.now()
        log('💸 Payout angefragt — checke Guthaben...')
        awaitingPayout = true
        sendCmd('/money')
      }
    })

    client.on('disconnect', r => {
      botOnline = false
      const msg = r?.message || ''
      if (antiAfk) { clearInterval(antiAfk); antiAfk = null }
      if (subCheckInterval) { clearInterval(subCheckInterval); subCheckInterval = null }
      const isSession = msg.includes('bereits auf dem Netzwerk') || msg.includes('already logged in')
      const isRateLimit = msg.includes('zu schnell') || msg.includes('warte etwas') || msg.includes('too fast') || msg.includes('Too Many') || msg.includes('Bitte warte')
      if (isSession) log('⏳ Session — warte 3min...')
      else if (isRateLimit) log('🕐 Rate-Limit — warte 75s...')
      else log(`⚠️ ${stripColors(msg)}`)
      scheduleReconnect(isSession ? SESSION_MS : isRateLimit ? 75000 : RECONNECT_MS)
    })

    client.on('error', e => {
      const msg = e.message || ''
      if (msg.includes('Read error') || msg.includes('Invalid tag')) return
      const authErr = msg.includes('invalid_grant') || msg.includes('AADSTS')
      log(`❌ ${msg}`)
      scheduleReconnect(RECONNECT_MS, authErr)
    })

    client.on('close', () => { if (antiAfk) { clearInterval(antiAfk); antiAfk = null }; if (subCheckInterval) { clearInterval(subCheckInterval); subCheckInterval = null }; log('Geschlossen.'); scheduleReconnect() })
  }

  return { connect, loadTokens: () => loadTokens(cacheDir) }
}

// ── Start ─────────────────────────────────────────────────────
console.log(`🤖 Single-Bot startet... (${BOT_ACCOUNT} / ${BOT_USERNAME})`)
console.log(`🔑 GitHub: ${GITHUB_TOKEN ? '✅' : '❌ FEHLT'}`)

const bot = createBot()
const _acctNum = parseInt(BOT_ACCOUNT.replace('account','')) || 0; setTimeout(() => setInterval(loadSubs, 5 * 60 * 1000), _acctNum * 40 * 1000)

loadSubs().then(() => bot.loadTokens()).then(() => bot.connect()).catch(e => console.log('[System] ❌ Start-Fehler:', e.message))
process.on('unhandledRejection', (reason) => { console.log('[System] ⚠️ Unhandled rejection:', reason?.message || String(reason)) })
process.on('uncaughtException', (e) => { console.log('[System] ❌ Uncaught exception:', e.message) })
