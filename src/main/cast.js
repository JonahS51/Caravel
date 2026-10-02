// Chromecast wie in Chrome: Geräteerkennung (mDNS), direkte Verbindungen über das Cast-Protokoll (castv2),
// Cast-Apps von Webseiten (Presentation API des Cast SDK, z. B. der Cast-Knopf im YouTube-Player),
// Tab- und Bildschirmspiegelung als Live-Stream sowie Medien und lokale Dateien über den Standard-Medienempfänger.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Client } = require('castv2')
const { t } = require('../shared/i18n')

const NS = {
  conn: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media'
}
const DEFAULT_RECEIVER = 'CC1AD845'
const SENDER = 'sender-caravel'
const CAPS = [[1, 'video_out'], [2, 'video_in'], [4, 'audio_out'], [8, 'audio_in'], [32, 'multizone_group']]

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.m3u8': 'application/x-mpegURL'
}

function lanAddress () {
  const candidates = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) candidates.push(i.address)
    }
  }
  return candidates.find(a => a.startsWith('192.168.')) ||
    candidates.find(a => a.startsWith('10.')) ||
    candidates.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
    candidates[0] || '127.0.0.1'
}

// ---------------------------------------------------------------------------
// Geräteerkennung über mDNS (_googlecast._tcp)

class Discovery extends EventEmitter {
  constructor () {
    super()
    this.mdns = null
    this.srv = new Map() // Instanzname → { target, port }
    this.txt = new Map() // Instanzname → TXT-Werte
    this.ips = new Map() // Hostname → IPv4
    this.devices = new Map()
    this.timers = []
  }

  start () {
    if (this.mdns) return this.query()
    this.mdns = require('multicast-dns')()
    this.mdns.on('response', res => this.onResponse(res))
    this.mdns.on('error', () => {})
    // Die ersten Anfragen gehen oft verloren, solange der Multicast-Beitritt läuft
    for (const ms of [0, 1500, 4000, 8000]) this.timers.push(setTimeout(() => this.query(), ms))
    const iv = setInterval(() => this.query(), 30000)
    iv.unref?.()
    this.timers.push(iv)
  }

  query () {
    try { this.mdns?.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }) } catch {}
  }

  onResponse (res) {
    for (const a of [...res.answers, ...res.additionals]) {
      if (a.type === 'PTR' && a.name === '_googlecast._tcp.local' && a.ttl === 0) {
        this.srv.delete(a.data)
        this.txt.delete(a.data)
      } else if (a.type === 'SRV' && /_googlecast\._tcp\.local$/.test(a.name)) {
        this.srv.set(a.name, { target: a.data.target.toLowerCase(), port: a.data.port })
      } else if (a.type === 'TXT' && /_googlecast\._tcp\.local$/.test(a.name)) {
        const txt = {}
        for (const b of [].concat(a.data)) {
          const [k, ...v] = b.toString().split('=')
          txt[k] = v.join('=')
        }
        this.txt.set(a.name, txt)
      } else if (a.type === 'A') {
        this.ips.set(a.name.toLowerCase(), a.data)
      }
    }
    this.rebuild()
  }

  rebuild () {
    let changed = false
    const seen = new Set()
    for (const [name, srv] of this.srv) {
      const txt = this.txt.get(name)
      if (!txt) continue
      const host = this.ips.get(srv.target)
      if (!host) { try { this.mdns.query(srv.target, 'A') } catch {} continue }
      const id = txt.id || name
      const caps = parseInt(txt.ca, 10) || 0
      const group = txt.md === 'Google Cast Group' || !!(caps & 32)
      const dev = {
        id,
        name: txt.fn || name.split('._googlecast')[0],
        model: group ? 'Lautsprechergruppe' : (txt.md || 'Chromecast'),
        caps,
        kind: group ? 'group' : (caps & 1) ? 'tv' : 'speaker',
        host,
        port: srv.port
      }
      seen.add(id)
      const old = this.devices.get(id)
      if (!old || old.host !== dev.host || old.port !== dev.port || old.name !== dev.name) {
        this.devices.set(id, dev)
        changed = true
      }
    }
    for (const id of [...this.devices.keys()]) {
      if (!seen.has(id)) { this.devices.delete(id); changed = true }
    }
    if (changed) this.emit('change')
  }

  dispose () {
    for (const tm of this.timers) { clearTimeout(tm); clearInterval(tm) }
    try { this.mdns?.destroy() } catch {}
    this.mdns = null
  }
}

// ---------------------------------------------------------------------------
// Verbindung zu einem Gerät (TLS, Port 8009)

class Receiver extends EventEmitter {
  constructor (dev) {
    super()
    this.dev = dev
    this.client = null
    this.ready = null
    this.reqId = 1
    this.pending = new Map()
    this.status = null
    this.joined = new Set()
    this.heartbeat = null
  }

  connect () {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const client = new Client()
      let done = false
      const fail = err => {
        if (done) return
        done = true
        this.reset()
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error(t('Das Gerät antwortet nicht.'))), 7000)
      client.once('error', fail)
      client.connect({ host: this.dev.host, port: this.dev.port }, () => {
        if (done) return
        done = true
        clearTimeout(timer)
        client.removeListener('error', fail)
        client.on('error', () => this.reset())
        client.on('close', () => this.reset())
        client.on('message', (src, dst, ns, data) => this.onMessage(src, dst, ns, data))
        this.sendRaw('receiver-0', NS.conn, { type: 'CONNECT' })
        this.heartbeat = setInterval(() => this.sendRaw('receiver-0', NS.heartbeat, { type: 'PING' }), 5000)
        this.request('receiver-0', NS.receiver, { type: 'GET_STATUS' }).catch(() => {})
        resolve(this)
      })
      this.client = client
    })
    return this.ready
  }

  get connected () { return !!this.client?.ps }

  reset () {
    clearInterval(this.heartbeat)
    this.heartbeat = null
    const client = this.client
    this.client = null
    this.ready = null
    this.joined.clear()
    try { client?.close() } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(t('Verbindung zum Gerät getrennt'))) }
    this.pending.clear()
    if (client) this.emit('close')
  }

  sendRaw (dst, ns, data) {
    if (!this.client?.ps) throw new Error(t('Nicht mit dem Gerät verbunden'))
    this.client.send(SENDER, dst, ns, typeof data === 'string' ? data : JSON.stringify(data))
  }

  request (dst, ns, msg, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.reqId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(t('Zeitüberschreitung')))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.sendRaw(dst, ns, { ...msg, requestId: id })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  onMessage (src, dst, ns, data) {
    if (dst !== SENDER && dst !== '*') return
    if (ns === NS.heartbeat) {
      if (data.includes('PING')) try { this.sendRaw(src, NS.heartbeat, { type: 'PONG' }) } catch {}
      return
    }
    let msg = null
    try { msg = JSON.parse(data) } catch {}
    if (ns === NS.conn && msg?.type === 'CLOSE') {
      if (src === 'receiver-0') return this.reset()
      this.joined.delete(src)
      return
    }
    if (msg?.requestId && this.pending.has(msg.requestId)) {
      const p = this.pending.get(msg.requestId)
      this.pending.delete(msg.requestId)
      clearTimeout(p.timer)
      p.resolve(msg)
      msg.__answered = true
    }
    if (ns === NS.receiver && msg?.type === 'RECEIVER_STATUS') {
      this.status = msg.status
      this.emit('status', msg.status)
    }
    this.emit('message', { src, ns, data, msg })
  }

  join (transportId) {
    if (this.joined.has(transportId)) return
    this.sendRaw(transportId, NS.conn, {
      type: 'CONNECT',
      origin: {},
      userAgent: 'Caravel',
      senderInfo: { sdkType: 2, version: '15.605.1.3', browserVersion: process.versions.chrome, platform: 4, systemVersion: 'Windows', connectionType: 1 }
    })
    this.joined.add(transportId)
  }

  app (sessionId) {
    const apps = this.status?.applications || []
    return sessionId ? apps.find(a => a.sessionId === sessionId) : apps.find(a => !a.isIdleScreen)
  }

  async launch (appId) {
    const res = await this.request('receiver-0', NS.receiver, { type: 'LAUNCH', appId }, 30000)
    if (res.type === 'LAUNCH_ERROR') {
      throw new Error(res.reason === 'NOT_FOUND' ? t('Diese App gibt es auf dem Gerät nicht.') : t('Die App konnte nicht gestartet werden.'))
    }
    let app = (res.status?.applications || []).find(a => a.appId === appId)
    for (let i = 0; !app && i < 40; i++) {
      await new Promise(r => setTimeout(r, 250))
      app = (this.status?.applications || []).find(a => a.appId === appId)
    }
    if (!app) throw new Error(t('Die App wurde nicht gestartet.'))
    return app
  }

  async availability (appIds) {
    const res = await this.request('receiver-0', NS.receiver, { type: 'GET_APP_AVAILABILITY', appId: appIds }, 6000)
    return res.availability || {}
  }

  stopApp (sessionId) {
    return this.request('receiver-0', NS.receiver, { type: 'STOP', sessionId })
  }

  setVolume (volume) {
    return this.request('receiver-0', NS.receiver, { type: 'SET_VOLUME', volume })
  }
}

// ---------------------------------------------------------------------------
// Live-Stream (Tab-/Bildschirmspiegelung): WebM-Daten des MediaRecorder per HTTP ausliefern.
// Ein später verbundenes Gerät bekommt den Kopf (EBML, Tracks) und alles ab dem letzten Cluster,
// das mit einem Video-Schlüsselbild beginnt – sonst kann es das Bild nicht decodieren.

const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75])
const ID_CLUSTER = 0x1f43b675
const ID_SIMPLEBLOCK = 0xa3

// EBML-Zahl variabler Länge ab Position p (null, wenn noch nicht vollständig)
function readVint (b, p, keepMarker) {
  if (p >= b.length) return null
  const first = b[p]
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8 || p + len > b.length) return null
  let value = keepMarker ? first : first & (0xff >> len)
  for (let i = 1; i < len; i++) value = value * 256 + b[p + i]
  const unknown = !keepMarker && value === Math.pow(2, 7 * len) - 1
  return { value, len, unknown }
}

class LiveStream {
  constructor (contentType) {
    this.contentType = contentType
    this.videoTrack = contentType.startsWith('video/') ? 1 : null // MediaRecorder: Video = Spur 1
    this.headParts = []
    this.head = null
    this.chunks = [] // { off, buf } ab dem letzten Schlüsselbild-Cluster
    this.total = 0
    this.gopStart = 0
    this.pending = Buffer.alloc(0)
    this.pendingOff = 0
    this.cluster = null // { off, decided }
    this.clients = new Set()
    this.ended = false
  }

  push (buf) {
    if (!this.head) {
      const first = buf.indexOf(CLUSTER)
      if (first < 0) { this.headParts.push(buf); return }
      this.head = Buffer.concat([...this.headParts, buf.subarray(0, first)])
      this.headParts = []
      for (const res of this.clients) res.write(this.head)
      buf = buf.subarray(first)
    }
    this.chunks.push({ off: this.total, buf })
    this.total += buf.length
    for (const res of this.clients) res.write(buf)
    this.parse(buf)
  }

  // Cluster-Anfänge und Schlüsselbilder finden (nur Kopfdaten der Blöcke werden gelesen)
  parse (buf) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf
    const b = this.pending
    let p = 0
    while (p < b.length) {
      const id = readVint(b, p, true)
      const size = id && readVint(b, p + id.len, false)
      if (!size) break
      const dataStart = p + id.len + size.len
      if (id.value === ID_CLUSTER) {
        this.cluster = { off: this.pendingOff + p, decided: false }
        p = dataStart // Cluster mit unbekannter Größe: Kindelemente folgen direkt
        continue
      }
      if (size.unknown) { p = dataStart; continue }
      if (id.value === ID_SIMPLEBLOCK && this.cluster && !this.cluster.decided) {
        const track = readVint(b, dataStart, false)
        if (!track || dataStart + track.len + 3 > b.length) break
        if (this.videoTrack === null || track.value === this.videoTrack) {
          this.cluster.decided = true
          const key = b[dataStart + track.len + 2] & 0x80
          if (key) this.setGopStart(this.cluster.off)
        }
      }
      if (dataStart + size.value > b.length) break
      p = dataStart + size.value
    }
    this.pending = b.subarray(p)
    this.pendingOff += p
    // Ohne neue Schlüsselbilder nicht unbegrenzt puffern
    while (this.chunks.length > 1 && this.total - this.chunks[0].off > 32e6) this.chunks.shift()
  }

  setGopStart (off) {
    this.gopStart = off
    while (this.chunks.length && this.chunks[0].off + this.chunks[0].buf.length <= off) this.chunks.shift()
  }

  attach (req, res) {
    res.writeHead(200, {
      'Content-Type': this.contentType,
      'Cache-Control': 'no-cache, no-store',
      'Access-Control-Allow-Origin': '*',
      Connection: 'keep-alive'
    })
    if (req.method === 'HEAD') return res.end()
    if (this.ended) return res.end()
    if (this.head) {
      res.write(this.head)
      for (const c of this.chunks) {
        res.write(c.off < this.gopStart ? c.buf.subarray(this.gopStart - c.off) : c.buf)
      }
    }
    this.clients.add(res)
    req.on('close', () => this.clients.delete(res))
  }

  end () {
    this.ended = true
    for (const res of this.clients) { try { res.end() } catch {} }
    this.clients.clear()
  }
}

// ---------------------------------------------------------------------------

class CastManager {
  constructor (send) {
    this.send = send
    this.discovery = new Discovery()
    this.discovery.on('change', () => { this.emitDevices(); this.emitAvailability() })
    this.receivers = new Map()
    this.activities = new Map() // Geräte-ID → laufende Sitzung dieses Browsers
    this.connections = new Map() // Verbindungs-ID (Webseite) → { act, wc, clientId }
    this.pageApps = new Map() // wcId → { urls, appIds, origin } (navigator.presentation.defaultRequest)
    this.availabilityWcs = new Set()
    this.appAvailability = new Map() // `${deviceId}|${appId}` → bool
    this.server = null
    this.files = new Map()
    this.streams = new Map()
    this.idleTimer = null
  }

  // ---- Geräte ------------------------------------------------------------

  scan () {
    this.discovery.start()
    // Wie Chrome: beim Öffnen des Dialogs den Status aller Geräte abfragen („YouTube“, „Netflix“ …)
    for (const dev of this.discovery.devices.values()) this.rx(dev.id).connect().catch(() => {})
    clearTimeout(this.idleTimer)
    this.emitDevices()
  }

  // Dialog geschlossen: ungenutzte Verbindungen nach einer Weile wieder trennen
  idle () {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      for (const [id, rx] of this.receivers) {
        if (!this.activities.has(id)) rx.reset()
      }
    }, 60000)
  }

  rx (deviceId) {
    let rx = this.receivers.get(deviceId)
    const dev = this.discovery.devices.get(deviceId)
    if (rx && dev && (rx.dev.host !== dev.host || rx.dev.port !== dev.port)) { rx.reset(); rx.dev = dev }
    if (rx) return rx
    if (!dev) throw new Error(t('Gerät nicht gefunden'))
    rx = new Receiver(dev)
    rx.on('status', () => { this.onReceiverStatus(deviceId); this.emitDevices() })
    rx.on('message', m => this.onReceiverMessage(deviceId, m))
    rx.on('close', () => {
      const act = this.activities.get(deviceId)
      if (act) this.endActivity(act, 'closed')
      this.emitDevices()
    })
    this.receivers.set(deviceId, rx)
    return rx
  }

  emitDevices () {
    this.send('cast:devices', [...this.discovery.devices.values()].map(d => {
      const rx = this.receivers.get(d.id)
      const app = rx?.connected ? rx.app() : null
      return {
        id: d.id,
        name: d.name,
        model: d.model,
        kind: d.kind,
        host: d.host,
        app: app ? (app.displayName || '') : '',
        statusText: app ? (app.statusText || '') : '',
        volume: rx?.status?.volume || null
      }
    }).sort((a, b) => a.name.localeCompare(b.name, 'de')))
    this.emitSessions()
  }

  emitSessions () {
    this.send('cast:sessions', [...this.activities.values()].map(a => ({
      deviceId: a.deviceId,
      device: this.discovery.devices.get(a.deviceId)?.name || '',
      kind: a.kind,
      title: a.title,
      appName: a.displayName || '',
      wcId: a.wcId || null,
      state: a.media?.playerState || null,
      time: a.media?.currentTime ?? null,
      duration: a.media?.media?.duration ?? a.duration ?? null,
      at: a.mediaAt || 0,
      volume: this.receivers.get(a.deviceId)?.status?.volume || null
    })))
  }

  async availability (appIds) {
    const out = {}
    await Promise.all([...this.discovery.devices.keys()].map(async id => {
      try {
        const rx = this.rx(id)
        await rx.connect()
        const res = await rx.availability(appIds)
        out[id] = appIds.some(a => res[a] === 'APP_AVAILABLE')
        for (const a of appIds) this.appAvailability.set(`${id}|${a}`, res[a] === 'APP_AVAILABLE')
      } catch { out[id] = false }
    }))
    return out
  }

  // ---- Status vom Gerät --------------------------------------------------

  onReceiverStatus (deviceId) {
    const act = this.activities.get(deviceId)
    if (!act) return
    const rx = this.receivers.get(deviceId)
    const app = rx.app(act.sessionId)
    if (!app) return this.endActivity(act, 'terminated') // am Fernseher beendet oder durch andere App ersetzt
    act.displayName = app.displayName
    if (act.kind === 'app') this.broadcast(act, 'update_session', this.sessionObject(act))
    this.emitSessions()
  }

  onReceiverMessage (deviceId, { src, ns, data, msg }) {
    const act = this.activities.get(deviceId)
    if (!act || src !== act.transportId) return
    if (ns === NS.media && msg?.type === 'MEDIA_STATUS') {
      const st = msg.status?.[0]
      if (st) {
        act.media = { ...(act.media || {}), ...st }
        act.mediaSessionId = st.mediaSessionId
        act.mediaAt = Date.now()
        if (st.playerState === 'IDLE' && st.idleReason === 'FINISHED' && act.kind === 'media') act.media.playerState = 'FINISHED'
      }
      this.emitSessions()
      if (act.kind === 'app' && !msg.__answered) {
        this.broadcast(act, 'v2_message', { ...msg, status: (msg.status || []).map(s => ({ ...s, sessionId: act.sessionId })) })
      }
      return
    }
    if (act.kind === 'app' && ns !== NS.media) {
      this.broadcast(act, 'app_message', { sessionId: act.sessionId, namespaceName: ns, message: data })
    }
  }

  // ---- Sitzungen ---------------------------------------------------------

  async launchActivity (deviceId, appId, fields) {
    const rx = this.rx(deviceId)
    await rx.connect()
    const prev = this.activities.get(deviceId)
    if (prev) this.endActivity(prev, 'replaced')
    const app = await rx.launch(appId)
    rx.join(app.transportId)
    const act = {
      deviceId,
      appId,
      sessionId: app.sessionId,
      transportId: app.transportId,
      displayName: app.displayName,
      media: null,
      ...fields
    }
    this.activities.set(deviceId, act)
    clearTimeout(this.idleTimer)
    this.emitSessions()
    return act
  }

  endActivity (act, reason) {
    if (this.activities.get(act.deviceId) !== act) return
    this.activities.delete(act.deviceId)
    if (act.stream) { act.stream.end(); this.streams.delete(act.token) }
    if (act.kind === 'app') {
      for (const [connId, c] of this.connections) {
        if (c.act !== act) continue
        this.connections.delete(connId)
        if (!c.wc.isDestroyed()) c.wc.send('castp:event', { connId, type: reason === 'closed' ? 'close' : 'terminate', reason: 'error' })
      }
    }
    this.send('cast:ended', { deviceId: act.deviceId, kind: act.kind, reason })
    this.emitSessions()
  }

  async stop (deviceId) {
    const act = this.activities.get(deviceId)
    if (!act) return
    const rx = this.receivers.get(deviceId)
    try { await rx?.stopApp(act.sessionId) } catch {}
    this.endActivity(act, 'stopped')
  }

  // Video-/Audio-URL oder lokale Datei über den Standard-Medienempfänger abspielen
  async play (deviceId, media) {
    let url = media.url
    if (media.file) url = await this.serveFile(media.file)
    const contentType = media.contentType ||
      MIME[path.extname(new URL(url).pathname).toLowerCase()] || 'video/mp4'
    const act = await this.launchActivity(deviceId, DEFAULT_RECEIVER, {
      kind: media.kind || 'media',
      title: media.title || url,
      wcId: media.wcId || null,
      token: media.token || null,
      stream: media.token ? this.streams.get(media.token) : null,
      local: !!(media.file || media.token) // hängt an Caravels HTTP-Server
    })
    const rx = this.receivers.get(deviceId)
    const res = await rx.request(act.transportId, NS.media, {
      type: 'LOAD',
      autoplay: true,
      currentTime: media.startTime || 0,
      media: {
        contentId: url,
        contentUrl: url,
        contentType,
        streamType: media.live ? 'LIVE' : 'BUFFERED',
        metadata: { metadataType: 0, title: media.title || '', images: media.poster ? [{ url: media.poster }] : [] }
      }
    }, 30000)
    if (res.type !== 'MEDIA_STATUS') {
      this.stop(deviceId)
      throw new Error(res.type === 'LOAD_FAILED' ? t('Das Gerät konnte das Medium nicht laden.') : t('Fehler des Geräts ({type})', { type: res.type }))
    }
    return true
  }

  control (deviceId, action, value) {
    const act = this.activities.get(deviceId)
    const rx = this.receivers.get(deviceId)
    if (!act || !rx) return
    if (action === 'stop') return this.stop(deviceId)
    if (action === 'volume') return rx.setVolume({ level: Math.max(0, Math.min(1, value)) }).catch(() => {})
    if (action === 'mute') return rx.setVolume({ muted: !!value }).catch(() => {})
    if (!act.mediaSessionId) return
    const base = { mediaSessionId: act.mediaSessionId }
    const send = msg => rx.request(act.transportId, NS.media, { ...base, ...msg }).catch(() => {})
    const now = (act.media?.currentTime || 0) + (act.media?.playerState === 'PLAYING' ? (Date.now() - (act.mediaAt || Date.now())) / 1000 : 0)
    switch (action) {
      case 'pause': return send({ type: 'PAUSE' })
      case 'resume': return send({ type: 'PLAY' })
      case 'seekTo': return send({ type: 'SEEK', currentTime: value })
      case 'seek': return send({ type: 'SEEK', currentTime: Math.max(0, now + value) })
    }
  }

  // ---- Spiegelung (Tab / Bildschirm) -------------------------------------

  createLive (audioOnly) {
    const token = crypto.randomBytes(12).toString('hex')
    this.streams.set(token, new LiveStream(audioOnly ? 'audio/webm' : 'video/webm'))
    return token
  }

  pushLive (token, buf) {
    this.streams.get(token)?.push(buf)
  }

  endLive (token) {
    const s = this.streams.get(token)
    if (!s) return
    s.end()
    this.streams.delete(token)
    for (const act of this.activities.values()) {
      if (act.token === token) this.stop(act.deviceId)
    }
  }

  async mirror (deviceId, { token, kind, title, audioOnly, wcId }) {
    if (!this.streams.has(token)) throw new Error(t('Kein Stream vorhanden'))
    const port = await this.ensureServer()
    const url = `http://${lanAddress()}:${port}/live/${token}.webm`
    return this.play(deviceId, {
      url,
      kind,
      title,
      wcId,
      token,
      live: true,
      contentType: audioOnly ? 'audio/webm' : 'video/webm'
    })
  }

  // ---- Cast-Apps von Webseiten (Presentation API) --------------------------

  static appIdsFromUrls (urls) {
    const ids = []
    for (const u of urls || []) {
      const m = /^cast:([0-9A-Za-z]+)/.exec(u)
      if (m && !ids.includes(m[1])) ids.push(m[1])
    }
    return ids
  }

  setPageApp (wc, urls, origin) {
    const appIds = CastManager.appIdsFromUrls(urls)
    if (appIds.length) this.pageApps.set(wc.id, { appIds, origin })
    else this.pageApps.delete(wc.id)
  }

  pageApp (wcId) {
    return this.pageApps.get(wcId) || null
  }

  watchAvailability (wc) {
    if (this.availabilityWcs.has(wc)) return
    this.availabilityWcs.add(wc)
    this.discovery.start()
    wc.once('destroyed', () => this.availabilityWcs.delete(wc))
  }

  emitAvailability () {
    const value = this.discovery.devices.size > 0
    for (const wc of this.availabilityWcs) {
      if (!wc.isDestroyed()) wc.send('castp:event', { type: 'availability', value })
    }
  }

  hasDevices () { return this.discovery.devices.size > 0 }

  async startApp (deviceId, appIds, wc, origin) {
    let appId = appIds[0]
    if (appIds.length > 1) {
      const rx = this.rx(deviceId)
      await rx.connect()
      const avail = await rx.availability(appIds).catch(() => ({}))
      appId = appIds.find(a => avail[a] === 'APP_AVAILABLE') || appId
    }
    const act = await this.launchActivity(deviceId, appId, {
      kind: 'app',
      title: origin ? new URL(origin).hostname.replace(/^www\./, '') : '',
      wcId: wc.id,
      origin,
      presentationId: null
    })
    act.presentationId = 'cast-session_' + act.sessionId
    return this.connectPage(act, wc)
  }

  connectPage (act, wc) {
    const connId = crypto.randomBytes(8).toString('hex')
    this.connections.set(connId, { act, wc, clientId: null })
    if (!wc.__caravelCastBound) {
      wc.__caravelCastBound = true
      wc.once('destroyed', () => {
        for (const [id, c] of this.connections) if (c.wc === wc) this.connections.delete(id)
        this.pageApps.delete(wc.id)
      })
    }
    return { connId, presentationId: act.presentationId, url: 'cast:' + act.appId }
  }

  reconnectPage (wc, urls, id, origin) {
    const appIds = CastManager.appIdsFromUrls(urls)
    for (const act of this.activities.values()) {
      if (act.kind !== 'app' || !appIds.includes(act.appId)) continue
      const match = id === 'auto-join'
        ? act.origin === origin && act.wcId === wc.id
        : act.presentationId === id && act.origin === origin
      if (match) {
        act.wcId = wc.id
        return this.connectPage(act, wc)
      }
    }
    return null
  }

  pageClose (connId) {
    this.connections.delete(connId)
  }

  pageTerminate (connId) {
    const c = this.connections.get(connId)
    if (c) this.stop(c.act.deviceId)
  }

  sessionObject (act) {
    const rx = this.receivers.get(act.deviceId)
    const dev = this.discovery.devices.get(act.deviceId) || rx?.dev || {}
    const app = rx?.app(act.sessionId) || {}
    const volume = rx?.status?.volume || { level: 1, muted: false }
    return {
      sessionId: act.sessionId,
      appId: act.appId,
      displayName: app.displayName || act.displayName || '',
      appImages: app.iconUrl ? [{ url: app.iconUrl }] : [],
      receiver: {
        label: crypto.createHash('sha1').update(act.deviceId).digest('base64url').slice(0, 22),
        friendlyName: dev.name || '',
        capabilities: CAPS.filter(([bit]) => (dev.caps || 0) & bit).map(([, name]) => name),
        volume: { level: volume.level ?? 1, muted: !!volume.muted },
        isActiveInput: null,
        displayStatus: null,
        receiverType: 'cast'
      },
      senderApps: app.senderApps || [],
      namespaces: app.namespaces || [],
      media: [],
      status: 'connected',
      statusText: app.statusText || '',
      transportId: act.transportId
    }
  }

  // Nachricht an alle Seiten-Clients einer Sitzung (sequenceNumber -1 = unaufgefordert)
  broadcast (act, type, message) {
    for (const [connId, c] of this.connections) {
      if (c.act === act && c.clientId) this.reply(connId, c, type, message, -1)
    }
  }

  reply (connId, c, type, message, sequenceNumber) {
    if (c.wc.isDestroyed()) return
    const data = JSON.stringify({ type, message, sequenceNumber: sequenceNumber ?? -1, timeoutMillis: 0, clientId: c.clientId })
    c.wc.send('castp:event', { connId, type: 'message', data })
  }

  async pageMessage (connId, raw) {
    const c = this.connections.get(connId)
    if (!c) return
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.clientId) c.clientId = msg.clientId
    const act = c.act
    const rx = this.receivers.get(act.deviceId)
    const seq = msg.sequenceNumber
    const fail = (description) => this.reply(connId, c, 'error', { code: 'session_error', description, details: null }, seq)
    if (!rx || this.activities.get(act.deviceId) !== act) return fail(t('Sitzung beendet'))

    switch (msg.type) {
      case 'client_connect':
        this.reply(connId, c, 'new_session', this.sessionObject(act), -1)
        if (act.media) {
          this.reply(connId, c, 'v2_message', { type: 'MEDIA_STATUS', status: [{ ...act.media, sessionId: act.sessionId }] }, -1)
        }
        return
      case 'leave_session':
        this.reply(connId, c, 'leave_session', null, seq)
        return
      case 'app_message': {
        const m = msg.message || {}
        try {
          rx.join(act.transportId)
          rx.sendRaw(act.transportId, m.namespaceName, typeof m.message === 'string' ? m.message : JSON.stringify(m.message))
          this.reply(connId, c, 'app_message', null, seq)
        } catch (err) { fail(err.message) }
        return
      }
      case 'v2_message': {
        const m = { ...(msg.message || {}) }
        try {
          if (m.type === 'STOP' && m.mediaSessionId === undefined) {
            await rx.stopApp(act.sessionId).catch(() => {})
            this.reply(connId, c, 'v2_message', null, seq)
            this.endActivity(act, 'terminated')
            return
          }
          if (m.type === 'SET_VOLUME' && m.mediaSessionId === undefined) {
            const res = await rx.setVolume(m.volume)
            this.reply(connId, c, 'v2_message', res, seq)
            return
          }
          const map = { STOP_MEDIA: 'STOP', MEDIA_SET_VOLUME: 'SET_VOLUME', MEDIA_GET_STATUS: 'GET_STATUS' }
          if (map[m.type]) m.type = map[m.type]
          delete m.requestId
          rx.join(act.transportId)
          const res = await rx.request(act.transportId, NS.media, m, msg.timeoutMillis > 0 ? msg.timeoutMillis : 30000)
          if (res.type === 'MEDIA_STATUS') res.status = (res.status || []).map(s => ({ ...s, sessionId: act.sessionId }))
          this.reply(connId, c, 'v2_message', res, seq)
        } catch (err) { fail(err.message) }
        return
      }
      default:
        fail(t('Nicht unterstützt: {type}', { type: msg.type }))
    }
  }

  // ---- HTTP-Server im Heimnetz (lokale Dateien, Live-Streams) ---------------

  ensureServer () {
    return new Promise((resolve, reject) => {
      if (this.server?.listening) return resolve(this.server.address().port)
      if (!this.server) {
        this.server = http.createServer((req, res) => this.handleHttp(req, res))
        this.server.on('error', reject)
        this.server.listen(0, '0.0.0.0')
      }
      this.server.once('listening', () => resolve(this.server.address().port))
    })
  }

  async serveFile (filePath) {
    const token = crypto.randomBytes(12).toString('hex')
    this.files.set(token, filePath)
    const port = await this.ensureServer()
    return `http://${lanAddress()}:${port}/${token}/${encodeURIComponent(path.basename(filePath))}`
  }

  handleHttp (req, res) {
    const parts = (req.url || '').split('/')
    if (parts[1] === 'live') {
      const stream = this.streams.get((parts[2] || '').replace(/\.webm$/, ''))
      if (!stream) { res.writeHead(404); return res.end() }
      return stream.attach(req, res)
    }
    const file = this.files.get(parts[1])
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
    const size = fs.statSync(file).size
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0
      const end = range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    }
  }

  dispose () {
    // Spiegelungen und lokale Dateien enden mit dem Browser; Apps wie YouTube laufen am Gerät weiter (wie in Chrome)
    for (const act of [...this.activities.values()]) {
      if (!act.local) continue
      try { this.receivers.get(act.deviceId)?.sendRaw('receiver-0', NS.receiver, { type: 'STOP', sessionId: act.sessionId, requestId: 0 }) } catch {}
    }
    for (const rx of this.receivers.values()) rx.reset()
    this.discovery.dispose()
    for (const s of this.streams.values()) s.end()
    try { this.server?.close() } catch {}
  }
}

module.exports = { CastManager }
