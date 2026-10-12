// Volltextsuche im Verlauf: der sichtbare Text besuchter Seiten wird lokal gespeichert
// (fulltext.json im Profil), damit Verlauf und Befehlspalette Seiten auch über ihren Inhalt finden.
const fs = require('node:fs')
const path = require('node:path')

const MAX_PAGES = 1500
const MAX_CHARS = 6000

// Im isolierten Kontext lesen – die Seite kann das Ergebnis nicht verändern
const EXTRACT_JS = `(() => {
  const b = document.body;
  if (!b) return null;
  return { title: document.title, text: (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_CHARS}) };
})()`

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

class FullText {
  constructor (dir) {
    this.file = path.join(dir, 'fulltext.json')
    this.pages = new Map() // url → { title, text, at }
    try {
      for (const [url, p] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.pages.set(url, p)
    } catch {}
    this.timer = null
  }

  scheduleSave () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 30000) // bis zu ~9 MB – selten schreiben, beim Beenden immer
  }

  flush () {
    clearTimeout(this.timer)
    this.timer = null
    try {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.pages)))
      fs.renameSync(tmp, this.file)
    } catch (err) { console.warn('[fulltext]', err.message) }
  }

  async index (wc, url) {
    if (!/^https?:/.test(url) || wc.isDestroyed() || wc.getURL() !== url) return
    let page = null
    try { page = await wc.executeJavaScriptInIsolatedWorld(1999, [{ code: EXTRACT_JS }]) } catch {}
    if (!page?.text || wc.isDestroyed() || wc.getURL() !== url) return
    this.pages.delete(url) // neu einsortieren: Map-Reihenfolge = Alter
    this.pages.set(url, { title: page.title, text: page.text, at: Date.now() })
    while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value)
    this.scheduleSave()
  }

  remove (url) { if (this.pages.delete(url)) this.scheduleSave() }

  clear () {
    this.pages.clear()
    this.flush()
  }

  // Alle Suchbegriffe müssen im Titel oder Text vorkommen; Ausschnitt um den ersten Treffer
  search (query, limit = 20) {
    const terms = norm(query).split(/\s+/).filter(t => t.length > 1)
    if (!terms.length) return []
    const hits = []
    for (const [url, p] of this.pages) {
      const text = norm(p.text)
      const title = norm(p.title)
      let score = 0
      let first = -1
      let ok = true
      for (const t of terms) {
        const inTitle = title.includes(t)
        const i = text.indexOf(t)
        if (!inTitle && i < 0) { ok = false; break }
        score += (inTitle ? 5 : 0) + (i >= 0 ? 1 : 0)
        if (i >= 0 && (first < 0 || i < first)) first = i
      }
      if (!ok) continue
      let snippet = ''
      if (first >= 0) {
        // an Wortgrenzen schneiden
        let from = Math.max(0, first - 70)
        if (from) { const sp = p.text.indexOf(' ', from); from = sp >= 0 && sp < first ? sp + 1 : from }
        let to = Math.min(p.text.length, first + 130)
        if (to < p.text.length) { const sp = p.text.lastIndexOf(' ', to); to = sp > first ? sp : to }
        snippet = (from ? '… ' : '') + p.text.slice(from, to).trim() + (to < p.text.length ? ' …' : '')
      }
      hits.push({ url, title: p.title, snippet, at: p.at, score: score + p.at / 1e13 })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...h }) => h)
  }
}

module.exports = { FullText }
