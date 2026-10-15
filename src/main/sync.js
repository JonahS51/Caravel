// Sync von Favoriten, Seiten-Notizen, Boosts, Zeitkapseln und Passwörtern – auf zwei Wegen:
//  • Ordner (z. B. OneDrive, Dropbox, Netzlaufwerk): alles landet verschlüsselt in <Ordner>/Caravel-Sync.dat
//  • Caravel Cloud: dieselbe verschlüsselte Datei liegt auf dem Sync-Server (web/functions/api/sync)
//
// Verschlüsselung: AES-256-GCM, Schlüssel per scrypt aus einer Passphrase, die nur auf den Geräten
// liegt (mit safeStorage gesichert). In der Cloud ist die Passphrase ein zufälliger Sync-Code; aus ihm
// werden auch Konto-ID und Zugriffstoken abgeleitet – ein Benutzerkonto gibt es nicht.
// Zusammenführen: Drei-Wege-Abgleich gegen den Stand des letzten Syncs (sync-base.bin) – so werden
// Löschungen erkannt und Änderungen beider Seiten übernommen.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { safeStorage, net } = require('electron')
const { t } = require('../shared/i18n')

const FILE_NAME = 'Caravel-Sync.dat'
const KEYS = ['bookmarks', 'notes', 'boosts', 'snapshots', 'passwords']
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const SERVER = (process.env.CARAVEL_SYNC_URL || 'https://caravel-browser.pages.dev').replace(/\/+$/, '')
const CLOUD_INTERVAL = 10 * 60 * 1000 // seltener als beim Ordner: jede Abfrage zählt gegen das Server-Kontingent

// Sync-Code: 25 Zeichen Crockford-Base32 (125 Bit), in Fünfergruppen geschrieben
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function newCode () {
  const bytes = crypto.randomBytes(25)
  return [...bytes].map(b => CODE_ALPHABET[b & 31]).join('').match(/.{5}/g).join('-')
}
// Tippfehler-tolerant: Groß/klein, Leerzeichen und Bindestriche egal, O→0, I/L→1, U→V
function normalizeCode (code) {
  const s = String(code || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V')
  return s.length === 25 && [...s].every(c => CODE_ALPHABET.includes(c)) ? s : null
}
const formatCode = code => code.match(/.{5}/g).join('-')
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex')

class Conflict extends Error {}

// JSON mit sortierten Schlüsseln – gleiche Daten ergeben auf jedem Gerät denselben Text
function stable (v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
const same = (a, b) => stable(a) === stable(b)

// Drei-Wege-Abgleich je Eintrag: wer vom gemeinsamen Stand abweicht, gewinnt; ändern beide, entscheidet resolve
function merge3 (local = {}, base = {}, remote = {}, resolve = l => l) {
  const out = {}
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
    const l = local[k]; const b = base[k]; const r = remote[k]
    let v
    if (same(l, b)) v = r
    else if (same(r, b)) v = l
    else if (l === undefined) v = r // hier gelöscht, dort geändert: Änderung behalten
    else if (r === undefined) v = l
    else v = resolve(l, r)
    if (v !== undefined) out[k] = v
  }
  return out
}
const newer = (l, r) => (r.updated || 0) > (l.updated || 0) ? r : l

// Favoriten (Leiste mit einer Ordnerebene) ↔ flache Liste { id: { parent, pos, … } }
function bookmarksToMap (list = []) {
  const map = {}
  list.forEach((b, i) => {
    if (b.folder) {
      map[b.id] = { folder: true, title: b.title, parent: '', pos: i }
      ;(b.children || []).forEach((c, j) => { map[c.id] = { url: c.url, title: c.title, favicon: c.favicon || null, parent: b.id, pos: j } })
    } else map[b.id] = { url: b.url, title: b.title, favicon: b.favicon || null, parent: '', pos: i }
  })
  return map
}

function bookmarksFromMap (map) {
  const entries = Object.entries(map)
  const folders = new Set(entries.filter(([, v]) => v.folder).map(([id]) => id))
  const byPos = (a, b) => a[1].pos - b[1].pos || a[0].localeCompare(b[0])
  const seen = new Set()
  const link = ([id, v]) => ({ id, url: v.url, title: v.title, favicon: v.favicon || null })
  const dedupe = (items, parent) => items.filter(([, v]) => {
    if (v.folder) return true
    const key = parent + '\n' + v.url
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // Einträge ohne (noch vorhandenen) Ordner landen in der Leiste
  const root = dedupe(entries.filter(([, v]) => v.folder || !v.parent || !folders.has(v.parent)).sort(byPos), '')
  return root.map(([id, v]) => v.folder
    ? { id, folder: true, title: v.title, children: dedupe(entries.filter(([, c]) => !c.folder && c.parent === id).sort(byPos), id).map(link) }
    : link([id, v]))
}

function listToMap (list = []) {
  const map = {}
  for (const { id, ...rest } of list) if (id) map[id] = rest
  return map
}
const listFromMap = map => Object.entries(map).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b.created || 0) - (a.created || 0))

// Doppelte Zugangsdaten (auf zwei Geräten getrennt gespeichert): den neueren behalten
function dedupePasswords (map) {
  const best = new Map()
  for (const [id, r] of Object.entries(map)) {
    const key = r.origin + '\n' + r.username
    const cur = best.get(key)
    if (!cur || (r.updated || 0) > (map[cur].updated || 0)) best.set(key, id)
  }
  const keep = new Set(best.values())
  return Object.fromEntries(Object.entries(map).filter(([id]) => keep.has(id)))
}

class FolderSync {
  constructor ({ dataDir, store, passwords, onApplied, onState }) {
    Object.assign(this, { store, passwords, onApplied, onState })
    this.keyFile = path.join(dataDir, 'sync-key.bin')
    this.baseFile = path.join(dataDir, 'sync-base.bin')
    this.state = { status: 'off', last: 0, error: null }
    this.keyCache = null // { salt, key }
    this.timer = null
    this.running = null
  }

  setState (patch) {
    Object.assign(this.state, patch)
    this.onState?.({ ...this.state })
  }

  get dir () { return this.store.get('settings').syncDir || '' }
  get cloud () { return !this.dir && !!this.store.get('settings').syncCloud }
  get enabled () { return (!!this.dir || this.cloud) && this.hasPassphrase() }
  get remoteFile () { return path.join(this.dir, FILE_NAME) }

  // Cloud: Konto-ID und Token aus dem Sync-Code (der Server erfährt den Code selbst nie)
  cloudAuth () {
    const code = this.passphrase() || ''
    return { url: `${SERVER}/api/sync/${sha256('caravel-sync-id:' + code).slice(0, 32)}`, token: sha256('caravel-sync-token:' + code) }
  }

  async cloudFetch (method, headers = {}, body, retry = true) {
    const { url, token } = this.cloudAuth()
    let res
    try {
      res = await net.fetch(url, { method, body, cache: 'no-store', headers: { authorization: `Bearer ${token}`, ...headers } })
    } catch {
      res = null
    }
    // Kurze Aussetzer einmal wiederholen – gefahrlos, weil Schreiben per If-Match an die Version gebunden ist
    if (retry && (!res || res.status >= 500)) {
      await new Promise(r => setTimeout(r, 1500))
      return this.cloudFetch(method, headers, body, false)
    }
    if (!res) throw new Error(t('Der Sync-Server ist nicht erreichbar.'))
    if (res.status === 401 || res.status === 403) throw new Error(t('Der Sync-Server hat den Sync-Code abgelehnt.'))
    if (res.status === 413) throw new Error(t('Die Sync-Daten sind zu groß für den Sync-Server.'))
    if (res.status === 429 || res.status >= 500) throw new Error(t('Der Sync-Server ist gerade überlastet – später erneut versuchen.'))
    return res
  }

  // Sync-Code zum Einrichten weiterer Geräte
  cloudCode () { return this.cloud && this.hasPassphrase() ? formatCode(this.passphrase() || '') : null }

  // Alle Daten dieses Sync-Codes vom Server löschen
  async deleteCloud () {
    const res = await this.cloudFetch('DELETE')
    if (!res.ok) throw new Error(t('Der Sync-Server ist nicht erreichbar.'))
  }

  // Regelmäßiger Abgleich (alle fünf Minuten aufgerufen); die Cloud nur alle zehn Minuten
  periodic () {
    if (this.cloud && Date.now() - this.state.last < CLOUD_INTERVAL - 30000) return Promise.resolve(false)
    return this.run()
  }

  hasPassphrase () { return fs.existsSync(this.keyFile) }
  passphrase () { try { return safeStorage.decryptString(fs.readFileSync(this.keyFile)) } catch { return null } }

  setPassphrase (p) {
    p = String(p || '')
    if (!p) { try { fs.unlinkSync(this.keyFile) } catch {} } else fs.writeFileSync(this.keyFile, safeStorage.encryptString(p), { mode: 0o600 })
    this.keyCache = null
  }

  // Ausschalten: Passphrase und Abgleichsstand vergessen (die Datei im Ordner bleibt)
  disable () {
    this.setPassphrase('')
    try { fs.unlinkSync(this.baseFile) } catch {}
    clearTimeout(this.timer)
    this.setState({ status: 'off', error: null })
  }

  // Ordner gewechselt oder neue Passphrase: der alte Abgleichsstand passt nicht mehr
  resetBase () { try { fs.unlinkSync(this.baseFile) } catch {} }

  key (salt) {
    if (this.keyCache && this.keyCache.salt.equals(salt)) return this.keyCache.key
    const key = crypto.scryptSync(this.passphrase() || '', salt, 32, SCRYPT)
    this.keyCache = { salt, key }
    return key
  }

  encrypt (obj, salt) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', this.key(salt), iv)
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
    return JSON.stringify({ format: 'caravel-sync', v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })
  }

  decrypt (text) {
    const f = JSON.parse(text)
    if (f.format !== 'caravel-sync') throw new Error(t('Die Sync-Datei ist beschädigt.'))
    const salt = Buffer.from(f.salt, 'base64')
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key(salt), Buffer.from(f.iv, 'base64'))
      d.setAuthTag(Buffer.from(f.tag, 'base64'))
      return { salt, payload: JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8')) }
    } catch { throw new Error(t('Die Passphrase passt nicht zur Sync-Datei in diesem Ordner.')) }
  }

  // Entfernter Stand: { salt, payload, stamp } – stamp erkennt beim Schreiben, ob ein anderes Gerät dazwischenkam
  async readRemote () {
    let text, stamp
    if (this.cloud) {
      const res = await this.cloudFetch('GET')
      if (res.status === 404) return { salt: crypto.randomBytes(16), payload: null, stamp: null }
      if (!res.ok) throw new Error(t('Der Sync-Server ist nicht erreichbar.'))
      text = await res.text()
      stamp = res.headers.get('etag')
    } else {
      try { text = fs.readFileSync(this.remoteFile, 'utf8') } catch (err) {
        if (err.code === 'ENOENT') return { salt: crypto.randomBytes(16), payload: null, stamp: null }
        throw err
      }
      stamp = sha256(text)
    }
    return { ...this.decrypt(text), stamp }
  }

  remoteStamp () {
    try { return crypto.createHash('sha256').update(fs.readFileSync(this.remoteFile)).digest('hex') } catch { return null }
  }

  // Schreiben nur, wenn der entfernte Stand noch der gelesene ist – sonst Conflict
  async writeRemote (text, stamp) {
    if (this.cloud) {
      const res = await this.cloudFetch('PUT', { 'content-type': 'application/json', ...(stamp ? { 'if-match': stamp } : { 'if-none-match': '*' }) }, text)
      if (res.status === 412) throw new Conflict()
      if (!res.ok) throw new Error(t('Der Sync-Server ist nicht erreichbar.'))
      return
    }
    if (this.remoteStamp() !== stamp) throw new Conflict()
    const tmp = this.remoteFile + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, this.remoteFile)
  }

  readBase () {
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(this.baseFile))) } catch { return {} }
  }

  writeBase (data) { fs.writeFileSync(this.baseFile, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 }) }

  local () {
    return {
      bookmarks: bookmarksToMap(this.store.get('bookmarks')),
      notes: { ...this.store.get('notes') },
      boosts: { ...this.store.get('boosts') },
      snapshots: listToMap(this.store.get('snapshots')),
      passwords: this.passwords.available ? this.passwords.exportPlain() : {}
    }
  }

  // Nach lokalen Änderungen etwas warten, damit mehrere Änderungen in einem Durchgang landen
  schedule (delay = 20000) {
    if (!this.enabled) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run().catch(() => {}), delay)
  }

  run () {
    if (!this.enabled) return Promise.resolve(false)
    if (this.running) return this.running
    this.running = this.doRun().finally(() => { this.running = null })
    return this.running
  }

  async doRun (attempt = 0) {
    this.setState({ status: 'syncing', error: null })
    try {
      if (!this.cloud && !fs.existsSync(this.dir)) throw new Error(t('Der Sync-Ordner ist nicht erreichbar.'))
      const remote = await this.readRemote()
      const before = this.local()
      const base = this.readBase()
      const rdata = remote.payload?.data || {}
      const merged = {
        bookmarks: merge3(before.bookmarks, base.bookmarks, rdata.bookmarks),
        notes: merge3(before.notes, base.notes, rdata.notes, newer),
        boosts: merge3(before.boosts, base.boosts, rdata.boosts),
        snapshots: merge3(before.snapshots, base.snapshots, rdata.snapshots),
        passwords: this.passwords.available ? dedupePasswords(merge3(before.passwords, base.passwords, rdata.passwords, newer)) : (rdata.passwords || {})
      }
      // Favoriten nach dem Abgleich normalisieren (Positionen, doppelte Links)
      merged.bookmarks = bookmarksToMap(bookmarksFromMap(merged.bookmarks))

      // In der Zwischenzeit lokal geändert? Dann gleich noch einmal (nichts überschreiben)
      if (!same(this.local(), before)) {
        if (attempt < 3) return this.doRun(attempt + 1)
        throw new Error(t('Caravel ändert gerade Daten – später erneut versuchen.'))
      }
      const changed = {}
      if (!same(merged.bookmarks, before.bookmarks)) { changed.bookmarks = bookmarksFromMap(merged.bookmarks); this.store.set('bookmarks', changed.bookmarks) }
      if (!same(merged.notes, before.notes)) { changed.notes = merged.notes; this.store.set('notes', merged.notes) }
      if (!same(merged.boosts, before.boosts)) { changed.boosts = merged.boosts; this.store.set('boosts', merged.boosts) }
      if (!same(merged.snapshots, before.snapshots)) { changed.snapshots = listFromMap(merged.snapshots); this.store.set('snapshots', changed.snapshots) }
      if (this.passwords.available && !same(merged.passwords, before.passwords)) { this.passwords.applyPlain(merged.passwords); changed.passwords = true }
      if (Object.keys(changed).length) this.onApplied?.(changed)

      if (!remote.payload || !same(merged, rdata)) {
        const text = this.encrypt({ v: 1, updated: Date.now(), device: os.hostname(), data: merged }, remote.salt)
        try { await this.writeRemote(text, remote.stamp) } catch (err) {
          if (!(err instanceof Conflict)) throw err
          // Ein anderes Gerät hat inzwischen geschrieben: erst dessen Stand übernehmen
          if (attempt < 3) return this.doRun(attempt + 1)
          throw new Error(t('Die Sync-Datei wird gerade von einem anderen Gerät geschrieben.'))
        }
      }
      this.writeBase(merged)
      this.setState({ status: 'idle', last: Date.now(), error: null, changed: Object.keys(changed) })
      return true
    } catch (err) {
      this.setState({ status: 'error', error: err.message })
      throw err
    }
  }
}

module.exports = { FolderSync, merge3, bookmarksToMap, bookmarksFromMap, newCode, normalizeCode, FILE_NAME }
