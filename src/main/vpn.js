// Eingebautes VPN für alle Tabs:
//  - Tor-Modus: kostenlos, ohne Konto, Ausgangsland wählbar (mitgeliefertes tor.exe)
//  - Eigene Server: SOCKS5 (auch mit Anmeldung), HTTP(S)-Proxy oder WireGuard-Konfiguration
//    (z. B. von Proton VPN, Mullvad, IVPN) – WireGuard läuft über wireproxy im Userspace,
//    also ohne Treiber und ohne Administratorrechte.
// Der gesamte Tab-Verkehr (inkl. DNS) läuft dann über den Tunnel; WebRTC wird so
// eingeschränkt, dass die echte IP nicht durchsickert.
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { t } = require('../shared/i18n')

const TOR_COUNTRIES = [
  ['auto', 'Automatisch (schnellste Route)'], ['de', 'Deutschland'], ['nl', 'Niederlande'], ['ch', 'Schweiz'],
  ['at', 'Österreich'], ['fr', 'Frankreich'], ['se', 'Schweden'], ['fi', 'Finnland'], ['no', 'Norwegen'],
  ['gb', 'Vereinigtes Königreich'], ['us', 'USA'], ['ca', 'Kanada'], ['ro', 'Rumänien'], ['pl', 'Polen'],
  ['lu', 'Luxemburg'], ['jp', 'Japan'], ['sg', 'Singapur']
]

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function waitForPort (port, timeout = 15000) {
  const until = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > until) reject(new Error(t('Der Tunnel antwortet nicht.')))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

// Liest exakt n Bytes aus einem Socket (für das SOCKS5-Protokoll)
function reader (socket) {
  let buf = Buffer.alloc(0)
  let waiting = null
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    if (waiting && buf.length >= waiting.n) {
      const { n, resolve } = waiting
      waiting = null
      const out = buf.subarray(0, n); buf = buf.subarray(n); resolve(out)
    }
  })
  return {
    read (n) {
      if (buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); return Promise.resolve(out) }
      return new Promise(resolve => { waiting = { n, resolve } })
    },
    rest () { const out = buf; buf = Buffer.alloc(0); return out },
    detach () { socket.removeAllListeners('data') }
  }
}

// Lokale SOCKS5-Brücke ohne Anmeldung → vorgelagerter SOCKS5-Server mit Benutzername/Passwort.
// Chromium unterstützt SOCKS5-Anmeldung nicht selbst.
function startSocksAuthBridge (upstream) {
  const server = net.createServer(async client => {
    client.on('error', () => {})
    try {
      const c = reader(client)
      const [ver, nMethods] = await c.read(2)
      if (ver !== 5) return client.destroy()
      await c.read(nMethods)
      client.write(Buffer.from([5, 0]))
      const head = await c.read(4)
      let addr
      if (head[3] === 1) addr = await c.read(4)
      else if (head[3] === 4) addr = await c.read(16)
      else { const [len] = await c.read(1); addr = Buffer.concat([Buffer.from([len]), await c.read(len)]) }
      const port = await c.read(2)
      const request = Buffer.concat([head, addr, port])

      const up = net.connect(upstream.port, upstream.host)
      up.on('error', () => client.destroy())
      await new Promise((resolve, reject) => { up.once('connect', resolve); up.once('error', reject) })
      const u = reader(up)
      up.write(Buffer.from([5, 1, 2]))
      const [, method] = await u.read(2)
      if (method === 2) {
        const user = Buffer.from(upstream.user || '')
        const pass = Buffer.from(upstream.pass || '')
        up.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
        const [, status] = await u.read(2)
        if (status !== 0) { client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); return up.destroy() }
      } else if (method !== 0) { client.destroy(); return up.destroy() }
      up.write(request)
      // Antwort des Upstreams unverändert an Chromium weiterreichen, danach einfach durchleiten
      const replyHead = await u.read(4)
      let replyAddr
      if (replyHead[3] === 1) replyAddr = await u.read(4)
      else if (replyHead[3] === 4) replyAddr = await u.read(16)
      else { const [len] = await u.read(1); replyAddr = Buffer.concat([Buffer.from([len]), await u.read(len)]) }
      const replyPort = await u.read(2)
      client.write(Buffer.concat([replyHead, replyAddr, replyPort]))
      const pendingUp = u.rest(); const pendingClient = c.rest()
      u.detach(); c.detach()
      if (pendingUp.length) client.write(pendingUp)
      if (pendingClient.length) up.write(pendingClient)
      client.pipe(up); up.pipe(client)
      client.on('close', () => up.destroy())
      up.on('close', () => client.destroy())
    } catch {
      client.destroy()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

class VpnManager extends EventEmitter {
  constructor ({ session, dataDir, vendorDir }) {
    super()
    this.session = session
    this.dataDir = dataDir
    this.vendorDir = vendorDir
    this.proc = null
    this.bridge = null
    this.tor = null // { socksPort, controlPort, cookie }
    this.state = { status: 'off', mode: null, label: '', progress: 0, ip: null, country: null, city: null, error: null }
    this.webContents = new Set()
  }

  static countries () { return TOR_COUNTRIES.map(([code, name]) => [code, t(name)]) }

  set (patch) {
    Object.assign(this.state, patch)
    this.emit('state', { ...this.state })
  }

  // Tabs registrieren, damit WebRTC bei aktivem VPN keine echte IP preisgibt
  track (wc) {
    this.webContents.add(wc)
    wc.once('destroyed', () => this.webContents.delete(wc))
    if (this.state.status === 'on') wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  }

  applyWebRtc (on) {
    for (const wc of this.webContents) {
      if (!wc.isDestroyed()) wc.setWebRTCIPHandlingPolicy(on ? 'disable_non_proxied_udp' : 'default')
    }
  }

  async connect (config) {
    await this.disconnect({ silent: true })
    this.set({ status: 'connecting', mode: config.mode, label: config.label || '', progress: 0, ip: null, country: null, city: null, error: null })
    try {
      let proxyRules
      if (config.mode === 'tor') proxyRules = await this.startTor(config.country)
      else proxyRules = await this.startServer(config.server)
      await this.session.setProxy({ proxyRules, proxyBypassRules: '<local>' })
      await this.session.closeAllConnections()
      this.applyWebRtc(true)
      // Erst melden, wenn tatsächlich Verkehr durch den Tunnel geht
      await this.checkIp()
      if (!this.state.ip) throw new Error(t('Über diesen Server kommt keine Verbindung zustande. Zugangsdaten bzw. Konfiguration prüfen.'))
      this.set({ status: 'on', progress: 100 })
    } catch (err) {
      await this.disconnect({ silent: true })
      this.set({ status: 'error', error: err.message || String(err) })
    }
  }

  async disconnect ({ silent = false } = {}) {
    if (this.proc) { try { this.proc.kill() } catch {} this.proc = null }
    if (this.bridge) { try { this.bridge.close() } catch {} this.bridge = null }
    this.tor = null
    try {
      await this.session.setProxy({ mode: 'direct' })
      await this.session.closeAllConnections()
    } catch {}
    this.applyWebRtc(false)
    if (!silent) this.set({ status: 'off', progress: 0, ip: null, country: null, city: null, error: null })
  }

  // --- Tor ------------------------------------------------------------------

  async startTor (country) {
    const exe = path.join(this.vendorDir, 'tor', 'tor', 'tor.exe')
    if (!fs.existsSync(exe)) throw new Error(t('Tor ist in dieser Installation nicht enthalten.'))
    const socksPort = await freePort()
    const controlPort = await freePort()
    const dataDir = path.join(this.dataDir, 'tor')
    fs.mkdirSync(dataDir, { recursive: true })
    const args = [
      '--SocksPort', `127.0.0.1:${socksPort}`,
      '--ControlPort', `127.0.0.1:${controlPort}`,
      '--CookieAuthentication', '1',
      '--DataDirectory', dataDir,
      '--GeoIPFile', path.join(this.vendorDir, 'tor', 'data', 'geoip'),
      '--GeoIPv6File', path.join(this.vendorDir, 'tor', 'data', 'geoip6'),
      '--ClientOnly', '1',
      '--Log', 'notice stdout'
    ]
    if (country && country !== 'auto') args.push('--ExitNodes', `{${country}}`, '--StrictNodes', '1')

    const proc = spawn(exe, args, { windowsHide: true })
    this.proc = proc
    await new Promise((resolve, reject) => {
      // Der allererste Start lädt das Relay-Verzeichnis und kann einige Minuten dauern
      const timer = setTimeout(() => reject(new Error(t('Tor konnte sich nicht rechtzeitig verbinden. Ist das Netzwerk blockiert?'))), 180000)
      let out = ''
      proc.stdout.on('data', chunk => {
        out += chunk.toString()
        const lines = out.split('\n'); out = lines.pop()
        for (const line of lines) {
          const m = /Bootstrapped (\d+)%/.exec(line)
          if (m) {
            this.set({ progress: +m[1] })
            if (m[1] === '100') { clearTimeout(timer); resolve() }
          }
          if (/\[err\]/.test(line)) { clearTimeout(timer); reject(new Error(line.split('[err]')[1].trim())) }
        }
      })
      proc.once('exit', code => { clearTimeout(timer); reject(new Error(t('Tor wurde beendet (Code {code}).', { code }))) })
      proc.once('error', err => { clearTimeout(timer); reject(err) })
    })
    const cookie = fs.readFileSync(path.join(dataDir, 'control_auth_cookie')).toString('hex')
    this.tor = { socksPort, controlPort, cookie }
    proc.once('exit', () => {
      if (this.proc === proc) { this.proc = null; this.set({ status: 'error', error: t('Tor wurde unerwartet beendet.') }) }
    })
    return `socks5://127.0.0.1:${socksPort}`
  }

  torCommand (commands) {
    if (!this.tor) return Promise.reject(new Error(t('Tor läuft nicht')))
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.tor.controlPort, '127.0.0.1')
      let data = ''
      sock.on('data', d => {
        data += d.toString()
        const replies = data.split('\r\n').filter(Boolean)
        if (replies.length >= commands.length + 1) {
          sock.end()
          const bad = replies.find(r => !r.startsWith('250'))
          bad ? reject(new Error(bad)) : resolve()
        }
      })
      sock.on('error', reject)
      sock.write(`AUTHENTICATE ${this.tor.cookie}\r\n` + commands.map(c => c + '\r\n').join(''))
    })
  }

  async newIdentity () {
    if (!this.tor) return
    await this.torCommand(['SIGNAL NEWNYM'])
    await this.session.closeAllConnections()
    setTimeout(() => this.checkIp(), 1500)
  }

  async setTorCountry (country) {
    if (!this.tor) return
    const cmds = country && country !== 'auto'
      ? [`SETCONF ExitNodes={${country}} StrictNodes=1`, 'SIGNAL NEWNYM']
      : ['RESETCONF ExitNodes', 'RESETCONF StrictNodes', 'SIGNAL NEWNYM']
    await this.torCommand(cmds)
    await this.session.closeAllConnections()
    setTimeout(() => this.checkIp(), 1500)
  }

  // --- Eigene Server --------------------------------------------------------

  async startServer (server) {
    if (!server) throw new Error(t('Kein Server ausgewählt.'))
    const host = (server.host || '').trim()
    const port = +server.port
    switch (server.type) {
      case 'http':
      case 'https':
        if (!host || !port) throw new Error(t('Adresse oder Port fehlt.'))
        return `${server.type}://${host}:${port}`
      case 'socks5':
        if (!host || !port) throw new Error(t('Adresse oder Port fehlt.'))
        if (!server.user) return `socks5://${host}:${port}`
        this.bridge = await startSocksAuthBridge({ host, port, user: server.user, pass: server.pass })
        return `socks5://127.0.0.1:${this.bridge.address().port}`
      case 'wireguard':
        return this.startWireGuard(server.config)
      default:
        throw new Error(t('Unbekannter Servertyp.'))
    }
  }

  async startWireGuard (config) {
    const exe = path.join(this.vendorDir, 'wireproxy', 'wireproxy.exe')
    if (!fs.existsSync(exe)) throw new Error(t('WireGuard-Unterstützung ist in dieser Installation nicht enthalten.'))
    if (!/\[Interface\]/i.test(config || '') || !/\[Peer\]/i.test(config || '')) throw new Error(t('Das ist keine gültige WireGuard-Konfiguration.'))
    const port = await freePort()
    const dir = path.join(this.dataDir, 'wireguard')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'active.conf')
    // wireproxy unterstützt nur einen Teil der wg-quick-Optionen
    const cleaned = config.split(/\r?\n/).filter(l => !/^\s*(PostUp|PostDown|PreUp|PreDown|Table|SaveConfig|FwMark)\s*=/i.test(l)).join('\n')
    fs.writeFileSync(file, `${cleaned}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`, { mode: 0o600 })
    const proc = spawn(exe, ['-c', file], { windowsHide: true })
    this.proc = proc
    let log = ''
    proc.stdout.on('data', d => { log += d })
    proc.stderr.on('data', d => { log += d })
    const exited = new Promise((_, reject) => proc.once('exit', code => reject(new Error(`${t('WireGuard-Tunnel beendet (Code {code}).', { code })} ${log.trim().split('\n').pop() || ''}`))))
    await Promise.race([waitForPort(port), exited])
    proc.once('exit', () => {
      if (this.proc === proc) { this.proc = null; this.set({ status: 'error', error: t('Der WireGuard-Tunnel wurde beendet.') }) }
    })
    return `socks5://127.0.0.1:${port}`
  }

  // --- Status ---------------------------------------------------------------

  // Öffentliche IP und Land über den Tunnel ermitteln (mehrere Dienste, da manche Tor blockieren)
  async checkIp () {
    const sources = [
      ['https://ipinfo.io/json', j => ({ ip: j.ip, country: j.country, city: j.city })],
      ['https://api.country.is/', j => ({ ip: j.ip, country: j.country, city: null })],
      ['https://api.ipify.org?format=json', j => ({ ip: j.ip })]
    ]
    for (const [url, map] of sources) {
      try {
        const res = await Promise.race([
          this.session.fetch(url, { cache: 'no-store' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
        ])
        if (!res.ok) continue
        const info = map(await res.json())
        if (info.ip) { this.set(info); return }
      } catch {}
    }
    if (this.state.status === 'on') this.set({ error: t('Verbunden, aber die öffentliche IP ließ sich nicht prüfen.') })
  }

  dispose () {
    if (this.proc) { try { this.proc.kill() } catch {} }
    if (this.bridge) { try { this.bridge.close() } catch {} }
  }
}

module.exports = { VpnManager }
