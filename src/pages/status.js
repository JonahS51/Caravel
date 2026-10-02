'use strict'
const params = new URLSearchParams(location.search)
const target = params.get('url') || ''
const $ = s => document.getElementById(s)
// Übersetzungen (shared/i18n.js); die Sprache liefert der Preload
const I18N = window.CaravelI18n
I18N.setLang(window.caravelNTP?.lang)
const T = I18N.t
I18N.translateDom(document.body)

const ICONS = {
  offline: '<svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/><path d="M3 3l18 18"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8.5 8.5l5 5M13.5 8.5l-5 5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2"/></svg>',
  crash: '<svg viewBox="0 0 24 24"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
}

function describe (code) {
  return describeDe(code).map((s, i) => (i ? T(s) : s))
}

function describeDe (code) {
  const c = String(code)
  if (c === 'crash') return ['crash', 'Hoppla – diese Seite ist abgestürzt', 'Der Prozess dieser Seite wurde unerwartet beendet. Andere Tabs sind davon nicht betroffen.']
  const n = parseInt(c, 10)
  if (n === -106) return ['offline', 'Keine Internetverbindung', 'Prüfe dein WLAN oder dein Netzwerkkabel. Caravel lädt die Seite erneut, sobald du wieder online bist.']
  if (n === -105 || n === -137) return ['search', 'Adresse nicht gefunden', 'Der Server konnte nicht gefunden werden. Ist die Adresse richtig geschrieben?']
  if (n === -102 || n === -101 || n === -100) return ['offline', 'Verbindung abgelehnt', 'Der Server hat die Verbindung verweigert oder unerwartet getrennt.']
  if (n === -118 || n === -7) return ['clock', 'Zeitüberschreitung', 'Der Server hat zu lange nicht geantwortet. Versuche es gleich noch einmal.']
  if (n <= -200 && n > -300) return ['lock', 'Diese Verbindung ist nicht sicher', 'Das Sicherheitszertifikat der Website ist ungültig. Angreifer könnten versuchen, deine Daten abzufangen. Caravel hat die Seite deshalb nicht geladen.']
  return ['offline', 'Diese Seite ist nicht erreichbar', 'Beim Laden der Seite ist ein Fehler aufgetreten.']
}

if ($('badge')) {
  const [ic, title, text] = describe(params.get('code'))
  $('badge').innerHTML = ICONS[ic]
  $('title').textContent = title
  $('text').textContent = text
  $('url').textContent = target
  $('code').textContent = T('Fehlercode: {code}', { code: params.get('desc') || params.get('code') })
  document.title = title
  $('retry').addEventListener('click', e => { e.preventDefault(); if (target) location.href = target })
  if (params.get('code') === '-106') window.addEventListener('online', () => { if (target) location.href = target })
}

if ($('host')) {
  try { $('host').textContent = new URL(target).hostname.replace(/^www\./, '') } catch {}
  $('back').addEventListener('click', e => { e.preventDefault(); history.length > 1 ? history.back() : (location.href = 'caravel://newtab/') })
}

window.caravelNTP?.getData().then(d => {
  if (!d) return
  const theme = d.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : d.theme
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.style.setProperty('--accent', d.accent)
})
