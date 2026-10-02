'use strict'
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// Übersetzungen (shared/i18n.js); die Sprache liefert der Preload
const I18N = window.CaravelI18n
I18N.setLang(window.caravelNTP?.lang)
const T = I18N.t
I18N.translateDom(document.body)
const ENGINES = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', ecosia: 'Ecosia', startpage: 'Startpage', brave: 'Brave Search' }
const TIPS = [
  'Umschalt + Klick auf einen Link öffnet eine schwebende Peek-Vorschau.',
  'Strg + K öffnet die Befehlspalette – dort findest du wirklich alles.',
  'Strg + Umschalt + S zeigt zwei Tabs nebeneinander (Split View).',
  'F9 verwandelt Artikel in eine ruhige Leseansicht – mit Vorlesefunktion.',
  'Tabs per Drag & Drop auf ein Space-Symbol ziehen, um sie zu verschieben.',
  'Zeitkapseln sichern einen ganzen Space – perfekt für Projekte.',
  'Rechtsklick auf markierten Text → „Als Notiz speichern“.',
  'Fokus-Modus sperrt Ablenkungen, bis dein Timer abgelaufen ist.',
  'Strg + E öffnet {ai} neben jeder Seite.',
  'Strg + Umschalt + L übergibt die aktuelle Seite an {ai}.',
  'Rechtsklick auf markierten Text → „Mit {ai} erklären“.',
  'Das VPN-Symbol oben rechts verbirgt deine IP – kostenlos über Tor.'
]

// Tipps zum KI-Assistenten nur zeigen, wenn einer aktiv ist
function tip (ai) {
  const list = TIPS.filter(t => ai || !t.includes('{ai}'))
  return T(list[Math.floor(Math.random() * list.length)], { ai: ai || '' })
}

let template = ''

function tick () {
  const now = new Date()
  $('#clock').textContent = now.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' })
  $('#date').textContent = now.toLocaleDateString(I18N.locale, { weekday: 'long', day: 'numeric', month: 'long' })
}

function greeting (name) {
  const h = new Date().getHours()
  const g = T(h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 17 ? 'Guten Tag' : h < 22 ? 'Guten Abend' : 'Gute Nacht')
  return name ? `${g}, ${name}` : g
}

function hue (s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h }

const SVG = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>'
}

function tile (url, title, favicon) {
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return null }
  const a = document.createElement('a')
  a.className = 'tile'
  a.href = url
  a.title = `${title || host}\n${url}`
  a.innerHTML = `<span class="ico"></span><span class="name">${esc(title || host)}</span>`
  const ico = a.querySelector('.ico')
  const letter = () => {
    ico.innerHTML = ''
    ico.classList.add('letter')
    ico.style.background = `hsl(${hue(host)} 55% 48%)`
    ico.textContent = host.charAt(0).toUpperCase()
  }
  const img = document.createElement('img')
  const sources = [favicon, new URL(url).origin + '/favicon.ico'].filter(Boolean)
  img.onerror = () => { sources.shift(); if (sources.length) img.src = sources[0]; else letter() }
  img.src = sources[0]
  ico.append(img)
  return a
}

function tileButton (cls, svg, label, onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 't-btn ' + cls
  b.title = T(label)
  b.innerHTML = svg
  b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick() })
  return b
}

// ---- Favoriten: Kacheln bearbeiten, entfernen, sortieren, hinzufügen ---------------

const api = window.caravelNTP
let dragId = null

function renderFavs (bookmarks) {
  const box = $('#favs')
  box.innerHTML = ''
  for (const b of bookmarks) {
    const t = tile(b.url, b.title, b.favicon)
    if (!t) continue
    t.dataset.id = b.id
    t.draggable = true
    t.append(
      tileButton('edit', SVG.edit, 'Bearbeiten', () => openEditor(b)),
      tileButton('del', SVG.x, 'Entfernen', () => api.bookmark('remove', { id: b.id }))
    )
    t.addEventListener('dragstart', e => { dragId = b.id; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move' })
    t.addEventListener('dragend', () => { dragId = null; t.classList.remove('dragging'); clearDrop() })
    t.addEventListener('dragover', e => {
      if (!dragId || dragId === b.id) return
      e.preventDefault()
      clearDrop()
      const r = t.getBoundingClientRect()
      t.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after')
    })
    t.addEventListener('drop', e => {
      if (!dragId) return
      e.preventDefault()
      const after = t.classList.contains('drop-after')
      clearDrop()
      const idx = bookmarks.findIndex(x => x.id === b.id)
      const beforeId = after ? bookmarks[idx + 1]?.id || null : b.id
      if (beforeId !== dragId) api.bookmark('move', { id: dragId, beforeId })
    })
    box.append(t)
  }
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'tile add'
  add.innerHTML = `<span class="ico">${SVG.plus}</span><span class="name">${T('Hinzufügen')}</span>`
  add.addEventListener('click', () => openEditor(null))
  box.append(add)
}

function clearDrop () {
  document.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'))
}

function renderTop (topSites, bookmarks) {
  const known = new Set(bookmarks.map(b => { try { return new URL(b.url).hostname } catch { return '' } }))
  const box = $('#top')
  box.innerHTML = ''
  for (const s of topSites) {
    let host
    try { host = new URL(s.url).hostname } catch { continue }
    if (known.has(host) || box.children.length >= 8) continue
    const t = tile(s.url, s.title)
    if (!t) continue
    t.append(tileButton('fav', SVG.star, 'Zu Favoriten hinzufügen', () => api.bookmark('add', { url: s.url, title: s.title })))
    box.append(t)
  }
  $('#top-shelf').hidden = !box.children.length
}

// Dialog zum Hinzufügen/Bearbeiten
let editing = null
function openEditor (bm) {
  editing = bm
  $('#edit-title').textContent = T(bm ? 'Favorit bearbeiten' : 'Favorit hinzufügen')
  $('#edit-name').value = bm?.title || ''
  $('#edit-url').value = bm?.url || ''
  $('#edit-err').textContent = ''
  $('#edit-del').hidden = !bm
  $('#edit').showModal()
  ;(bm ? $('#edit-name') : $('#edit-url')).focus()
}

function normalize (s) {
  s = s.trim()
  if (!s) return ''
  if (!/^[a-z][\w+.-]*:/i.test(s)) s = 'https://' + s
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : '' } catch { return '' }
}

$('#edit-form').addEventListener('submit', e => {
  e.preventDefault()
  const url = normalize($('#edit-url').value)
  if (!url) { $('#edit-err').textContent = T('Bitte eine gültige Adresse eingeben, z. B. wikipedia.org'); return }
  const title = $('#edit-name').value.trim()
  api.bookmark(editing ? 'update' : 'add', { id: editing?.id, url, title })
  $('#edit').close()
})
$('#edit-cancel').addEventListener('click', () => $('#edit').close())
$('#edit-del').addEventListener('click', () => { if (editing) api.bookmark('remove', { id: editing.id }); $('#edit').close() })
$('#edit').addEventListener('click', e => { if (e.target === $('#edit')) $('#edit').close() }) // Klick daneben schließt

function toUrl (t) {
  t = t.trim()
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) return t
  if (!/\s/.test(t) && /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t
  return template.replace(/%25QUERY%25|%QUERY%/, encodeURIComponent(t))
}

async function init () {
  tick()
  setInterval(tick, 1000)
  const d = await window.caravelNTP?.getData()
  if (!d) return
  const theme = d.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : d.theme
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.style.setProperty('--accent', d.accent)
  $('#greeting').textContent = greeting(d.userName)
  $('#engine').textContent = ENGINES[d.searchEngine] || 'Google'
  template = d.searchTemplate

  renderFavs(d.bookmarks)
  renderTop(d.topSites, d.bookmarks)

  const icons = {
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    focus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/></svg>'
  }
  const blocked = (d.stats?.blocked || 0).toLocaleString(I18N.locale)
  const fs = d.focusStats || { sessions: 0, minutes: 0 }
  $('#stats').innerHTML =
    `<span class="chip">${icons.shield}${T('<b>{n}</b> Werbung & Tracker blockiert', { n: blocked })}</span>` +
    (d.vpn ? `<span class="chip">${icons.shield}${T('VPN aktiv')} · <b>${esc(d.vpn)}</b></span>` : '') +
    `<span class="chip">${icons.focus}${T('<b>{s}</b> Fokus-Sessions · <b>{m}</b> Min.', { s: fs.sessions, m: fs.minutes })}</span>` +
    `<span class="chip tip">${icons.spark}${esc(tip(d.assistant))}</span>`
}

$('#search').addEventListener('submit', e => {
  e.preventDefault()
  const q = $('#q').value
  if (q.trim()) location.href = toUrl(q)
})

init()

// Favoriten wurden geändert (hier, in der Favoritenleiste oder einem anderen Tab)
api?.onChanged(async () => {
  const d = await api.getData()
  if (!d) return
  renderFavs(d.bookmarks)
  renderTop(d.topSites, d.bookmarks)
})
