// Leseliste: Artikel (Leser-Modus-Fassung) samt Bildern offline speichern.
// Die Übersicht (Titel, Adresse, gelesen …) liegt im Store unter „readingList“; der Inhalt jedes
// Artikels als eigene Datei in <Profil>/ReadingList/<id>.json, damit der Store klein bleibt.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_IMAGES = 30
const MAX_IMAGE_BYTES = 800 * 1024
const MAX_TOTAL_BYTES = 6 * 1024 * 1024

class ReadingList {
  constructor (dir, session) {
    this.dir = path.join(dir, 'ReadingList')
    this.session = session
  }

  file (id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Ungültige ID')
    return path.join(this.dir, id + '.json')
  }

  // Bilder des Artikels laden und als data:-URLs einbetten (mit den Cookies der Tab-Sitzung)
  async inlineImages (html) {
    const srcs = [...new Set([...html.matchAll(/<img\b[^>]*?\ssrc="(https?:\/\/[^"]+)"/gi)].map(m => m[1]))].slice(0, MAX_IMAGES)
    let total = 0
    const map = new Map()
    await Promise.all(srcs.map(async raw => {
      const src = raw.replace(/&amp;/g, '&')
      try {
        const res = await this.session.fetch(src, { signal: AbortSignal.timeout(15000) })
        const type = (res.headers.get('content-type') || '').split(';')[0].trim()
        if (!res.ok || !/^image\//.test(type) || /svg/.test(type)) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > MAX_IMAGE_BYTES || total + buf.length > MAX_TOTAL_BYTES) return
        total += buf.length
        map.set(raw, `data:${type};base64,${buf.toString('base64')}`)
      } catch {}
    }))
    return html.replace(/(<img\b[^>]*?\ssrc=")(https?:\/\/[^"]+)(")/gi, (m, a, src, b) => map.has(src) ? a + map.get(src) + b : m)
  }

  async save (art) {
    fs.mkdirSync(this.dir, { recursive: true })
    const id = crypto.randomBytes(8).toString('hex')
    const content = await this.inlineImages(String(art.content || ''))
    const data = {
      title: String(art.title || ''), byline: String(art.byline || ''), siteName: String(art.siteName || ''),
      lang: String(art.lang || ''), text: String(art.text || ''), content
    }
    fs.writeFileSync(this.file(id), JSON.stringify(data))
    return { id, bytes: Buffer.byteLength(content) }
  }

  get (id) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) } catch { return null }
  }

  remove (id) {
    try { fs.unlinkSync(this.file(id)) } catch {}
  }
}

module.exports = { ReadingList }
