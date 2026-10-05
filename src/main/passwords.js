// Passwort-Manager: Zugangsdaten werden mit der Windows-Verschlüsselung (DPAPI über safeStorage)
// verschlüsselt in caravel-passwords.json abgelegt. Nur der angemeldete Windows-Benutzer kann sie lesen.
// Webseiten bekommen ein Passwort nur für ihre eigene Herkunft und nur nach einem Klick im Auswahlmenü
// (siehe tab-preload.js).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { safeStorage } = require('electron')
const { t } = require('../shared/i18n')

class PasswordStore {
  constructor (dir) {
    this.file = path.join(dir, 'caravel-passwords.json')
    this.items = []
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || [] } catch {}
  }

  get available () { return safeStorage.isEncryptionAvailable() }

  save () {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }))
    fs.renameSync(tmp, this.file)
  }

  encrypt (text) { return safeStorage.encryptString(String(text)).toString('base64') }
  decrypt (b64) { return safeStorage.decryptString(Buffer.from(b64, 'base64')) }

  static origin (url) {
    try {
      const u = new URL(url)
      return /^https?:$/.test(u.protocol) ? u.origin : null
    } catch { return null }
  }

  // Übersicht ohne Passwörter
  list () {
    return this.items.map(({ id, origin, username, created, updated, used }) => ({ id, origin, username, created, updated, used }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
  }

  forOrigin (origin) {
    return this.items.filter(i => i.origin === origin).sort((a, b) => (b.used || 0) - (a.used || 0)).map(({ id, username }) => ({ id, username }))
  }

  find (origin, username) { return this.items.find(i => i.origin === origin && i.username === username) }

  reveal (id) {
    const item = this.items.find(i => i.id === id)
    return item ? { ...item, password: this.decrypt(item.password) } : null
  }

  // Ergebnis: 'new' | 'update' | 'same'
  compare (origin, username, password) {
    const item = this.find(origin, username)
    if (!item) return 'new'
    return this.decrypt(item.password) === password ? 'same' : 'update'
  }

  upsert (entry) {
    this.upsertNoSave(entry)
    this.save()
  }

  update (id, { username, password }) {
    const item = this.items.find(i => i.id === id)
    if (!item) return false
    if (typeof username === 'string') item.username = username
    if (typeof password === 'string' && password) item.password = this.encrypt(password)
    item.updated = Date.now()
    this.save()
    return true
  }

  touch (id) {
    const item = this.items.find(i => i.id === id)
    if (item) { item.used = Date.now(); this.save() }
  }

  remove (id) {
    this.items = this.items.filter(i => i.id !== id)
    this.save()
  }

  // CSV im Format von Chrome/Edge: name,url,username,password,note
  importCsv (text) {
    const rows = parseCsv(text)
    if (!rows.length) return 0
    const head = rows.shift().map(h => h.trim().toLowerCase())
    const col = name => head.indexOf(name)
    const iu = col('url'); const iuser = col('username'); const ipw = col('password')
    if (iu < 0 || iuser < 0 || ipw < 0) throw new Error(t('Die CSV-Datei braucht die Spalten url, username und password.'))
    let n = 0
    for (const r of rows) {
      const origin = PasswordStore.origin(r[iu] || '')
      if (!origin || !r[ipw]) continue
      this.upsertNoSave({ origin, username: r[iuser] || '', password: r[ipw] })
      n++
    }
    this.save()
    return n
  }

  upsertNoSave ({ origin, username, password }) {
    const now = Date.now()
    const item = this.find(origin, username)
    if (item) Object.assign(item, { password: this.encrypt(password), updated: now })
    else this.items.push({ id: crypto.randomUUID(), origin, username, password: this.encrypt(password), created: now, updated: now, used: 0 })
  }

  exportCsv () {
    const q = s => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    const lines = ['name,url,username,password,note']
    for (const i of this.items) {
      lines.push([new URL(i.origin).hostname, i.origin + '/', i.username, this.decrypt(i.password), ''].map(q).join(','))
    }
    return lines.join('\r\n') + '\r\n'
  }
}

function parseCsv (text) {
  const rows = []
  let row = []; let field = ''; let quoted = false
  text = String(text).replace(/^﻿/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f !== '')) rows.push(row)
  return rows
}

module.exports = { PasswordStore }
