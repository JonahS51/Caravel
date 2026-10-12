// Sync über einen Ordner (z. B. OneDrive, Dropbox, Netzlaufwerk): Favoriten, Seiten-Notizen, Boosts,
// Zeitkapseln und Passwörter landen verschlüsselt in <Ordner>/Caravel-Sync.dat.
//
// Verschlüsselung: AES-256-GCM, Schlüssel per scrypt aus einer Passphrase, die nur auf den Geräten
// liegt (mit safeStorage gesichert). Zusammenführen: Drei-Wege-Abgleich gegen den Stand des letzten
// Syncs (sync-base.bin) – so werden Löschungen erkannt und Änderungen beider Seiten übernommen.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { safeStorage } = require('electron')
const { t } = require('../shared/i18n')

const FILE_NAME = 'Caravel-Sync.dat'
const KEYS = ['bookmarks', 'notes', 'boosts', 'snapshots', 'passwords']
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

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
  get enabled () { return !!this.dir && this.hasPassphrase() }
  get remoteFile () { return path.join(this.dir, FILE_NAME) }

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

  readRemote () {
    let text
    try { text = fs.readFileSync(this.remoteFile, 'utf8') } catch (err) {
      if (err.code === 'ENOENT') return { salt: crypto.randomBytes(16), payload: null, stamp: null }
      throw err
    }
    return { ...this.decrypt(text), stamp: crypto.createHash('sha256').update(text).digest('hex') }
  }

  remoteStamp () {
    try { return crypto.createHash('sha256').update(fs.readFileSync(this.remoteFile)).digest('hex') } catch { return null }
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
      if (!fs.existsSync(this.dir)) throw new Error(t('Der Sync-Ordner ist nicht erreichbar.'))
      const before = this.local()
      const base = this.readBase()
      const remote = this.readRemote()
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
        // Hat ein anderes Gerät inzwischen geschrieben, erst dessen Stand übernehmen
        if (this.remoteStamp() !== remote.stamp) {
          if (attempt < 3) return this.doRun(attempt + 1)
          throw new Error(t('Die Sync-Datei wird gerade von einem anderen Gerät geschrieben.'))
        }
        const text = this.encrypt({ v: 1, updated: Date.now(), device: os.hostname(), data: merged }, remote.salt)
        const tmp = this.remoteFile + '.' + process.pid + '.tmp'
        fs.writeFileSync(tmp, text)
        fs.renameSync(tmp, this.remoteFile)
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

module.exports = { FolderSync, merge3, bookmarksToMap, bookmarksFromMap, FILE_NAME }
