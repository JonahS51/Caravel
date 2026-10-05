// Import von Favoriten und Verlauf aus Chromium-Browsern (Chrome, Edge, Brave).
// Favoriten stehen als JSON in „Bookmarks“, der Verlauf in der SQLite-Datei „History“. Passwörter
// verschlüsselt Chrome inzwischen an den Browser gebunden – dafür gibt es den CSV-Import im Passwort-Manager.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { t } = require('../shared/i18n')

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const BROWSERS = [
  ['chrome', 'Google Chrome', path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
  ['edge', 'Microsoft Edge', path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
  ['brave', 'Brave', path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')]
]

// Alle Profile aller installierten Browser
function sources () {
  const out = []
  for (const [id, name, dir] of BROWSERS) {
    if (!fs.existsSync(dir)) continue
    let profiles = {}
    try { profiles = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8')).profile?.info_cache || {} } catch {}
    const keys = Object.keys(profiles).length ? Object.keys(profiles) : ['Default']
    for (const key of keys) {
      const pdir = path.join(dir, key)
      const bookmarks = fs.existsSync(path.join(pdir, 'Bookmarks'))
      const history = fs.existsSync(path.join(pdir, 'History'))
      if (!bookmarks && !history) continue
      const pname = profiles[key]?.name
      out.push({ id: `${id}|${key}`, name: keys.length > 1 && pname ? `${name} – ${pname}` : name, bookmarks, history })
    }
  }
  return out
}

function profileDir (sourceId) {
  const [id, key] = String(sourceId).split('|')
  const b = BROWSERS.find(x => x[0] === id)
  if (!b || !key || key.includes('..') || /[\\/]/.test(key)) throw new Error(t('Unbekannte Quelle'))
  return path.join(b[2], key)
}

// Favoriten im Caravel-Format: Links und Ordner mit einer Ebene (tiefere Ordner werden eingeebnet)
function bookmarks (sourceId, newId) {
  const data = JSON.parse(fs.readFileSync(path.join(profileDir(sourceId), 'Bookmarks'), 'utf8'))
  const link = n => /^(https?|file|ftp):/i.test(n.url || '') ? { id: newId(), url: n.url, title: n.name || n.url, favicon: null } : null
  const flatten = n => n.type === 'url' ? [link(n)].filter(Boolean) : (n.children || []).flatMap(flatten)
  const bar = []
  for (const n of data.roots?.bookmark_bar?.children || []) {
    if (n.type === 'url') { const l = link(n); if (l) bar.push(l) } else bar.push({ id: newId(), folder: true, title: n.name || t('Ordner'), children: flatten(n) })
  }
  const extra = [...(data.roots?.other?.children || []), ...(data.roots?.synced?.children || [])].flatMap(flatten)
  return { bar, other: extra }
}

// Verlauf (neueste zuerst). Die Datei ist gesperrt, solange der Browser läuft – daher eine Kopie lesen.
function history (sourceId, limit = 3000) {
  const { DatabaseSync } = require('node:sqlite')
  const src = path.join(profileDir(sourceId), 'History')
  const tmp = path.join(os.tmpdir(), `caravel-import-${process.pid}-${Date.now()}.sqlite`)
  try {
    fs.copyFileSync(src, tmp)
  } catch (err) {
    throw new Error(err.code === 'EBUSY' ? t('Der Verlauf ist gesperrt – bitte den Browser schließen und erneut versuchen.') : err.message)
  }
  let db = null
  try {
    db = new DatabaseSync(tmp, { readOnly: true })
    // Chromium-Zeit: Mikrosekunden seit 1601-01-01 – zu groß für JavaScript-Zahlen, daher schon in SQL
    // auf Millisekunden kürzen
    const rows = db.prepare('SELECT url, title, last_visit_time / 1000 AS t FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?').all(limit)
    return rows.filter(r => /^https?:/i.test(r.url)).map(r => ({ url: r.url, title: r.title || r.url, time: Number(r.t) - 11644473600000 }))
  } finally {
    // erst schließen, sonst bleibt die Kopie (mit dem Verlauf) gesperrt im Temp-Ordner liegen
    try { db?.close() } catch {}
    for (const f of [tmp, tmp + '-journal', tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f) } catch {} }
  }
}

module.exports = { sources, bookmarks, history }
