'use strict'
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
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
  return list[Math.floor(Math.random() * list.length)].replaceAll('{ai}', ai || '')
}

let template = ''

function tick () {
  const now = new Date()
  $('#clock').textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  $('#date').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
}

function greeting (name) {
  const h = new Date().getHours()
  const g = h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 17 ? 'Guten Tag' : h < 22 ? 'Guten Abend' : 'Gute Nacht'
  return name ? `${g}, ${name}` : g
}

function hue (s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h }

function tile (url, title) {
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return null }
  const a = document.createElement('a')
  a.className = 'tile'
  a.href = url
  a.innerHTML = `<span class="ico"></span><span class="name">${esc(title || host)}</span>`
  const ico = a.querySelector('.ico')
  const img = document.createElement('img')
  img.src = new URL(url).origin + '/favicon.ico'
  img.onerror = () => {
    img.remove()
    ico.classList.add('letter')
    ico.style.background = `hsl(${hue(host)} 55% 48%)`
    ico.textContent = host.charAt(0).toUpperCase()
  }
  ico.append(img)
  return a
}

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

  const tiles = $('#tiles')
  const seen = new Set()
  const add = (url, title) => {
    let host
    try { host = new URL(url).hostname } catch { return }
    if (seen.has(host) || seen.size >= 10) return
    seen.add(host)
    const t = tile(url, title)
    if (t) tiles.append(t)
  }
  d.bookmarks.forEach(b => add(b.url, b.title))
  d.topSites.forEach(s => add(s.url, s.title))

  const icons = {
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    focus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/></svg>'
  }
  const blocked = (d.stats?.blocked || 0).toLocaleString('de-DE')
  const fs = d.focusStats || { sessions: 0, minutes: 0 }
  $('#stats').innerHTML =
    `<span class="chip">${icons.shield}<b>${blocked}</b> Werbung & Tracker blockiert</span>` +
    (d.vpn ? `<span class="chip">${icons.shield}VPN aktiv · <b>${esc(d.vpn)}</b></span>` : '') +
    `<span class="chip">${icons.focus}<b>${fs.sessions}</b> Fokus-Sessions · <b>${fs.minutes}</b> Min.</span>` +
    `<span class="chip tip">${icons.spark}${esc(tip(d.assistant))}</span>`
}

$('#search').addEventListener('submit', e => {
  e.preventDefault()
  const q = $('#q').value
  if (q.trim()) location.href = toUrl(q)
})

init()
