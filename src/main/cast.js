// Chromecast-Unterstützung: Geräteerkennung (mDNS/SSDP), Medien- und YouTube-Wiedergabe,
// sowie Streaming lokaler Dateien über einen kleinen HTTP-Server im Heimnetz.
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

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

const isMdnsName = host => typeof host === 'string' && /\.local\.?$/i.test(host)

class CastManager {
  constructor (send) {
    this.send = send
    this.client = null
    this.devices = new Map()
    this.current = null // { device, title, url }
    this.server = null
    this.files = new Map()
    this.addresses = new Map()
    this.ports = new Map()
  }

  scan () {
    if (!this.client) {
      const ChromecastAPI = require('chromecast-api')
      this.client = new ChromecastAPI()
      // chromecast-api liefert per mDNS nur den Hostnamen (xyz.local), den Windows
      // meist nicht auflösen kann. Die IPv4-Adressen (A-Records) sammeln wir selbst.
      this.client._mdns?.on('response', res => {
        for (const a of [...res.answers, ...res.additionals]) {
          if (a.type === 'A') this.addresses.set(a.name.toLowerCase(), a.data)
          if (a.type === 'SRV') this.ports.set(a.name, a.data.port) // Lautsprechergruppen nutzen eigene Ports
        }
        let changed = false
        for (const d of this.devices.values()) changed = this.applyAddress(d) || changed
        if (changed) this.emitDevices()
      })
      this.client.on('device', device => {
        this.devices.set(device.name, device)
        setImmediate(() => {
          if (!this.applyAddress(device) && isMdnsName(device.host)) this.client?._mdns?.query(device.host, 'A')
          this.emitDevices()
        })
      })
    } else {
      try { this.client.update() } catch {}
    }
    this.emitDevices()
  }

  applyAddress (device) {
    if (!isMdnsName(device.host)) return false
    const ip = this.addresses.get(device.host.replace(/\.$/, '').toLowerCase())
    if (!ip) return false
    this.setHost(device, ip)
    return true
  }

  setHost (device, ip) {
    const port = this.ports.get(device.name) || 8009
    // castv2 akzeptiert statt eines Hostnamens auch { host, port }
    device.host = port === 8009 ? ip : { host: ip, port, toString: () => `${ip}:${port}` }
  }

  async resolveHost (device) {
    if (!isMdnsName(device.host)) return
    this.client?._mdns?.query(device.host, 'A')
    for (let i = 0; i < 25 && isMdnsName(device.host); i++) {
      await new Promise(r => setTimeout(r, 100))
      this.applyAddress(device)
    }
    if (isMdnsName(device.host)) {
      const { address } = await require('node:dns').promises.lookup(device.host, { family: 4 })
      this.setHost(device, address)
    }
  }

  emitDevices () {
    this.send('cast:devices', [...this.devices.values()].map(d => ({
      id: d.name, name: d.friendlyName || d.name, host: String(d.host)
    })))
  }

  async play (deviceId, media) {
    const device = this.devices.get(deviceId)
    if (!device) throw new Error('Gerät nicht gefunden')
    try {
      await this.resolveHost(device)
    } catch {
      throw new Error('Die Adresse des Geräts konnte nicht ermittelt werden.')
    }
    let url = media.url
    if (media.file) url = await this.serveFile(media.file)
    const resource = /youtube\.com|youtu\.be/.test(url)
      ? url
      : {
          url,
          contentType: media.contentType || MIME[path.extname(new URL(url).pathname).toLowerCase()] || 'video/mp4',
          cover: { title: media.title || 'Caravel Cast', url: media.poster || '' }
        }

    if (this.current && this.current.device !== device) this.stop()
    return new Promise((resolve, reject) => {
      device.play(resource, { startTime: media.startTime || 0 }, err => {
        if (err) return reject(new Error(err.message || String(err)))
        this.current = { device, title: media.title || url, url }
        if (!device.__caravelBound) {
          device.__caravelBound = true
          device.on('status', status => {
            if (this.current?.device !== device) return
            this.send('cast:status', {
              device: device.friendlyName,
              title: this.current.title,
              state: status.playerState,
              time: status.currentTime,
              duration: status.media?.duration,
              volume: status.volume?.level
            })
          })
          device.on('finished', () => {
            if (this.current?.device === device) this.send('cast:status', { device: device.friendlyName, state: 'FINISHED' })
          })
        }
        this.send('cast:status', { device: device.friendlyName, title: this.current.title, state: 'PLAYING' })
        resolve(true)
      })
    })
  }

  control (action, value) {
    const d = this.current?.device
    if (!d) return
    const done = () => {}
    switch (action) {
      case 'pause': d.pause(done); break
      case 'resume': d.resume(done); break
      case 'seekTo': d.seekTo(value, done); break
      case 'seek': d.seek(value, done); break
      case 'volume': d.setVolume(Math.max(0, Math.min(1, value)), done); break
      case 'stop': this.stop(); break
    }
  }

  stop () {
    const d = this.current?.device
    if (!d) return
    try { d.stop(() => { try { d.close() } catch {} }) } catch {}
    this.current = null
    this.send('cast:status', { state: 'STOPPED' })
  }

  // Lokale Datei im LAN bereitstellen (mit Range-Unterstützung zum Spulen)
  serveFile (filePath) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(12).toString('hex')
      this.files.set(token, filePath)
      const finish = () => {
        const { port } = this.server.address()
        resolve(`http://${lanAddress()}:${port}/${token}/${encodeURIComponent(path.basename(filePath))}`)
      }
      if (this.server) return finish()
      this.server = http.createServer((req, res) => this.handleFile(req, res))
      this.server.on('error', reject)
      this.server.listen(0, '0.0.0.0', finish)
    })
  }

  handleFile (req, res) {
    const token = (req.url || '').split('/')[1]
    const file = this.files.get(token)
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
    this.stop()
    try { this.client?.destroy?.() } catch {}
    try { this.server?.close() } catch {}
  }
}

module.exports = { CastManager }
