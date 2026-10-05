'use strict'
/* =====================================================================
   Caravel – Browser-Oberfläche
   ===================================================================== */

const A = window.caravel
// Übersetzungen (src/shared/i18n.js): T('deutscher Text', { platzhalter }) – die Sprache wird in boot() gesetzt
const I18N = window.CaravelI18n
const T = I18N.t
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const PARTITION = 'persist:caravel'
const PRIVATE_PARTITION = 'caravel-private' // privater Space: flüchtige Sitzung (siehe main.js)
const NEWTAB = 'caravel://newtab/'

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' }
}
const SPACE_COLORS = ['#f2545b', '#ffb35c', '#3f74e0', '#86a9f2', '#2dd4bf', '#f472b6', '#a3e635', '#facc15', '#c084fc', '#94a3b8']
const SPACE_ICONS = ['✦', '◆', '●', '▲', '★', '☾', '✿', '⚡', '♫', '☕', '🎮', '📚', '💼', '🏠', '🎨', '🧪']

const S = {
  data: null,
  tabs: new Map(),
  spaces: [],
  activeSpace: null,
  closed: [],
  panel: null,
  downloads: new Map(),
  focus: { active: false, endsAt: 0, total: 0, timer: null },
  cast: { devices: [], sessions: [], source: 'tab', request: null, page: null, preset: null, media: null, file: null, mirror: null },
  adblockTotal: 0,
  adblockBase: 0,
  vpn: null,
  vpnCountries: null,
  tabGroups: {},
  agentTabs: new Set(),
  newtabOverride: null,
  peek: null,
  reader: null,
  windowFull: false,
  perms: [],
  popover: null,
  certOverrides: new Set(), // Hosts, deren ungültiges Zertifikat der Nutzer zugelassen hat
  update: null
}
let tabSeq = 0
const settings = () => S.data.settings

/* ---------------------------------------------------------------------
   Hilfsfunktionen
   --------------------------------------------------------------------- */

const saveTimers = {}
function save (key) {
  clearTimeout(saveTimers[key])
  saveTimers[key] = setTimeout(() => A.send('store:set', key, S.data[key]), 400)
}

function hostOf (url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function hashHue (s) {
  let h = 0
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

function letterEl (text, size = 16) {
  const el = document.createElement('span')
  el.className = 'letter'
  const t = (text || '?').replace(/^www\./, '')
  el.textContent = t.charAt(0) || '?'
  el.style.background = `hsl(${hashHue(t)} 55% 48%)`
  el.style.width = el.style.height = size + 'px'
  return el
}

function faviconEl (favicon, url, size = 16) {
  const host = hostOf(url)
  const internal = /^caravel:/.test(url || '')
  if (internal) {
    const s = document.createElement('span')
    s.innerHTML = icon('sparkles')
    s.style.color = 'var(--accent)'
    s.style.display = 'grid'
    s.firstChild.style.width = s.firstChild.style.height = size + 'px'
    return s
  }
  // Nur Web- und Daten-URLs: ein Favicon wie file://server/freigabe/x.ico ließe Windows sonst eine
  // SMB-Verbindung aufbauen (die Oberfläche ist selbst ein file://-Dokument). Gilt auch für alte Einträge.
  let src = safeFavicon(favicon)
  if (!src && /^https?:/.test(url || '')) {
    try { src = new URL(url).origin + '/favicon.ico' } catch {}
  }
  if (!src) return letterEl(host || url, size)
  const img = document.createElement('img')
  img.width = img.height = size
  img.src = src
  img.onerror = () => img.replaceWith(letterEl(host || url, size))
  return img
}

function safeFavicon (src) {
  return typeof src === 'string' && /^(https?:|data:image\/)/i.test(src) ? src : null
}

function faviconHtml (favicon, url) {
  const wrap = document.createElement('span')
  wrap.append(faviconEl(favicon, url))
  return wrap
}

const canvasCtx = document.createElement('canvas').getContext('2d')
function toRgb (color) {
  canvasCtx.fillStyle = '#000'
  canvasCtx.fillStyle = color
  const v = canvasCtx.fillStyle
  if (v.startsWith('#')) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16))
  const m = v.match(/[\d.]+/g)
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0]
}
const toHex = rgb => '#' + rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('')
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

function isDark () {
  const t = settings().theme
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
}

function timeAgo (ts) {
  const d = (Date.now() - ts) / 1000
  if (d < 60) return T('gerade eben')
  if (d < 3600) return T('vor {n} Min.', { n: Math.floor(d / 60) })
  if (d < 86400) return T('vor {n} Std.', { n: Math.floor(d / 3600) })
  return new Date(ts).toLocaleDateString(I18N.locale, { day: '2-digit', month: 'short' })
}

function fmtBytes (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)))
  return (n / 1024 ** i).toLocaleString(I18N.locale, { maximumFractionDigits: i ? 1 : 0, minimumFractionDigits: i ? 1 : 0 }) + ' ' + u[i]
}

function fmtTime (s) {
  s = Math.max(0, Math.round(s || 0))
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0')
}

function toUrl (text) {
  const t = text.trim()
  if (!t) return null
  if (/^javascript:/i.test(t)) return null
  // view-source: funktioniert in Electron-Webviews nicht → eigene Quelltext-Seite
  if (/^view-source:/i.test(t)) return sourceUrl(t.slice(12))
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|data|mailto):/i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return 'http://' + t
  if (!/\s/.test(t) && /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t
  return searchUrl(t)
}

function searchUrl (q) {
  const e = SEARCH_ENGINES[settings().searchEngine] || SEARCH_ENGINES.google
  return e.url.replace('%s', encodeURIComponent(q))
}

function isNewtab (url) {
  return !url || url.startsWith(NEWTAB) || (S.newtabOverride && url.startsWith(S.newtabOverride))
}

const sourceUrl = url => 'caravel://source/?url=' + encodeURIComponent(url)

function displayUrl (url) {
  if (!url || isNewtab(url)) return ''
  if (url.startsWith('caravel://source')) {
    try { return 'view-source:' + new URL(url).searchParams.get('url') } catch { return url }
  }
  if (/^caravel:\/\/(error|blocked)/.test(url)) {
    try { return new URL(url).searchParams.get('url') || url } catch { return url }
  }
  return url
}

function prettyUrl (url) {
  let u = displayUrl(url)
  try { u = decodeURI(u) } catch {}
  return u.replace(/^https:\/\//, '').replace(/^([^/]+)\/$/, '$1')
}

/* ---------------------------------------------------------------------
   Spaces & Tabs – Datenmodell
   --------------------------------------------------------------------- */

const space = id => S.spaces.find(s => s.id === id)
const curSpace = () => space(S.activeSpace)
const getTab = id => S.tabs.get(id)
const activeTab = () => getTab(curSpace()?.activeId)
// t.wcId steht erst nach dom-ready fest – Tabs, die nie eine Seite anzeigen (z. B. nur ein Download),
// werden deshalb auch über ihre Webview gefunden
const tabByWc = wcId => [...S.tabs.values()].find(t => t.wcId === wcId) ||
  [...S.tabs.values()].find(t => { try { return !!t.webview && t.webview.getWebContentsId() === wcId } catch { return false } })
const spaceTabs = sp => sp.tabIds.map(getTab).filter(Boolean)

function createTab ({ url = null, spaceId = S.activeSpace, background = false, pinned = false, sleeping = false, title, favicon, afterId, silent = false, nav = null } = {}) {
  const sp = space(spaceId) || curSpace()
  // view-source: (z. B. aus älteren Sitzungen) lädt in Electron-Webviews nie fertig → eigene Quelltext-Seite
  if (url && /^view-source:/i.test(url)) { url = sourceUrl(url.slice(12)); nav = null }
  const tab = {
    id: 't' + (++tabSeq),
    spaceId: sp.id,
    url: url || NEWTAB,
    title: title || (url ? hostOf(url) || url : T('Neuer Tab')),
    favicon: favicon || null,
    pinned,
    sleeping: true,
    webview: null,
    wcId: null,
    ready: false,
    readyWaiters: [],
    loading: false,
    audible: false,
    muted: false,
    themeColor: null,
    blocked: 0,
    zoom: 0,
    nav, // gespeicherter Vor/Zurück-Verlauf { index, entries } – wird beim Aufwecken wiederhergestellt
    blockedPopups: [],
    lang: '',
    lastActive: Date.now(),
    el: null
  }
  S.tabs.set(tab.id, tab)
  const idx = afterId ? sp.tabIds.indexOf(afterId) : -1
  if (idx >= 0) sp.tabIds.splice(idx + 1, 0, tab.id)
  else sp.tabIds.push(tab.id)
  if (!sleeping) wake(tab)
  if (!silent) {
    if (!background && sp.id === S.activeSpace) activate(tab.id)
    else renderTabs()
    saveSession()
  }
  return tab
}

function whenReady (tab) {
  if (tab.ready) return Promise.resolve(tab)
  return new Promise(resolve => tab.readyWaiters.push(resolve))
}

function resolveLoadUrl (url) {
  if (url.startsWith(NEWTAB) && S.newtabOverride) return S.newtabOverride
  return url
}

const isPrivateTab = tab => !!space(tab.spaceId)?.private
const partitionOf = tab => isPrivateTab(tab) ? PRIVATE_PARTITION : PARTITION

async function wake (tab) {
  if (tab.webview || tab.waking) return
  const nav = tab.nav
  tab.nav = null
  // Verlauf samt Scrollposition wiederherstellen statt die Seite neu zu öffnen: der Hauptprozess
  // hinterlegt ihn und fängt die Startadresse (Marke) beim Anlegen der Webview ab
  let src = resolveLoadUrl(tab.url)
  if (nav?.entries?.length) {
    const urlBefore = tab.url
    tab.waking = true
    try {
      const token = await A.invoke('tab:prepare-restore', nav)
      // inzwischen eine andere Adresse geöffnet (loadInTab)? Dann die laden statt des alten Verlaufs
      if (token && tab.url === urlBefore) src = 'about:blank#caravel-restore=' + token
      else src = resolveLoadUrl(tab.url)
    } catch {}
    tab.waking = false
    if (tab.webview || !S.tabs.has(tab.id)) return
  }
  const wv = document.createElement('webview')
  wv.setAttribute('partition', partitionOf(tab))
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('src', src)
  wv.dataset.tab = tab.id
  tab.webview = wv
  tab.sleeping = false
  tab.ready = false
  bindWebview(tab, wv)
  $('#views').append(wv)
  updateTabEl(tab)
  if (nav && isVisible(tab)) layout() // nach dem asynchronen Aufwecken sichtbar machen
}

async function sleepTab (tab) {
  if (!tab.webview || isVisible(tab)) return
  if (tab.wcId) {
    try { tab.nav = (await A.invoke('tab:history', [tab.wcId]))[tab.wcId] || null } catch {}
    if (!tab.webview || isVisible(tab)) return // inzwischen wieder sichtbar geworden
  }
  tab.webview.remove()
  tab.webview = null
  tab.wcId = null
  tab.ready = false
  tab.sleeping = true
  tab.loading = false
  tab.audible = false
  updateTabEl(tab)
}

function loadInTab (tab, url) {
  if (!url) return
  tab.url = url
  tab.nav = null
  if (!tab.webview) return wake(tab)
  if (!tab.ready) tab.webview.setAttribute('src', resolveLoadUrl(url))
  else tab.webview.loadURL(resolveLoadUrl(url)).catch(() => {})
}

function bindWebview (tab, wv) {
  const isActive = () => curSpace()?.activeId === tab.id
  wv.addEventListener('dom-ready', () => {
    const first = !tab.ready
    tab.ready = true
    tab.wcId = wv.getWebContentsId()
    if (first) {
      applySiteSettings(tab)
      if (tab.muted) wv.setAudioMuted(true)
      tab.readyWaiters.splice(0).forEach(r => r(tab))
      if (isActive()) A.send('tab:activated', tab.wcId)
    }
    if (isActive()) updateNav()
  })
  wv.addEventListener('did-start-loading', () => {
    tab.loading = true
    updateTabEl(tab)
    if (isActive()) { progress('start'); updateNav() }
  })
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false
    updateTabEl(tab)
    if (isActive()) { progress('stop'); updateNav() }
  })
  const onNav = url => {
    tab.url = url
    if (isNewtab(url)) { tab.title = T('Neuer Tab'); tab.favicon = null; tab.themeColor = null }
    recordHistory(tab)
    updateTabEl(tab)
    if (isActive()) { updateNav(); updateOmnibox(); updateAmbient() }
    if (S.panel === 'notes' && isActive()) renderPanel()
    saveSession()
  }
  wv.addEventListener('did-navigate', e => {
    tab.blocked = 0
    tab.themeColor = null
    tab.blockedPopups = []
    tab.lang = ''
    onNav(e.url)
    if (tab.ready) applySiteSettings(tab)
    if (isActive()) { updatePopupButton(); updateTranslateButton() }
  })
  wv.addEventListener('did-navigate-in-page', e => { if (e.isMainFrame) onNav(e.url) })
  wv.addEventListener('page-title-updated', e => {
    tab.title = e.title
    // Titel im Verlauf nachtragen – nicht nur ganz oben suchen, andere Tabs können dazwischen geladen haben
    const h = isPrivateTab(tab) ? null : S.data.history.slice(0, 30).find(x => x.url === tab.url)
    if (h && h.title !== e.title) { h.title = e.title; save('history') }
    updateTabEl(tab)
    if (isActive()) document.title = `${e.title} – Caravel`
    saveSession()
  })
  wv.addEventListener('page-favicon-updated', e => {
    tab.favicon = (e.favicons || []).map(safeFavicon).find(Boolean) || null
    updateTabEl(tab)
    refreshBookmarkFavicon(tab)
    saveSession()
  })
  wv.addEventListener('did-fail-load', e => {
    if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === -20) return
    const target = `caravel://error/?code=${e.errorCode}&desc=${encodeURIComponent(e.errorDescription)}&url=${encodeURIComponent(e.validatedURL)}`
    setTimeout(() => wv.loadURL(target).catch(() => {}), 0)
  })
  wv.addEventListener('render-process-gone', () => {
    tab.loading = false
    const target = `caravel://error/?code=crash&desc=${encodeURIComponent(T('Die Seite ist abgestürzt'))}&url=${encodeURIComponent(tab.url)}`
    setTimeout(() => wv.loadURL(target).catch(() => {}), 50)
  })
  wv.addEventListener('ipc-message', e => {
    if (e.channel === 'peek') openPeek(e.args[0])
    if (e.channel === 'theme-color') {
      tab.themeColor = e.args[0]
      if (isActive()) updateAmbient()
    }
    if (e.channel === 'page-lang') {
      tab.lang = String(e.args[0] || '')
      if (isActive()) updateTranslateButton()
    }
  })
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('html-fullscreen'))
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('html-fullscreen'))
  wv.addEventListener('found-in-page', e => {
    const r = e.result
    if (r.finalUpdate !== false) $('#find-count').textContent = `${r.activeMatchOrdinal || 0}/${r.matches || 0}`
  })
  wv.addEventListener('close', () => closeTab(tab.id))
  wv.addEventListener('focus', () => {
    closeFloating()
    const sp = space(tab.spaceId)
    if (sp?.split && sp.activeId !== tab.id && (sp.split.left === tab.id || sp.split.right === tab.id)) {
      sp.activeId = tab.id
      afterActivate()
    }
  })
}

function isVisible (tab) {
  const sp = space(tab.spaceId)
  if (!sp || sp.id !== S.activeSpace) return false
  if (sp.activeId === tab.id) return true
  return !!sp.split && (sp.split.left === tab.id || sp.split.right === tab.id)
}

function activate (id) {
  const tab = getTab(id)
  if (!tab) return
  if (tab.spaceId !== S.activeSpace) return switchSpace(tab.spaceId, { tabId: id })
  const sp = curSpace()
  if (sp.split && sp.split.left !== id && sp.split.right !== id) sp.split = null
  sp.activeId = id
  tab.lastActive = Date.now()
  if (!tab.webview) wake(tab)
  afterActivate()
  saveSession()
}

function afterActivate () {
  const tab = activeTab()
  if (!tab) return
  tab.lastActive = Date.now()
  layout()
  renderTabs()
  if (isHorizontalTabs()) tab.el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  updateNav()
  updateOmnibox()
  updateAmbient()
  document.title = `${tab.title} – Caravel`
  if (tab.wcId) A.send('tab:activated', tab.wcId)
  if (S.reader && S.reader.tabId !== tab.id) closeReader()
  if (S.panel === 'notes') renderPanel()
  $('#findbar').hidden = true
  progress(tab.loading ? 'start' : 'reset')
  if (DOCK.open || currentPanel()) {
    if (currentPanel() && !DOCK.open) DOCK.open = true
    renderDock()
  }
}

function closeTab (id) {
  const tab = getTab(id)
  if (!tab) return
  const sp = space(tab.spaceId)
  const idx = sp.tabIds.indexOf(id)
  if (!isNewtab(tab.url) && !sp.private) {
    S.closed.push({ url: tab.url, title: tab.title, favicon: tab.favicon, spaceId: sp.id, nav: tab.nav || tab.navCache })
    if (S.closed.length > 25) S.closed.shift()
  }
  sp.tabIds.splice(idx, 1)
  // Letzter privater Tab geschlossen: privaten Space auflösen und seine Daten löschen (wie Chromes Inkognito)
  if (sp.private && !sp.tabIds.length) {
    tab.webview?.remove()
    S.tabs.delete(id)
    return closePrivateSpace()
  }
  if (sp.split && (sp.split.left === id || sp.split.right === id)) {
    const other = sp.split.left === id ? sp.split.right : sp.split.left
    sp.split = null
    if (sp.activeId === id) sp.activeId = other
  }
  tab.webview?.remove()
  S.tabs.delete(id)
  if (S.reader?.tabId === id) closeReader()
  if (sp.activeId === id) {
    const next = [...spaceTabs(sp)].sort((a, b) => b.lastActive - a.lastActive)[0]
    sp.activeId = next ? next.id : null
  }
  if (sp.id === S.activeSpace) {
    if (!sp.activeId) createTab({ spaceId: sp.id })
    else activate(sp.activeId)
  }
  renderTabs()
  saveSession()
}

function reopenClosed () {
  const t = S.closed.pop()
  if (!t) return
  createTab({ url: t.url, title: t.title, favicon: t.favicon, spaceId: space(t.spaceId) ? t.spaceId : S.activeSpace, nav: t.nav })
}

// Duplizieren übernimmt wie in Chrome den Vor/Zurück-Verlauf
async function duplicateTab (tab) {
  let nav = tab.nav
  if (tab.wcId) { try { nav = (await A.invoke('tab:history', [tab.wcId]))[tab.wcId] || nav } catch {} }
  createTab({ url: tab.url, title: tab.title, favicon: tab.favicon, spaceId: tab.spaceId, afterId: tab.id, nav })
}

/* ---------------------------------------------------------------------
   Privater Space (Inkognito): eigene flüchtige Sitzung, kein Verlauf, wird nicht gespeichert
   --------------------------------------------------------------------- */

const privateSpace = () => S.spaces.find(s => s.private)
// Links von außen (andere Programme, Erweiterungen, KI-Agenten) landen wie in Chrome nie im privaten Space
const normalSpaceId = () => {
  const sp = curSpace()
  if (!sp?.private) return S.activeSpace
  return space(sp.returnTo) ? sp.returnTo : S.spaces.find(s => !s.private).id
}

function openPrivate (url = null) {
  let sp = privateSpace()
  if (!sp) {
    sp = { id: 'space-private', name: T('Privat'), color: '#8b5cf6', icon: '◐', private: true, tabIds: [], activeId: null, split: null, returnTo: S.activeSpace }
    S.spaces.push(sp)
    toast('Privater Space', 'Verlauf, Cookies und Website-Daten werden gelöscht, sobald du den letzten privaten Tab schließt.', 'incognito', { duration: 5000 })
  }
  if (url || !sp.tabIds.length) createTab({ url, spaceId: sp.id, background: true })
  switchSpace(sp.id, { tabId: url ? sp.tabIds[sp.tabIds.length - 1] : sp.activeId || sp.tabIds[0] })
  renderSpaces()
}

function closePrivateSpace () {
  const sp = privateSpace()
  if (!sp) return
  for (const t of spaceTabs(sp)) { t.webview?.remove(); S.tabs.delete(t.id) }
  S.spaces = S.spaces.filter(s => s !== sp)
  S.closed = S.closed.filter(c => c.spaceId !== sp.id)
  if (S.activeSpace === sp.id) switchSpace(space(sp.returnTo) ? sp.returnTo : S.spaces[0].id)
  renderSpaces()
  A.invoke('private:clear').catch(() => {})
  toast('Privater Space geschlossen', 'Verlauf und Website-Daten wurden gelöscht.', 'incognito')
}

function togglePin (tab) {
  tab.pinned = !tab.pinned
  const sp = space(tab.spaceId)
  sp.tabIds.splice(sp.tabIds.indexOf(tab.id), 1)
  if (tab.pinned) {
    const lastPinned = sp.tabIds.map(getTab).filter(t => t.pinned).length
    sp.tabIds.splice(lastPinned, 0, tab.id)
  } else {
    sp.tabIds.push(tab.id)
  }
  renderTabs()
  saveSession()
}

function toggleMute (tab) {
  tab.muted = !tab.muted
  if (tab.ready) tab.webview.setAudioMuted(tab.muted)
  updateTabEl(tab)
}

function moveTabToSpace (tab, spaceId) {
  const from = space(tab.spaceId)
  const to = space(spaceId)
  if (!to || from === to) return
  // Unterschiedliche Sitzungen (Cookies, Anmeldungen) – privat und normal lassen sich nicht mischen
  if (!!from.private !== !!to.private) return toast('Nicht möglich', 'Tabs lassen sich nicht zwischen dem privaten Space und anderen Spaces verschieben.', 'incognito')
  from.tabIds.splice(from.tabIds.indexOf(tab.id), 1)
  if (from.split && (from.split.left === tab.id || from.split.right === tab.id)) from.split = null
  if (from.activeId === tab.id) {
    const next = spaceTabs(from).sort((a, b) => b.lastActive - a.lastActive)[0]
    from.activeId = next?.id || null
  }
  to.tabIds.push(tab.id)
  tab.spaceId = to.id
  if (!to.activeId) to.activeId = tab.id
  if (from.id === S.activeSpace) {
    if (!from.activeId) createTab({ spaceId: from.id })
    else activate(from.activeId)
  }
  layout()
  renderTabs()
  saveSession()
  toast(T('In „{name}“ verschoben', { name: to.name }), tab.title, 'layers')
}

function saveSession () {
  clearTimeout(saveSession.t)
  saveSession.t = setTimeout(writeSession, 600)
}

// Speichert sofort mit dem zuletzt bekannten Vor/Zurück-Verlauf und holt ihn danach für wache Tabs
// frisch (asynchron) – beim Beenden (flushPending) zählt der sofort geschriebene Stand.
function writeSession ({ refresh = true } = {}) {
  saveSession.t = null
  const sp0 = curSpace()
  S.data.spaces = S.spaces.filter(sp => !sp.private).map(sp => ({
    id: sp.id,
    name: sp.name,
    color: sp.color,
    icon: sp.icon,
    activeIndex: Math.max(0, sp.tabIds.indexOf(sp.activeId)),
    tabs: spaceTabs(sp).map(t => ({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, nav: t.nav || t.navCache || undefined }))
  }))
  S.data.activeSpace = sp0?.private ? (space(sp0.returnTo) ? sp0.returnTo : S.data.spaces[0]?.id) : S.activeSpace
  A.send('store:set', 'spaces', S.data.spaces)
  A.send('store:set', 'activeSpace', S.data.activeSpace)
  if (!refresh) return
  const awake = [...S.tabs.values()].filter(t => t.wcId && !isPrivateTab(t))
  if (!awake.length) return
  A.invoke('tab:history', awake.map(t => t.wcId)).then(map => {
    let changed = false
    for (const t of awake) {
      const nav = map[t.wcId]
      if (nav && JSON.stringify(nav) !== JSON.stringify(t.navCache)) { t.navCache = nav; changed = true }
    }
    if (changed && !saveSession.t) writeSession({ refresh: false })
  }).catch(() => {})
}

function recordHistory (tab) {
  const url = tab.url
  if (!/^(https?|file):/.test(url) || isPrivateTab(tab)) return
  const h = S.data.history
  if (h[0]?.url === url) {
    h[0].time = Date.now()
  } else {
    h.unshift({ url, title: tab.title || url, time: Date.now() })
    if (h.length > 3000) h.length = 3000
  }
  save('history')
  if (S.panel === 'history') renderPanel()
}

/* ---------------------------------------------------------------------
   Spaces
   --------------------------------------------------------------------- */

function switchSpace (id, { tabId, initial } = {}) {
  const sp = space(id)
  if (!sp) return
  const changed = S.activeSpace !== id
  S.activeSpace = id
  if (tabId) sp.activeId = tabId
  applyAccent()
  if (!sp.activeId || !getTab(sp.activeId)) sp.activeId = sp.tabIds[0] || null
  if (!sp.activeId) {
    createTab({ spaceId: sp.id })
  } else {
    const t = getTab(sp.activeId)
    if (!t.webview) wake(t)
    if (sp.split) [sp.split.left, sp.split.right].map(getTab).forEach(t => t && !t.webview && wake(t))
    afterActivate()
  }
  renderSpaces()
  if (changed && !initial) {
    const list = $('#tab-list')
    list.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
  }
  saveSession()
}

function applyAccent () {
  const sp = curSpace()
  const color = sp?.color || '#f2545b'
  document.documentElement.style.setProperty('--accent', color)
  document.body.classList.toggle('private-space', !!sp?.private)
  $('#space-name').textContent = sp?.name || ''
  A.send('ui:accent', color)
  updateAmbient()
}

function addSpace ({ name, color, icon: ic }) {
  const sp = { id: 'space-' + Date.now().toString(36), name, color, icon: ic, tabIds: [], activeId: null, split: null }
  S.spaces.push(sp)
  switchSpace(sp.id)
  renderSpaces()
  saveSession()
  return sp
}

function deleteSpace (sp) {
  if (sp.private) return closePrivateSpace()
  if (S.spaces.filter(s => !s.private).length <= 1) return toast('Nicht möglich', 'Mindestens ein Space wird benötigt.', 'info')
  for (const t of spaceTabs(sp)) { t.webview?.remove(); S.tabs.delete(t.id) }
  S.spaces = S.spaces.filter(s => s !== sp)
  if (S.activeSpace === sp.id) switchSpace(S.spaces.find(s => !s.private).id)
  renderSpaces()
  saveSession()
}

function editSpaceDialog (sp) {
  const isNew = !sp
  let color = sp?.color || SPACE_COLORS[S.spaces.length % SPACE_COLORS.length]
  let ic = sp?.icon || SPACE_ICONS[S.spaces.length % SPACE_ICONS.length]
  showModal(`
    <div class="modal-head"><h2>${isNew ? T('Neuer Space') : T('Space bearbeiten')}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">${T('Spaces sind getrennte Arbeitsbereiche mit eigenen Tabs, eigener Farbe und eigener Zeitkapsel.')}</p>
      <div class="field"><label>${T('Name')}</label><input class="input" id="sp-name" value="${esc(sp?.name || '')}" placeholder="${T('z. B. Uni, Projekt, Freizeit')}"></div>
      <div class="field"><label>${T('Symbol')}</label><div class="swatches" id="sp-icons">${SPACE_ICONS.map(i => `<button class="space-btn ${i === ic ? 'active' : ''}" style="--sc:${color}" data-i="${i}">${i}</button>`).join('')}</div></div>
      <div class="field"><label>${T('Farbe')}</label><div class="swatches" id="sp-colors">${SPACE_COLORS.map(c => `<button class="swatch ${c === color ? 'on' : ''}" style="--c:${c}" data-c="${c}"></button>`).join('')}</div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>${T('Abbrechen')}</button><button class="btn" id="sp-save">${isNew ? T('Space erstellen') : T('Speichern')}</button></div>`)
  const card = $('#modal-card')
  $('#sp-name').focus()
  $('#sp-icons').addEventListener('click', e => {
    const b = e.target.closest('[data-i]'); if (!b) return
    ic = b.dataset.i
    $$('#sp-icons .space-btn').forEach(x => x.classList.toggle('active', x === b))
  })
  $('#sp-colors').addEventListener('click', e => {
    const b = e.target.closest('[data-c]'); if (!b) return
    color = b.dataset.c
    $$('#sp-colors .swatch').forEach(x => x.classList.toggle('on', x === b))
    $$('#sp-icons .space-btn').forEach(x => x.style.setProperty('--sc', color))
  })
  let done = false
  const submit = () => {
    if (done) return
    done = true
    const name = $('#sp-name').value.trim() || 'Space'
    closeModal()
    if (isNew) addSpace({ name, color, icon: ic })
    else { Object.assign(sp, { name, color, icon: ic }); applyAccent(); renderSpaces(); saveSession() }
  }
  $('#sp-save').onclick = submit
  card.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } })
}

/* ---------------------------------------------------------------------
   Layout, Split View
   --------------------------------------------------------------------- */

function layout () {
  const sp = curSpace()
  const divider = $('#split-divider')
  const pane = $('#pane-focus')
  for (const t of S.tabs.values()) {
    const wv = t.webview
    if (!wv) continue
    wv.classList.remove('visible', 'split-left', 'split-right')
    wv.style.width = ''
  }
  divider.hidden = true
  pane.hidden = true
  if (!sp) return
  if (sp.split) {
    const L = getTab(sp.split.left); const R = getTab(sp.split.right)
    if (!L || !R) { sp.split = null; return layout() }
    if (!L.webview) wake(L)
    if (!R.webview) wake(R)
    const r = sp.split.ratio
    L.webview?.classList.add('visible', 'split-left')
    if (L.webview) L.webview.style.width = `calc(${r * 100}% - 4px)`
    R.webview?.classList.add('visible', 'split-right')
    if (R.webview) R.webview.style.width = `calc(${(1 - r) * 100}% - 4px)`
    divider.hidden = false
    divider.style.left = `${r * 100}%`
    pane.hidden = false
    const leftActive = sp.activeId === L.id
    pane.style.left = leftActive ? '0' : `calc(${r * 100}% + 4px)`
    pane.style.width = leftActive ? `calc(${r * 100}% - 4px)` : `calc(${(1 - r) * 100}% - 4px)`
  } else {
    const t = activeTab()
    if (t?.webview) t.webview.classList.add('visible')
  }
  $('#btn-split').classList.toggle('on', !!sp.split)
}

function toggleSplit () {
  const sp = curSpace()
  if (sp.split) { sp.split = null; layout(); renderTabs(); return }
  const cur = activeTab()
  let other = spaceTabs(sp).filter(t => t !== cur).sort((a, b) => b.lastActive - a.lastActive)[0]
  if (!other) other = createTab({ background: true, afterId: cur.id })
  sp.split = { left: cur.id, right: other.id, ratio: 0.5 }
  layout(); renderTabs()
  toast('Split View', 'Zwei Tabs nebeneinander – ziehe die Trennlinie, um die Breite anzupassen.', 'split')
}

function splitWith (tabId) {
  const sp = curSpace()
  const cur = activeTab()
  if (!cur || cur.id === tabId) return
  sp.split = { left: cur.id, right: tabId, ratio: 0.5 }
  layout(); renderTabs()
}

function openInSplit (url) {
  const cur = activeTab()
  const t = createTab({ url, background: true, afterId: cur.id })
  splitWith(t.id)
}

function initDivider () {
  const divider = $('#split-divider')
  const shield = $('#drag-shield')
  divider.addEventListener('mousedown', e => {
    e.preventDefault()
    const sp = curSpace()
    const rect = $('#stage').getBoundingClientRect()
    shield.hidden = false
    const move = ev => {
      sp.split.ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width))
      layout()
    }
    const up = () => {
      shield.hidden = true
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  divider.addEventListener('dblclick', () => { const sp = curSpace(); if (sp.split) { sp.split.ratio = 0.5; layout() } })
}

/* ---------------------------------------------------------------------
   Seitenleiste rendern
   --------------------------------------------------------------------- */

// Favoriten: in der Seitenleiste als Symbolraster, bei Chrome/Safari als Favoritenleiste wie in Chrome –
// mit Ordnern, Überlauf-Menü (»), Drag & Drop und Bearbeiten per Rechtsklick.
function renderFavorites () {
  const box = $('#favorites')
  box.innerHTML = ''
  const cur = activeTab()
  for (const bm of S.data.bookmarks) box.append(favItem(bm, cur))
  box.hidden = !S.data.bookmarks.length && !isHorizontalTabs()
  $('#fav-empty').hidden = S.data.bookmarks.length > 0
  layoutFavbar()
}

function favItem (bm, cur) {
  const folder = isFolder(bm)
  const el = document.createElement('div')
  el.className = 'fav' + (folder ? ' folder' : '')
  el.dataset.id = bm.id
  el.title = folder ? `${bm.title} (${bm.children.length})` : `${bm.title}\n${bm.url}`
  el.draggable = true
  if (folder) {
    const ic = document.createElement('span')
    ic.className = 'fav-folder'
    ic.innerHTML = icon('folder')
    el.append(ic)
  } else {
    if (cur && hostOf(cur.url) === hostOf(bm.url)) el.classList.add('active')
    el.append(faviconEl(bm.favicon, bm.url, 20))
  }
  const label = document.createElement('span')
  label.className = 'fav-label' // nur in der Favoritenleiste (Chrome/Safari) sichtbar
  label.textContent = bm.title || hostOf(bm.url)
  el.append(label)
  el.onclick = e => {
    if (folder) return openFolderMenu(bm, el)
    if (e.ctrlKey || e.metaKey) return createTab({ url: bm.url, background: true })
    if (e.shiftKey) return createTab({ url: bm.url })
    openBookmark(bm)
  }
  el.onauxclick = e => {
    if (e.button !== 1 || folder) return
    e.preventDefault()
    createTab({ url: bm.url, background: true })
  }
  el.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); favContextMenu(bm, e) }
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/caravel-bm', bm.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragover', e => {
    const types = e.dataTransfer.types
    if (!types.includes('text/caravel-bm') && !types.includes('text/caravel-tab')) return
    e.preventDefault()
    e.stopPropagation()
    clearFavDrop()
    el.classList.add('drop-' + favDropWhere(el, e))
  })
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'))
  el.addEventListener('drop', e => {
    e.preventDefault()
    e.stopPropagation()
    const where = favDropWhere(el, e)
    clearFavDrop()
    favDrop(e, bm.id, where)
  })
  return el
}

// Vor/hinter ein Element oder (bei Ordnern, mittlere Hälfte) hinein
function favDropWhere (el, e) {
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  if (el.classList.contains('folder') && x > 0.25 && x < 0.75) return 'into'
  return x < 0.5 ? 'before' : 'after'
}

function clearFavDrop () {
  for (const x of $$('.fav.drop-before, .fav.drop-after, .fav.drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into')
}

function favDrop (e, targetId, where) {
  const bmId = e.dataTransfer.getData('text/caravel-bm')
  const tab = getTab(e.dataTransfer.getData('text/caravel-tab'))
  if (bmId) return moveBookmark(bmId, targetId, where)
  if (tab && !isNewtab(tab.url)) {
    const bm = bmByUrl(tab.url) || addBookmark({ url: tab.url, title: tab.title, favicon: tab.favicon })
    moveBookmark(bm.id, targetId, where)
    toast('Zu Favoriten hinzugefügt', tab.title, 'star')
  }
}

function initFavorites () {
  // Freie Fläche: ans Ende verschieben bzw. Tab ans Ende anheften; Rechtsklick: Hinzufügen-Menü
  for (const zone of [$('#favorites'), $('#favbar')]) {
    zone.addEventListener('dragover', e => {
      const types = e.dataTransfer.types
      if (types.includes('text/caravel-bm') || types.includes('text/caravel-tab')) e.preventDefault()
    })
    zone.addEventListener('drop', e => {
      if (e.target.closest('.fav')) return
      e.preventDefault()
      e.stopPropagation()
      favDrop(e, null, 'after')
    })
    zone.addEventListener('contextmenu', e => {
      if (e.target.closest('.fav')) return
      e.preventDefault()
      showMenu(e.clientX, e.clientY, favBarMenuItems())
    })
  }
  new ResizeObserver(() => layoutFavbar()).observe($('#favbar'))
}

function favBarMenuItems () {
  const t = activeTab()
  return [
    { label: 'Aktuelle Seite hinzufügen', icon: 'star', hidden: !t || isNewtab(t.url) || !!bmByUrl(t.url), run: () => { addBookmark({ url: t.url, title: t.title, favicon: t.favicon }); toast('Zu Favoriten hinzugefügt', t.title, 'star') } },
    { label: 'Favorit hinzufügen …', icon: 'plus', run: () => editBookmarkDialog(null, { kind: 'link' }) },
    { label: 'Ordner hinzufügen …', icon: 'folder', run: () => editBookmarkDialog(null, { kind: 'folder' }) },
    '-',
    isHorizontalTabs()
      ? { label: 'Favoritenleiste ausblenden', icon: 'eye', hint: 'Strg+B', run: toggleSidebar }
      : { label: 'Favoriten-Ansicht: Tab-Leiste ändern …', icon: 'layers', run: () => openSettings('appearance') }
  ]
}

function favContextMenu (bm, e) {
  if (isFolder(bm)) {
    return showMenu(e.clientX, e.clientY, [
      { label: 'Alle in neuen Tabs öffnen', icon: 'plus', hidden: !bm.children.length, run: () => bm.children.forEach(c => createTab({ url: c.url, background: true })) },
      { label: 'Umbenennen …', icon: 'type', run: () => editBookmarkDialog(bm) },
      '-',
      ...favBarMenuItems(),
      '-',
      { label: 'Ordner löschen', icon: 'trash', danger: true, run: () => removeBookmarkId(bm.id) }
    ])
  }
  showMenu(e.clientX, e.clientY, [
    { label: 'In neuem Tab öffnen', icon: 'plus', run: () => createTab({ url: bm.url }) },
    { label: 'Peek-Vorschau', icon: 'eye', run: () => openPeek(bm.url) },
    { label: 'In Split View öffnen', icon: 'split', run: () => openInSplit(bm.url) },
    '-',
    { label: 'Bearbeiten …', icon: 'type', run: () => editBookmarkDialog(bm) },
    { label: 'Adresse kopieren', icon: 'copy', run: () => A.send('clipboard:write', bm.url) },
    { label: 'Entfernen', icon: 'trash', danger: true, run: () => removeBookmarkId(bm.id) },
    '-',
    ...favBarMenuItems()
  ])
}

function openFolderMenu (folder, anchor) {
  const r = anchor.getBoundingClientRect()
  const items = folder.children.map(c => ({ label: c.title || hostOf(c.url), fav: c, run: () => openBookmark(c) }))
  if (!items.length) items.push({ label: 'Leer – Favoriten hierher ziehen', icon: 'info', run: () => {} })
  else items.push('-', { label: 'Alle in neuen Tabs öffnen', icon: 'plus', run: () => folder.children.forEach(c => createTab({ url: c.url, background: true })) })
  showMenu(r.left, r.bottom + 4, items)
}

// Favoritenleiste: was nicht mehr passt, wandert ins »-Menü (wie in Chrome)
function layoutFavbar () {
  const bar = $('#favbar')
  const more = $('#fav-more')
  const items = [...$('#favorites').children]
  for (const el of items) el.classList.remove('overflow')
  if (!isHorizontalTabs() || bar.hidden) { more.hidden = true; return }
  const limit = bar.getBoundingClientRect().right - 44
  const hidden = items.filter(el => el.getBoundingClientRect().right > limit)
  for (const el of hidden) el.classList.add('overflow')
  more.hidden = !hidden.length
  more.innerHTML = icon('chevronDown')
  more.onclick = () => {
    const r = more.getBoundingClientRect()
    showMenu(r.right - 240, r.bottom + 4, hidden.map(el => {
      const bm = bmLocate(el.dataset.id)?.item
      if (!bm) return null
      return isFolder(bm)
        ? { label: bm.title, icon: 'folder', run: () => openFolderMenu(bm, more) }
        : { label: bm.title || hostOf(bm.url), fav: bm, run: () => openBookmark(bm) }
    }))
  }
}

const sameUrl = (a, b) => String(a || '').replace(/[#/]+$/, '') === String(b || '').replace(/[#/]+$/, '')

function openBookmark (bm) {
  const sp = curSpace()
  const existing = spaceTabs(sp).find(t => sameUrl(t.url, bm.url))
  if (existing) return activate(existing.id)
  const cur = activeTab()
  if (cur && isNewtab(cur.url)) loadInTab(cur, bm.url)
  else createTab({ url: bm.url, favicon: bm.favicon, title: bm.title })
}

function renderTabs () {
  const sp = curSpace()
  const list = $('#tab-list')
  list.innerHTML = ''
  if (!sp) return
  const tabs = spaceTabs(sp)
  const pinned = tabs.filter(t => t.pinned)
  const normal = tabs.filter(t => !t.pinned)
  if (pinned.length) {
    list.insertAdjacentHTML('beforeend', `<div class="tab-section">${T('Angeheftet')}</div>`)
    pinned.forEach(t => list.append(tabEl(t)))
    list.insertAdjacentHTML('beforeend', `<div class="tab-section">${T('Tabs')}</div>`)
  }
  normal.forEach(t => list.append(tabEl(t)))
  renderFavorites()
}

function tabEl (tab) {
  const el = document.createElement('div')
  el.className = 'tab'
  el.draggable = true
  el.dataset.id = tab.id
  el.innerHTML = `<span class="fav-ico"></span><span class="title"></span><span class="badge audio"></span><span class="badge state"></span><button class="close" title="${T('Tab schließen (Strg+W)')}">${icon('x')}</button>`
  el.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id) } })
  el.addEventListener('click', e => {
    if (e.target.closest('.close')) return closeTab(tab.id)
    if (e.target.closest('.audio') && tab.audible) return toggleMute(tab)
    if (e.shiftKey && tab.id !== curSpace().activeId) return splitWith(tab.id)
    activate(tab.id)
  })
  el.addEventListener('contextmenu', e => { e.preventDefault(); tabMenu(e, tab) })
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/caravel-tab', tab.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/caravel-tab')) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const before = isHorizontalTabs() ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2
    el.classList.toggle('drop-before', before)
    el.classList.toggle('drop-after', !before)
  })
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'))
  el.addEventListener('drop', e => {
    e.preventDefault()
    const before = el.classList.contains('drop-before')
    el.classList.remove('drop-before', 'drop-after')
    const id = e.dataTransfer.getData('text/caravel-tab')
    const moved = getTab(id)
    if (!moved || id === tab.id || moved.spaceId !== tab.spaceId) return
    const sp = space(tab.spaceId)
    sp.tabIds.splice(sp.tabIds.indexOf(id), 1)
    sp.tabIds.splice(sp.tabIds.indexOf(tab.id) + (before ? 0 : 1), 0, id)
    moved.pinned = tab.pinned
    renderTabs()
    saveSession()
  })
  tab.el = el
  updateTabEl(tab)
  return el
}

function updateTabEl (tab) {
  const el = tab.el
  const sp = space(tab.spaceId)
  if (!el || !sp) return
  el.classList.toggle('active', sp.activeId === tab.id)
  el.classList.toggle('sleeping', tab.sleeping)
  el.classList.toggle('pinned', tab.pinned)
  el.classList.toggle('in-split', !!sp.split && (sp.split.left === tab.id || sp.split.right === tab.id) && sp.activeId !== tab.id)
  const fav = $('.fav-ico', el)
  fav.innerHTML = ''
  if (tab.loading) fav.innerHTML = '<span class="spinner"></span>'
  // privater Space: keine Favicons über die (dauerhaft cachende) Sitzung der Oberfläche laden
  else if (isPrivateTab(tab) && !/^data:/.test(tab.favicon || '') && !/^caravel:/.test(tab.url)) fav.append(letterEl(hostOf(tab.url) || tab.url))
  else fav.append(faviconEl(tab.favicon, tab.url))
  $('.title', el).textContent = tab.title || prettyUrl(tab.url) || T('Neuer Tab')
  el.title = `${tab.title}\n${displayUrl(tab.url) || T('Neuer Tab')}${tab.sleeping ? '\n💤 ' + T('Schläft – spart Arbeitsspeicher') : ''}`
  $('.audio', el).innerHTML = tab.audible || tab.muted ? icon(tab.muted ? 'mute' : 'volume') : ''
  $('.audio', el).title = tab.muted ? T('Ton an') : T('Stummschalten')
  const agent = tab.wcId && S.agentTabs.has(tab.wcId)
  const state = $('.state', el)
  state.classList.toggle('agent', !!agent)
  state.title = agent ? T('Ein KI-Agent steuert diesen Tab') : ''
  state.innerHTML = agent ? icon('agent') : tab.sleeping ? icon('zzz') : tab.pinned ? `<span class="pin-dot">${icon('pin')}</span>` : ''
  const group = tab.wcId && S.tabGroups[tab.wcId]
  let bar = $('.group-bar', el)
  if (group) {
    if (!bar) { bar = document.createElement('span'); el.prepend(bar) }
    bar.className = `group-bar tg-${group.color}`
    bar.title = group.title ? T('Gruppe „{name}“', { name: group.title }) : T('Tab-Gruppe')
  } else if (bar) bar.remove()
}

function tabMenu (e, tab) {
  const sp = space(tab.spaceId)
  const others = S.spaces.filter(s => s !== sp && !!s.private === !!sp.private)
  const right = sp.tabIds.slice(sp.tabIds.indexOf(tab.id) + 1).map(getTab).filter(t => t && !t.pinned)
  const items = [
    { label: 'Neuer Tab rechts', icon: 'plus', run: () => createTab({ spaceId: sp.id, afterId: tab.id }) },
    '-',
    { label: 'Neu laden', icon: 'reload', run: () => { if (tab.ready) tab.webview.reload(); else activate(tab.id) } },
    { label: 'Duplizieren', icon: 'copy', run: () => duplicateTab(tab) },
    { label: tab.pinned ? 'Loslösen' : 'Anheften', icon: 'pin', run: () => togglePin(tab) },
    { label: tab.muted ? 'Ton einschalten' : 'Stummschalten', icon: tab.muted ? 'volume' : 'mute', run: () => toggleMute(tab) },
    { label: 'Neben aktivem Tab (Split View)', icon: 'split', hint: 'Umschalt+Klick', run: () => splitWith(tab.id), hidden: tab.id === sp.activeId },
    { label: 'Schlafen legen', icon: 'zzz', run: () => sleepTab(tab), hidden: tab.sleeping || isVisible(tab) },
    ...(others.length ? ['-', ...others.map(o => ({ label: T('Nach „{name}“ verschieben', { name: o.name }), icon: 'layers', run: () => moveTabToSpace(tab, o.id) }))] : []),
    { label: 'Alle Tabs als Favoriten speichern …', icon: 'star', run: () => bookmarkAllTabs(sp) },
    '-',
    { label: 'Tabs rechts schließen', icon: 'x', hidden: !right.length, run: () => right.forEach(t => closeTab(t.id)) },
    { label: 'Andere Tabs schließen', icon: 'x', run: () => spaceTabs(sp).filter(t => t !== tab && !t.pinned).forEach(t => closeTab(t.id)) },
    { label: 'Tab schließen', icon: 'x', hint: 'Strg+W', danger: true, run: () => closeTab(tab.id) }
  ]
  showMenu(e.clientX, e.clientY, items)
}

function renderSpaces () {
  const box = $('#spaces')
  box.innerHTML = ''
  S.spaces.forEach((sp, i) => {
    const b = document.createElement('button')
    b.className = 'space-btn' + (sp.id === S.activeSpace ? ' active' : '') + (sp.private ? ' private' : '')
    b.style.setProperty('--sc', sp.color)
    if (sp.private) b.innerHTML = icon('incognito')
    else b.textContent = sp.icon
    b.title = sp.private ? `${T('Privater Space')} (${T('Strg+Umschalt+N')})` : `${sp.name} (Alt+${i + 1})`
    b.onclick = () => switchSpace(sp.id)
    b.oncontextmenu = e => sp.private ? showMenu(e.clientX, e.clientY, [
      { label: 'Neuer privater Tab', icon: 'plus', run: () => createTab({ spaceId: sp.id }) },
      { label: 'Privaten Space schließen', icon: 'x', danger: true, run: closePrivateSpace }
    ]) : showMenu(e.clientX, e.clientY, [
      { label: 'Bearbeiten …', icon: 'settings', run: () => editSpaceDialog(sp) },
      { label: 'Zeitkapsel speichern', icon: 'archive', run: () => saveSnapshot(sp) },
      { label: 'Alle Tabs schlafen legen', icon: 'zzz', run: () => spaceTabs(sp).forEach(sleepTab) },
      '-',
      { label: 'Space löschen', icon: 'trash', danger: true, run: () => confirmDialog(T('„{name}“ löschen?', { name: sp.name }), 'Alle Tabs dieses Spaces werden geschlossen. Tipp: Speichere vorher eine Zeitkapsel.', 'Löschen', () => deleteSpace(sp)) }
    ])
    b.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/caravel-tab')) { e.preventDefault(); b.classList.add('drop') } })
    b.addEventListener('dragleave', () => b.classList.remove('drop'))
    b.addEventListener('drop', e => {
      b.classList.remove('drop')
      const t = getTab(e.dataTransfer.getData('text/caravel-tab'))
      if (t) moveTabToSpace(t, sp.id)
    })
    box.append(b)
  })
  const add = document.createElement('button')
  add.className = 'space-btn add'
  add.innerHTML = icon('plus')
  add.title = T('Neuer Space')
  add.onclick = () => editSpaceDialog(null)
  box.append(add)
}

function renderSbTools () {
  const tools = [
    ['history', 'history', 'Verlauf (Strg+H)'],
    ['downloads', 'download', 'Downloads (Strg+J)'],
    ['notes', 'note', 'Seiten-Notizen (Strg+Umschalt+U)'],
    ['snapshots', 'archive', 'Zeitkapseln'],
    ['extensions', 'puzzle', 'Erweiterungen (Strg+Umschalt+E)']
  ]
  const box = $('#sb-tools')
  box.innerHTML = ''
  for (const [panel, ic, title] of tools) {
    const b = document.createElement('button')
    b.className = 'icon-btn' + (S.panel === panel ? ' on' : '')
    b.dataset.panel = panel
    b.title = T(title)
    b.innerHTML = icon(ic)
    b.onclick = () => togglePanel(panel)
    box.append(b)
  }
  const s = document.createElement('button')
  s.className = 'icon-btn'
  s.title = T('Einstellungen (Strg+,)')
  s.innerHTML = icon('settings')
  s.onclick = () => openSettings()
  box.append(s)
  updateDownloadDot()
}

function toggleSidebar () {
  // Bei waagrechten Tabs gibt es keine Seitenleiste – Strg+B schaltet dann die Favoritenleiste
  if (isHorizontalTabs()) settings().showFavbar = settings().showFavbar === false
  else settings().sidebarCollapsed = !settings().sidebarCollapsed
  save('settings')
  applyTabLayout()
}

/* ---------------------------------------------------------------------
   Tab-Leiste: Caravel (Seitenleiste), Chrome (oben), Safari (unter der Adressleiste)
   --------------------------------------------------------------------- */

const TAB_LAYOUTS = ['sidebar', 'chrome', 'safari']
const tabLayout = () => TAB_LAYOUTS.includes(settings().tabLayout) ? settings().tabLayout : 'sidebar'
const isHorizontalTabs = () => tabLayout() !== 'sidebar'

function applyTabLayout () {
  const mode = tabLayout()
  const horiz = mode !== 'sidebar'
  const body = document.body
  const changed = !body.classList.contains('layout-' + mode)
  // Beim Wechsel keine Spalten-Animation – sonst übernehmen eingebettete Seiten die neue Größe nicht
  if (changed) $('#app').style.transition = 'none'
  const main = $('#main')
  const strip = $('#tabstrip')
  const favbar = $('#favbar')
  for (const m of TAB_LAYOUTS) body.classList.toggle('layout-' + m, m === mode)
  body.classList.toggle('sidebar-collapsed', !horiz && !!settings().sidebarCollapsed)
  body.classList.toggle('density-compact', !!settings().compactUi)

  const list = $('#tab-list')
  const newtab = $('#btn-newtab')
  const favs = $('#favorites')
  const spaces = $('#spaces')
  if (horiz) {
    $('#ts-tabs').append(list, newtab)
    $('#ts-spaces').append(spaces)
    favbar.prepend(favs)
    // Chrome: Tabs ganz oben, Safari: Tabs unter Adress- und Favoritenleiste
    if (mode === 'chrome') main.prepend(strip)
    else main.insertBefore(strip, $('.content-row'))
    main.insertBefore(favbar, mode === 'chrome' ? $('.content-row') : strip)
  } else {
    const foot = $('.sb-foot')
    const sidebar = $('#sidebar')
    sidebar.insertBefore(favs, foot)
    sidebar.insertBefore(newtab, foot)
    sidebar.insertBefore(list, foot)
    foot.prepend(spaces)
  }
  strip.hidden = !horiz
  favbar.hidden = !horiz || settings().showFavbar === false
  updateAmbient() // Höhe der Fensterknöpfe an die Leistenhöhe anpassen
  renderFavorites()
  if (changed) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $('#app').style.transition = ''
      // Webviews kurz anstoßen, damit ihr Inhalt die neue Fläche übernimmt
      for (const wv of $$('#views webview.visible')) {
        const w = wv.style.width
        wv.style.width = 'calc(100% - 1px)'
        requestAnimationFrame(() => { wv.style.width = w })
      }
    }))
  }
}

function initTabStrip () {
  // Mausrad scrollt die waagrechte Tab-Leiste
  $('#tab-list').addEventListener('wheel', e => {
    if (!isHorizontalTabs() || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
    e.preventDefault()
    $('#tab-list').scrollLeft += e.deltaY
  }, { passive: false })
  // Doppelklick auf freie Fläche der Leiste öffnet einen neuen Tab (wie in Chrome)
  $('#tab-list').addEventListener('dblclick', e => { if (e.target.id === 'tab-list') createTab() })
}

/* ---------------------------------------------------------------------
   Werkzeugleiste & Omnibox
   --------------------------------------------------------------------- */

function updateNav () {
  const t = activeTab()
  const ready = t?.ready
  $('#btn-back').disabled = !(ready && t.webview.canGoBack())
  $('#btn-forward').disabled = !(ready && t.webview.canGoForward())
  $('#btn-reload').innerHTML = icon(t?.loading ? 'x' : 'reload')
  $('#btn-reload').title = t?.loading ? T('Laden abbrechen') : T('Neu laden (F5)')
  updateAdblockChip()
  const bm = t && !!bmByUrl(t.url)
  $('#btn-star').classList.toggle('on', !!bm)
  $('#btn-star').innerHTML = icon('star')
  $('#btn-reader').classList.toggle('on', !!S.reader)
  $('#btn-reader').hidden = !t || isNewtab(t.url) || !/^https?:/.test(t.url)
  $('#btn-star').hidden = !t || isNewtab(t.url)
  $('#btn-adblock').hidden = !t || !/^https?:/.test(t.url)
  updatePopupButton()
  updateTranslateButton()
}

function updateOmnibox () {
  const t = activeTab()
  const input = $('#omni-input')
  if (document.activeElement !== input) input.value = t ? prettyUrl(t.url) : ''
  const site = $('#omni-site')
  const url = t?.url || ''
  site.className = 'omni-site'
  let host = ''
  try { host = new URL(url).host } catch {}
  site.classList.toggle('clickable', /^https?:/.test(url))
  site.title = /^https?:/.test(url) ? T('Website-Informationen und -Einstellungen') : ''
  if (isNewtab(url) || url.startsWith('caravel:')) site.innerHTML = icon('search')
  else if (url.startsWith('https:') && S.certOverrides.has(host)) site.innerHTML = `${icon('warning')}<span class="host-pill danger">${T('Nicht sicher')}</span>`
  else if (url.startsWith('https:')) { site.classList.add('secure'); site.innerHTML = icon('lock') }
  else if (url.startsWith('http:')) site.innerHTML = `${icon('warning')}<span class="host-pill">${T('Nicht sicher')}</span>`
  else if (url.startsWith('file:')) site.innerHTML = icon('file')
  else if (url.startsWith('chrome-extension:')) site.innerHTML = icon('puzzle')
  else site.innerHTML = icon('globe')
}

function adblockPaused (url) {
  const host = hostOf(url)
  return !!host && (settings().adblockAllowlist || []).some(h => host === h || host.endsWith('.' + h))
}

function updateAdblockChip () {
  const t = activeTab()
  const b = $('#btn-adblock')
  const on = settings().adblock !== false && !(t && adblockPaused(t.url))
  b.classList.toggle('active', on)
  b.classList.toggle('has', on && t?.blocked > 0)
  b.innerHTML = `${icon(on ? 'shieldCheck' : 'shield')}${on && t?.blocked ? `<span>${t.blocked}</span>` : ''}`
  b.title = on ? T('Werbeblocker: {n} Anfragen auf dieser Seite blockiert', { n: t?.blocked || 0 }) : T('Werbeblocker ist hier pausiert')
}

function updateAmbient () {
  const t = activeTab()
  const accent = curSpace()?.color || '#f2545b'
  let amb = accent
  const priv = !!curSpace()?.private
  if (settings().ambient && !priv && t?.themeColor && !isNewtab(t.url) && !t.url.startsWith('caravel:')) amb = t.themeColor
  const dark = isDark()
  const base = toRgb(dark ? '#0a1022' : '#eef1f8')
  const ambRgb = toRgb(amb)
  // Privater Space: deutlich violett getönte Leiste, damit man ihn nie mit einem normalen verwechselt
  const toolbar = toHex(mixRgb(base, ambRgb, priv ? 0.28 : settings().ambient ? (dark ? 0.13 : 0.12) : 0))
  const root = document.documentElement.style
  root.setProperty('--ambient', toHex(ambRgb))
  root.setProperty('--toolbar', toolbar)
  const barHeight = parseInt(getComputedStyle(document.body).getPropertyValue('--toolbar-h')) || 44
  A.send('ui:titlebar', toolbar, dark ? '#e8ecf8' : '#101a33', barHeight)
}

function progress (state) {
  const p = $('#progress')
  if (state === 'start') {
    p.className = ''
    void p.offsetWidth
    p.className = 'run'
  } else if (state === 'stop') {
    p.className = 'done'
  } else {
    p.className = ''
  }
}

function initOmnibox () {
  const input = $('#omni-input')
  const box = $('#omnibox')
  const sugg = $('#omni-suggest')
  let items = []
  let sel = 0
  let reqId = 0

  const hide = () => { sugg.hidden = true; items = [] }
  const renderSugg = () => {
    sugg.innerHTML = ''
    items.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'sugg' + (i === sel ? ' sel' : '')
      const ico = document.createElement('span')
      ico.className = 's-ico'
      if (it.url && it.fav !== false) ico.append(faviconEl(it.favicon, it.url))
      else ico.innerHTML = icon(it.icon || 'search')
      row.append(ico)
      row.insertAdjacentHTML('beforeend', `<span class="s-text">${it.html || esc(it.title)}${it.sub ? `<span class="s-sub">— ${esc(it.sub)}</span>` : ''}</span><span class="s-tag">${esc(it.tag || '')}</span>`)
      row.onmousedown = e => { e.preventDefault(); run(it) }
      sugg.append(row)
    })
    sugg.hidden = items.length === 0
  }
  const hl = (text, q) => {
    const i = text.toLowerCase().indexOf(q.toLowerCase())
    if (i < 0 || !q) return esc(text)
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length))
  }
  const run = it => {
    hide()
    input.blur()
    if (it.tabId) return activate(it.tabId)
    const t = activeTab()
    if (t) loadInTab(t, it.target)
    else createTab({ url: it.target })
  }
  const update = () => {
    const q = input.value.trim()
    sel = 0
    if (!q) return hide()
    const target = toUrl(q)
    const isUrl = target && !target.startsWith(searchUrl(''))
    items = [isUrl
      ? { title: q, html: `${esc(q)}`, icon: 'globe', fav: false, tag: T('Öffnen'), target }
      : { title: q, html: `${esc(q)}`, icon: 'search', fav: false, tag: T('{engine}-Suche', { engine: SEARCH_ENGINES[settings().searchEngine]?.name || 'Google' }), target: searchUrl(q) }]
    const ql = q.toLowerCase()
    const seen = new Set()
    for (const t of S.tabs.values()) {
      if (items.length > 3) break
      if (isNewtab(t.url) || t.id === curSpace().activeId) continue
      if ((t.title + ' ' + t.url).toLowerCase().includes(ql)) {
        items.push({ title: t.title, html: hl(t.title, q), url: t.url, favicon: t.favicon, tag: T('Zu Tab wechseln'), tabId: t.id })
        seen.add(t.url)
      }
    }
    for (const b of bmFlat()) {
      if (items.length > 5) break
      if (seen.has(b.url)) continue
      if ((b.title + ' ' + b.url).toLowerCase().includes(ql)) {
        items.push({ title: b.title, html: hl(b.title, q), sub: hostOf(b.url), url: b.url, favicon: b.favicon, tag: T('Lesezeichen'), target: b.url })
        seen.add(b.url)
      }
    }
    for (const h of S.data.history) {
      if (items.length > 8) break
      if (seen.has(h.url)) continue
      if ((h.title + ' ' + h.url).toLowerCase().includes(ql)) {
        items.push({ title: h.title, html: hl(h.title || h.url, q), sub: hostOf(h.url), url: h.url, tag: T('Verlauf'), target: h.url })
        seen.add(h.url)
      }
    }
    renderSugg()
    const my = ++reqId
    if (!isUrl) {
      A.invoke('suggest', q).then(list => {
        if (my !== reqId || !list.length) return
        const extra = list.filter(p => p.toLowerCase() !== ql).slice(0, 4)
          .map(p => ({ title: p, html: hl(p, q), icon: 'search', fav: false, tag: '', target: searchUrl(p) }))
        items.splice(1, 0, ...extra)
        items = items.slice(0, 10)
        renderSugg()
      })
    }
  }

  input.addEventListener('focus', () => {
    box.classList.add('focused')
    const t = activeTab()
    input.value = t ? displayUrl(t.url) : ''
    setTimeout(() => input.select(), 0)
  })
  input.addEventListener('blur', () => {
    box.classList.remove('focused')
    setTimeout(hide, 100)
    updateOmnibox()
  })
  // Inline-Autovervollständigung wie in Chrome: „git“ → „github.com“ (Rest markiert, Entf/Rücktaste verwirft ihn)
  const inlineComplete = () => {
    const typed = input.value
    if (!typed || /\s/.test(typed) || input.selectionStart !== typed.length) return
    const ql = typed.toLowerCase()
    const strip = u => u.replace(/^https?:\/\/(www\.)?/i, '')
    const counts = new Map()
    const consider = (url, weight) => {
      if (!/^https?:/i.test(url)) return
      const s = strip(url)
      if (!s.toLowerCase().startsWith(ql)) return
      // ohne „/“ in der Eingabe nur bis zum Ende des Hostnamens ergänzen
      const end = ql.includes('/') ? s.length : (s.indexOf('/') === -1 ? s.length : s.indexOf('/'))
      const c = s.slice(0, Math.max(end, typed.length))
      counts.set(c, (counts.get(c) || 0) + weight)
    }
    for (const b of bmFlat()) consider(b.url, 5)
    for (const h of S.data.history.slice(0, 1500)) consider(h.url, 1)
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0]
    if (!best || best.length <= typed.length) return
    input.value = typed + best.slice(typed.length)
    input.setSelectionRange(typed.length, input.value.length)
  }
  input.addEventListener('input', e => {
    if (e.inputType === 'insertText' && !e.isComposing) inlineComplete() // nicht bei Einfügen oder IME-Eingabe
    update()
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sel = (sel + 1) % items.length; renderSugg() }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; renderSugg() }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (items[sel]) run(items[sel])
      else {
        const url = toUrl(input.value)
        if (url) { const t = activeTab(); t ? loadInTab(t, url) : createTab({ url }); input.blur() }
      }
    } else if (e.key === 'Escape') {
      hide()
      input.blur()
      activeTab()?.webview?.focus()
    }
  })
}

function focusOmnibox () {
  $('#omni-input').focus()
}

/* ---------------------------------------------------------------------
   Lesezeichen
   --------------------------------------------------------------------- */

// Datenmodell: S.data.bookmarks ist die Favoritenleiste; Einträge sind Links { id, url, title, favicon }
// oder Ordner { id, folder: true, title, children: [Links] } (eine Ebene, wie meist genutzt in Chrome).
const isFolder = b => !!b?.folder

function bmFlat () {
  const out = []
  for (const b of S.data.bookmarks) {
    if (isFolder(b)) out.push(...b.children)
    else out.push(b)
  }
  return out
}

function bmLocate (id) {
  for (const [i, b] of S.data.bookmarks.entries()) {
    if (b.id === id) return { item: b, list: S.data.bookmarks, index: i, parent: null }
    if (isFolder(b)) {
      const j = b.children.findIndex(c => c.id === id)
      if (j >= 0) return { item: b.children[j], list: b.children, index: j, parent: b }
    }
  }
  return null
}

const bmByUrl = url => bmFlat().find(b => b.url === url)
const bmNewId = () => 'bm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function saveBookmarks () {
  clearTimeout(saveTimers.bookmarks)
  A.send('store:set', 'bookmarks', S.data.bookmarks) // sofort, damit offene Neuer-Tab-Seiten aktuell bleiben
  renderFavorites()
  updateNav()
}

function normalizeBookmarkUrl (s) {
  s = String(s || '').trim()
  if (!s) return ''
  if (!/^[a-z][\w+.-]*:/i.test(s)) s = 'https://' + s
  try { return new URL(s).href } catch { return '' }
}

function addBookmark ({ url, title, favicon }, { folderId = null } = {}) {
  const bm = { id: bmNewId(), url, title: title || hostOf(url) || url, favicon: favicon || null }
  const folder = folderId ? bmLocate(folderId)?.item : null
  ;(isFolder(folder) ? folder.children : S.data.bookmarks).push(bm)
  saveBookmarks()
  return bm
}

function addFolder (title) {
  const f = { id: bmNewId(), folder: true, title: title || T('Neuer Ordner'), children: [] }
  S.data.bookmarks.push(f)
  saveBookmarks()
  return f
}

// Alle Tabs eines Spaces als Ordner in der Favoritenleiste ablegen (wie Chromes „Alle Tabs als Lesezeichen“)
function bookmarkAllTabs (sp = curSpace()) {
  const tabs = spaceTabs(sp).filter(t => /^(https?|file):/.test(t.url))
  if (!tabs.length) return toast('Nichts zu speichern', 'In diesem Space sind keine Webseiten geöffnet.', 'star')
  const f = addFolder(`${sp.name} · ${new Date().toLocaleDateString(I18N.locale)}`)
  f.children.push(...tabs.map(t => ({ id: bmNewId(), url: t.url, title: t.title || hostOf(t.url), favicon: t.favicon })))
  saveBookmarks()
  toast('Als Favoriten gespeichert', T('{n} Tabs im Ordner „{name}“.', { n: tabs.length, name: f.title }), 'star', {
    actions: [{ label: 'Umbenennen', run: () => editBookmarkDialog(f) }]
  })
}

function removeBookmarkId (id) {
  const loc = bmLocate(id)
  if (!loc) return
  loc.list.splice(loc.index, 1)
  saveBookmarks()
  const what = isFolder(loc.item) ? T('Ordner „{name}“', { name: loc.item.title }) : (loc.item.title || hostOf(loc.item.url))
  toast('Aus Favoriten entfernt', what, 'trash', {
    actions: [{ label: 'Rückgängig', run: () => { loc.list.splice(Math.min(loc.index, loc.list.length), 0, loc.item); saveBookmarks() } }]
  })
}

function removeBookmark (url) {
  const bm = bmByUrl(url)
  if (bm) removeBookmarkId(bm.id)
}

// Verschieben vor/hinter targetId oder in einen Ordner; targetId null = ans Ende der Leiste
function moveBookmark (id, targetId, where) {
  if (id === targetId) return
  const src = bmLocate(id)
  if (!src) return
  const dst0 = targetId ? bmLocate(targetId) : null
  if (where === 'into' && (isFolder(src.item) || !isFolder(dst0?.item))) where = 'after'
  src.list.splice(src.index, 1)
  const dst = targetId ? bmLocate(targetId) : null
  if (!dst) S.data.bookmarks.push(src.item)
  else if (where === 'into') dst.item.children.push(src.item)
  else {
    let list = dst.list
    let idx = dst.index
    if (isFolder(src.item) && dst.parent) { list = S.data.bookmarks; idx = list.indexOf(dst.parent) } // Ordner nur in der Leiste
    list.splice(where === 'after' ? idx + 1 : idx, 0, src.item)
  }
  saveBookmarks()
}

function moveToFolder (id, folderId) {
  const loc = bmLocate(id)
  if (!loc || (loc.parent?.id || '') === (folderId || '')) return
  loc.list.splice(loc.index, 1)
  const folder = folderId ? bmLocate(folderId)?.item : null
  ;(isFolder(folder) ? folder.children : S.data.bookmarks).push(loc.item)
  saveBookmarks()
}

function folderOptions (selected) {
  return `<option value="">${T('Favoritenleiste')}</option>` +
    S.data.bookmarks.filter(isFolder).map(f => `<option value="${esc(f.id)}" ${f.id === selected ? 'selected' : ''}>${esc(f.title)}</option>`).join('')
}

// Dialog zum Anlegen/Bearbeiten eines Favoriten oder Ordners
function editBookmarkDialog (bm, { kind = null, defaults = {} } = {}) {
  const isNew = !bm
  const folder = isNew ? kind === 'folder' : isFolder(bm)
  const parent = bm ? bmLocate(bm.id)?.parent?.id || '' : (defaults.folderId || '')
  const heading = T(folder ? (isNew ? 'Neuer Ordner' : 'Ordner umbenennen') : (isNew ? 'Favorit hinzufügen' : 'Favorit bearbeiten'))
  showModal(`
    <div class="modal-head"><h2>${heading}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <div class="field"><label>${T('Name')}</label><input class="input" id="bm-title" value="${esc(bm?.title || defaults.title || '')}" placeholder="${T(folder ? 'z. B. Arbeit' : 'z. B. Nachrichten')}"></div>
      ${folder ? '' : `
      <div class="field"><label>${T('Adresse')}</label><input class="input" id="bm-url" value="${esc(bm?.url || defaults.url || '')}" placeholder="${T('z. B. tagesschau.de')}" spellcheck="false"></div>
      <div class="field"><label>${T('Ordner')}</label><select class="input" id="bm-folder">${folderOptions(parent)}</select></div>`}
      <div class="muted" id="bm-err" style="color:#f87171;min-height:16px;font-size:12px"></div>
    </div>
    <div class="modal-foot">
      ${isNew ? '' : `<button class="btn ghost" id="bm-del" style="color:#f87171">${T('Entfernen')}</button><span class="grow"></span>`}
      <button class="btn ghost" data-close>${T('Abbrechen')}</button>
      <button class="btn" id="bm-save">${isNew ? T('Hinzufügen') : T('Speichern')}</button>
    </div>`)
  const title = $('#bm-title')
  ;(folder || bm ? title : $('#bm-url') || title).focus()
  let done = false // Enter im Feld und Klick dürfen nicht doppelt speichern
  const submit = () => {
    if (done) return
    const name = title.value.trim()
    if (folder) {
      done = true
      if (isNew) addFolder(name)
      else { bm.title = name || bm.title; saveBookmarks() }
      return closeModal()
    }
    const url = normalizeBookmarkUrl($('#bm-url').value)
    if (!url) { $('#bm-err').textContent = T('Bitte eine gültige Adresse eingeben.'); return $('#bm-url').focus() }
    const folderId = $('#bm-folder').value || null
    done = true
    if (isNew) addBookmark({ url, title: name || hostOf(url) }, { folderId })
    else {
      if (bm.url !== url) bm.favicon = null
      Object.assign(bm, { url, title: name || hostOf(url) })
      moveToFolder(bm.id, folderId)
      saveBookmarks()
    }
    closeModal()
  }
  $('#bm-save').onclick = submit
  $('#modal-card').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit() })
  const del = $('#bm-del')
  if (del) del.onclick = () => { closeModal(); removeBookmarkId(bm.id) }
}

// Stern in der Adressleiste (Strg+D): wie in Chrome sofort speichern und Bearbeiten-Blase zeigen
function toggleBookmark () {
  if (S.popover === 'bookmark') return hidePopover()
  const t = activeTab()
  if (!t || isNewtab(t.url)) return
  let bm = bmByUrl(t.url)
  const added = !bm
  if (!bm) bm = addBookmark({ url: t.url, title: t.title, favicon: t.favicon })
  const parent = bmLocate(bm.id)?.parent?.id || ''
  const html = `
    <h3>${icon('star')} ${added ? T('Zu Favoriten hinzugefügt') : T('Favorit bearbeiten')}</h3>
    <div class="field"><label>${T('Name')}</label><input class="input" id="bb-title" value="${esc(bm.title)}"></div>
    <div class="field"><label>${T('Ordner')}</label><select class="input" id="bb-folder">${folderOptions(parent)}<option value="__new">${T('Neuer Ordner …')}</option></select></div>
    <div class="flex" id="bb-newrow" hidden style="gap:8px;margin-top:8px"><input class="input grow" id="bb-newname" placeholder="${T('Name des Ordners')}"><button class="btn ghost sm" id="bb-newok">${T('Anlegen')}</button></div>
    <div class="flex" style="margin-top:14px;gap:8px">
      <button class="btn ghost sm" id="bb-more">${T('Mehr …')}</button><span class="grow"></span>
      <button class="btn ghost sm" id="bb-remove">${T('Entfernen')}</button>
      <button class="btn sm" id="bb-done">${T('Fertig')}</button>
    </div>`
  const pop = showPopover($('#btn-star'), html, 'bookmark', 320)
  const input = $('#bb-title', pop)
  input.select()
  input.oninput = () => { bm.title = input.value; saveBookmarks() }
  input.onkeydown = e => { if (e.key === 'Enter') hidePopover() }
  const select = $('#bb-folder', pop)
  const newRow = $('#bb-newrow', pop)
  select.onchange = () => {
    if (select.value === '__new') { newRow.hidden = false; return $('#bb-newname', pop).focus() }
    newRow.hidden = true
    moveToFolder(bm.id, select.value || null)
  }
  const createFolder = () => {
    const name = $('#bb-newname', pop).value.trim()
    if (!name) return
    const f = addFolder(name)
    moveToFolder(bm.id, f.id)
    select.innerHTML = folderOptions(f.id) + `<option value="__new">${T('Neuer Ordner …')}</option>`
    newRow.hidden = true
  }
  $('#bb-newok', pop).onclick = createFolder
  $('#bb-newname', pop).onkeydown = e => { if (e.key === 'Enter') createFolder() }
  $('#bb-remove', pop).onclick = () => { hidePopover(); removeBookmarkId(bm.id) }
  $('#bb-done', pop).onclick = hidePopover
  $('#bb-more', pop).onclick = () => { hidePopover(); editBookmarkDialog(bm) }
}

// Favicon eines Favoriten aktualisieren, sobald die Seite besucht wird
function refreshBookmarkFavicon (tab) {
  if (!tab?.favicon || !tab.url) return
  const bm = bmByUrl(tab.url)
  if (bm && bm.favicon !== tab.favicon) { bm.favicon = tab.favicon; saveBookmarks() }
}

// Änderungen von der Neuer-Tab-Seite (Kacheln hinzufügen, bearbeiten, verschieben, entfernen)
function handleNtpBookmark ({ op, data = {} }) {
  if (op === 'add') {
    const url = normalizeBookmarkUrl(data.url)
    if (url && !bmByUrl(url)) addBookmark({ url, title: String(data.title || '').trim() || hostOf(url) })
  } else if (op === 'update') {
    const bm = bmLocate(data.id)?.item
    const url = normalizeBookmarkUrl(data.url)
    if (bm && !isFolder(bm) && url) {
      if (bm.url !== url) bm.favicon = null
      Object.assign(bm, { url, title: String(data.title || '').trim() || hostOf(url) })
      saveBookmarks()
    }
  } else if (op === 'remove') {
    removeBookmarkId(data.id)
  } else if (op === 'move') {
    moveBookmark(data.id, data.beforeId || null, data.beforeId ? 'before' : 'after')
  }
}

/* ---------------------------------------------------------------------
   Menüs, Popover, Modals, Toasts
   --------------------------------------------------------------------- */

function showMenu (x, y, items) {
  const m = $('#menu')
  m.innerHTML = ''
  for (const it of items) {
    if (!it || it.hidden) continue
    if (it === '-') { m.insertAdjacentHTML('beforeend', '<div class="m-sep"></div>'); continue }
    if (it.custom) { m.append(it.custom); continue }
    const el = document.createElement('div')
    el.className = 'm-item' + (it.danger ? ' danger' : '')
    // Menütexte zentral übersetzen (Favoriten im Menü sind Nutzerinhalt)
    el.innerHTML = `${it.fav ? '' : icon(it.icon || 'dots')}<span class="m-label">${esc(it.fav ? it.label : T(it.label))}</span>${it.hint ? `<span class="m-hint">${esc(T(it.hint))}</span>` : ''}`
    if (it.fav) el.prepend(faviconEl(it.fav.favicon, it.fav.url, 16)) // Favoriten im Menü mit Website-Symbol
    el.onclick = () => { hideMenu(); it.run() }
    m.append(el)
  }
  m.hidden = false
  const r = m.getBoundingClientRect()
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px'
}
function hideMenu () { $('#menu').hidden = true }

// width: feste Breite in px – wird vor dem Ausrichten gesetzt (sonst erbte das Popover die Breite des zuletzt geöffneten)
function showPopover (anchor, html, name, width = null) {
  const p = $('#popover')
  if (S.popover === 'cast' && name !== 'cast') castDialogClosed()
  p.style.width = width ? width + 'px' : ''
  p.innerHTML = html
  p.hidden = false
  S.popover = name
  const r = anchor.getBoundingClientRect()
  const w = p.offsetWidth
  p.style.top = (r.bottom + 8) + 'px'
  p.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'
  return p
}
function hidePopover () {
  const prev = S.popover
  $('#popover').hidden = true
  S.popover = null
  if (prev === 'cast') castDialogClosed()
}

function closeFloating () {
  hideMenu()
  hidePopover()
}

function showModal (html, { wide = false } = {}) {
  const ov = $('#modal')
  const card = $('#modal-card')
  card.className = 'modal' + (wide ? ' wide' : '')
  card.innerHTML = html
  ov.hidden = false
  card.querySelectorAll('[data-close]').forEach(b => { b.onclick = closeModal })
}
function closeModal () {
  $('#modal').hidden = true
  $('#modal-card').innerHTML = ''
  S.modalSection = null
  // offene Geräteauswahl gilt als abgebrochen
  if (S.devicePick) { A.send('ui:reply', S.devicePick.reqId, null); S.devicePick = null }
}

function confirmDialog (title, text, okLabel, onOk) {
  showModal(`<div class="modal-head"><h2>${esc(T(title))}</h2></div><div class="modal-body"><p class="muted" style="margin:0">${esc(T(text))}</p></div><div class="modal-foot"><button class="btn ghost" data-close>${T('Abbrechen')}</button><button class="btn danger" id="cf-ok">${esc(T(okLabel))}</button></div>`)
  $('#cf-ok').onclick = () => { closeModal(); onOk() }
}

function toast (title, text = '', ic = 'info', { actions = [], image = null, duration = 3600 } = {}) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = `${image ? `<img class="shot" src="${esc(image)}">` : `<div class="t-ico">${icon(ic)}</div>`}<div class="t-body"><div class="t-title">${esc(T(title))}</div>${text ? `<div class="t-text">${esc(T(text))}</div>` : ''}</div>`
  for (const a of actions) {
    const b = document.createElement('button')
    b.className = 'btn ghost sm'
    b.textContent = T(a.label)
    b.onclick = () => { a.run(); dismiss() }
    el.append(b)
  }
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250) }
  $('#toasts').append(el)
  // Beim Überfahren stehen bleiben (bisher wurde der Timer nie angehalten)
  el._t = setTimeout(dismiss, duration)
  el.addEventListener('mouseenter', () => clearTimeout(el._t))
  el.addEventListener('mouseleave', () => { el._t = setTimeout(dismiss, 1500) })
}

function appMenu () {
  const t = activeTab()
  const zoomRow = document.createElement('div')
  zoomRow.className = 'm-row'
  const pct = Math.round(Math.pow(1.2, t?.zoom || 0) * 100)
  zoomRow.innerHTML = `${icon('zoomIn')}<span class="m-label" style="margin-left:10px">${T('Zoom')}</span><button class="icon-btn sm" data-z="-1">${icon('minus')}</button><span class="zoom-val">${pct} %</span><button class="icon-btn sm" data-z="1">${icon('plus')}</button><button class="icon-btn sm" data-z="full" title="${T('Vollbild (F11)')}">${icon('expand')}</button>`
  zoomRow.addEventListener('click', e => {
    const b = e.target.closest('[data-z]'); if (!b) return
    if (b.dataset.z === 'full') { hideMenu(); return toggleFullscreen() }
    zoom(+b.dataset.z)
    $('.zoom-val', zoomRow).textContent = Math.round(Math.pow(1.2, activeTab()?.zoom || 0) * 100) + ' %'
  })
  const r = $('#btn-menu').getBoundingClientRect()
  showMenu(r.right - 260, r.bottom + 6, [
    { label: 'Neuer Tab', icon: 'plus', hint: 'Strg+T', run: () => createTab() },
    { label: 'Privater Space', icon: 'incognito', hint: 'Strg+Umschalt+N', run: () => openPrivate() },
    { label: 'Neuer Space', icon: 'layers', run: () => editSpaceDialog(null) },
    { label: 'Befehlspalette', icon: 'command', hint: 'Strg+K', run: openPalette },
    '-',
    { custom: zoomRow },
    '-',
    { label: 'Verlauf', icon: 'history', hint: 'Strg+H', run: () => togglePanel('history') },
    { label: 'Downloads', icon: 'download', hint: 'Strg+J', run: () => togglePanel('downloads') },
    { label: 'Seiten-Notizen', icon: 'note', run: () => togglePanel('notes') },
    { label: 'Zeitkapseln', icon: 'archive', run: () => togglePanel('snapshots') },
    { label: 'Erweiterungen', icon: 'puzzle', run: () => togglePanel('extensions') },
    { label: 'Passwörter', icon: 'key', run: () => openSettings('passwords') },
    '-',
    { label: 'Screenshot', icon: 'camera', hint: 'Strg+Umschalt+X', run: screenshot },
    { label: 'Streamen …', icon: 'cast', run: () => openCast() },
    { label: 'Auf Seite suchen', icon: 'search', hint: 'Strg+F', run: openFind },
    { label: 'Übersetzen …', icon: 'translate', run: openTranslatePopover },
    { label: 'Speichern unter …', icon: 'download', hint: 'Strg+S', run: savePage },
    { label: 'Datei öffnen …', icon: 'file', hint: 'Strg+O', run: openFile },
    { label: 'Drucken …', icon: 'print', hint: 'Strg+P', run: () => activeTab()?.ready && activeTab().webview.print() },
    { label: 'Entwicklertools', icon: 'command', hint: 'F12', run: devtools },
    '-',
    { label: 'Einstellungen', icon: 'settings', hint: 'Strg+,', run: () => openSettings() },
    { label: 'Tastenkürzel', icon: 'keyboard', run: showShortcuts },
    { label: 'Über Caravel', icon: 'info', run: () => openSettings('about') }
  ])
}

/* ---------------------------------------------------------------------
   Seitenpanel
   --------------------------------------------------------------------- */

const PANEL_TITLES = { history: 'Verlauf', downloads: 'Downloads', notes: 'Seiten-Notizen', snapshots: 'Zeitkapseln', extensions: 'Erweiterungen' }

function togglePanel (name) {
  if (S.panel === name) return closePanel()
  S.panel = name
  $('#panel').hidden = false
  $('#panel-title').textContent = T(PANEL_TITLES[name])
  renderPanel()
  renderSbTools()
}
function closePanel () {
  S.panel = null
  $('#panel').hidden = true
  renderSbTools()
}

function renderPanel () {
  const body = $('#panel-body')
  const fn = { history: renderHistory, downloads: renderDownloads, notes: renderNotes, snapshots: renderSnapshots, extensions: renderExtensions }[S.panel]
  if (fn) fn(body)
}

function rowEl ({ url, favicon, title, sub, time, actions = [], onClick, iconName }) {
  const row = document.createElement('div')
  row.className = 'row'
  const ico = document.createElement('span')
  ico.className = 'r-ico'
  if (iconName) ico.innerHTML = icon(iconName)
  else ico.append(faviconEl(favicon, url))
  row.append(ico)
  row.insertAdjacentHTML('beforeend', `<div class="r-main"><div class="r-title">${esc(title)}</div>${sub ? `<div class="r-sub">${esc(sub)}</div>` : ''}</div>`)
  if (actions.length) {
    const act = document.createElement('div')
    act.className = 'r-act'
    for (const a of actions) {
      const b = document.createElement('button')
      b.className = 'icon-btn sm'
      b.title = T(a.title)
      b.innerHTML = icon(a.icon)
      b.onclick = e => { e.stopPropagation(); a.run() }
      act.append(b)
    }
    row.append(act)
  }
  if (time) row.insertAdjacentHTML('beforeend', `<span class="r-time">${esc(time)}</span>`)
  if (onClick) row.onclick = onClick
  return row
}

function renderHistory (body) {
  const q = body.querySelector('.panel-search')?.value || ''
  body.innerHTML = ''
  const search = document.createElement('input')
  search.className = 'panel-search'
  search.placeholder = T('Verlauf durchsuchen …')
  search.value = q
  search.oninput = () => { renderHistory(body); const s = body.querySelector('.panel-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length) }
  body.append(search)
  const ql = q.toLowerCase()
  const list = S.data.history.filter(h => !ql || (h.title + ' ' + h.url).toLowerCase().includes(ql)).slice(0, 300)
  if (!list.length) { body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('history')}<div>${q ? T('Keine Treffer') : T('Noch kein Verlauf')}</div></div>`); return }
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86400000).toDateString()
  let last = ''
  for (const h of list) {
    const d = new Date(h.time)
    const ds = d.toDateString()
    const label = ds === today ? T('Heute') : ds === yesterday ? T('Gestern') : d.toLocaleDateString(I18N.locale, { weekday: 'long', day: 'numeric', month: 'long' })
    if (label !== last) { body.insertAdjacentHTML('beforeend', `<div class="group-title">${esc(label)}</div>`); last = label }
    body.append(rowEl({
      url: h.url,
      title: h.title || h.url,
      sub: hostOf(h.url),
      time: d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' }),
      onClick: () => createTab({ url: h.url }),
      actions: [
        { icon: 'eye', title: 'Peek', run: () => openPeek(h.url) },
        { icon: 'trash', title: 'Entfernen', run: () => { S.data.history = S.data.history.filter(x => x !== h); save('history'); renderHistory(body) } }
      ]
    }))
  }
  const clear = document.createElement('button')
  clear.className = 'btn ghost block'
  clear.style.marginTop = '14px'
  clear.innerHTML = `${icon('trash')} ${T('Gesamten Verlauf löschen')}`
  clear.onclick = () => confirmDialog('Verlauf löschen?', 'Der gesamte Browserverlauf wird unwiderruflich entfernt.', 'Löschen', () => { S.data.history = []; save('history'); renderPanel() })
  body.append(clear)
}

function renderDownloads (body) {
  body.innerHTML = ''
  const live = [...S.downloads.values()]
  const liveKeys = new Set(live.map(d => `${d.started}|${d.path}`))
  const old = (S.data.downloadHistory || []).filter(h => !liveKeys.has(h.key)).map(h => ({ ...h, id: h.key, received: h.total, old: true }))
  const list = [...live, ...old].sort((a, b) => b.started - a.started)
  if (!list.length) { body.innerHTML = `<div class="empty">${icon('download')}<div>${T('Noch keine Downloads')}</div></div>`; return }
  const head = document.createElement('div')
  head.className = 'flex'
  head.style.marginBottom = '10px'
  head.innerHTML = `<button class="btn ghost sm" id="dl-folder">${icon('folder')} ${T('Download-Ordner')}</button><span class="grow"></span><button class="btn ghost sm" id="dl-clear">${T('Liste leeren')}</button>`
  body.append(head)
  $('#dl-folder', head).onclick = () => openSettings('downloads')
  $('#dl-clear', head).onclick = () => {
    S.data.downloadHistory = []
    save('downloadHistory')
    for (const [id, d] of S.downloads) if (d.state !== 'progressing') S.downloads.delete(id)
    renderPanel()
  }
  for (const d of list) {
    const card = document.createElement('div')
    card.className = 'card'
    const pct = d.total ? Math.round(d.received / d.total * 100) : 0
    const state = d.state === 'completed' ? T('Fertig · {size}', { size: fmtBytes(d.total || d.received) })
      : d.state === 'cancelled' ? T('Abgebrochen')
        : d.state === 'interrupted' ? T('Unterbrochen')
          : d.paused ? T('Pausiert · {pct} %', { pct }) : T('{done} von {total}', { done: fmtBytes(d.received), total: d.total ? fmtBytes(d.total) : '?' })
    card.innerHTML = `<div class="flex"><span class="r-ico">${icon('file')}</span><div class="grow" style="min-width:0"><div class="r-title" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</div><div class="muted" style="font-size:12px">${esc(state)}</div></div></div>${d.state === 'progressing' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}<div class="ext-actions"></div>`
    const act = $('.ext-actions', card)
    const btn = (label, fn, ghost = true) => { const b = document.createElement('button'); b.className = 'btn sm' + (ghost ? ' ghost' : ''); b.textContent = T(label); b.onclick = fn; act.append(b) }
    if (d.state === 'completed') { btn('Öffnen', () => A.send('dl:open', d.path), false); btn('Im Ordner zeigen', () => A.send('dl:show', d.path)) }
    if (d.state === 'progressing') { btn(d.paused ? 'Fortsetzen' : 'Pausieren', () => A.send('dl:control', d.id, d.paused ? 'resume' : 'pause')); btn('Abbrechen', () => A.send('dl:control', d.id, 'cancel')) }
    if ((d.state === 'cancelled' || d.state === 'interrupted') && /^https?:/.test(d.url)) btn('Erneut herunterladen', () => A.send('dl:retry', d.url, !!d.private))
    if (d.state !== 'progressing') {
      btn('Aus Liste entfernen', () => {
        const key = `${d.started}|${d.path}`
        S.data.downloadHistory = (S.data.downloadHistory || []).filter(h => h.key !== key)
        save('downloadHistory')
        if (!d.old) S.downloads.delete(d.id)
        renderPanel()
      })
    }
    body.append(card)
  }
}

function updateDownloadDot () {
  const b = $('#sb-tools [data-panel="downloads"]')
  if (!b) return
  const active = [...S.downloads.values()].some(d => d.state === 'progressing')
  b.querySelector('.dot')?.remove()
  if (active) b.insertAdjacentHTML('beforeend', '<span class="dot"></span>')
}

function renderNotes (body) {
  body.innerHTML = ''
  const t = activeTab()
  const host = t && /^https?:/.test(t.url) ? hostOf(t.url) : ''
  body.insertAdjacentHTML('beforeend', `<p class="panel-note">${T('Notizen werden pro Website gespeichert und erscheinen automatisch wieder, wenn du die Seite erneut besuchst. Markierter Text lässt sich per Rechtsklick direkt übernehmen.')}</p>`)
  if (host) {
    const head = document.createElement('div')
    head.className = 'note-host'
    head.append(faviconEl(t.favicon, t.url))
    head.insertAdjacentHTML('beforeend', `<span>${esc(host)}</span>`)
    body.append(head)
    const ta = document.createElement('textarea')
    ta.className = 'note-area'
    ta.placeholder = T('Gedanken, To-dos oder Zitate zu {host} …', { host })
    ta.value = S.data.notes[host]?.text || ''
    ta.oninput = () => {
      if (ta.value.trim()) S.data.notes[host] = { text: ta.value, updated: Date.now(), url: t.url }
      else delete S.data.notes[host]
      save('notes')
    }
    body.append(ta)
  } else {
    body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('note')}<div>${T('Öffne eine Website, um Notizen dazu anzulegen.')}</div></div>`)
  }
  const others = Object.entries(S.data.notes).filter(([h]) => h !== host).sort((a, b) => b[1].updated - a[1].updated)
  if (others.length) {
    body.insertAdjacentHTML('beforeend', `<div class="group-title">${T('Alle Notizen')}</div>`)
    for (const [h, n] of others) {
      body.append(rowEl({
        url: n.url || 'https://' + h,
        title: h,
        sub: n.text.split('\n')[0].slice(0, 80),
        time: timeAgo(n.updated),
        onClick: () => createTab({ url: n.url || 'https://' + h })
      }))
    }
  }
}

function addNoteText (text) {
  const t = activeTab()
  if (!t || !/^https?:/.test(t.url)) return
  const host = hostOf(t.url)
  const prev = S.data.notes[host]?.text || ''
  S.data.notes[host] = { text: (prev ? prev.trimEnd() + '\n\n' : '') + '„' + text + '“', updated: Date.now(), url: t.url }
  save('notes')
  if (S.panel !== 'notes') togglePanel('notes'); else renderPanel()
}

function saveSnapshot (sp = curSpace()) {
  if (sp.private) return toast('Nicht möglich', 'Der private Space wird nie gespeichert – auch nicht als Zeitkapsel.', 'incognito')
  const tabs = spaceTabs(sp).filter(t => !isNewtab(t.url))
  if (!tabs.length) return toast('Nichts zu sichern', 'Dieser Space hat keine geöffneten Seiten.', 'archive')
  S.data.snapshots.unshift({
    id: 'snap-' + Date.now(),
    name: sp.name,
    color: sp.color,
    icon: sp.icon,
    created: Date.now(),
    tabs: tabs.map(t => ({ url: t.url, title: t.title, favicon: t.favicon }))
  })
  save('snapshots')
  toast('Zeitkapsel gespeichert', T('{n} Tabs aus „{name}“ gesichert.', { n: tabs.length, name: sp.name }), 'archive')
  if (S.panel === 'snapshots') renderPanel()
}

function restoreSnapshot (snap) {
  const sp = addSpace({ name: `${snap.name} · ${new Date(snap.created).toLocaleDateString(I18N.locale)}`, color: snap.color, icon: snap.icon })
  const first = sp.tabIds[0]
  snap.tabs.forEach(t => createTab({ url: t.url, title: t.title, favicon: t.favicon, spaceId: sp.id, sleeping: true, background: true }))
  if (first) closeTab(first)
  activate(sp.tabIds[0])
  toast('Zeitkapsel geöffnet', T('{n} Tabs wiederhergestellt – schlafend, bis du sie brauchst.', { n: snap.tabs.length }), 'archive')
}

function renderSnapshots (body) {
  body.innerHTML = ''
  body.insertAdjacentHTML('beforeend', `<p class="panel-note">${T('Zeitkapseln frieren einen ganzen Space ein – alle Tabs, sortiert und benannt. Später öffnest du ihn als neuen Space und machst genau dort weiter.')}</p>`)
  const btn = document.createElement('button')
  btn.className = 'btn block'
  btn.innerHTML = `${icon('archive')} ${esc(T('„{name}“ jetzt sichern', { name: curSpace().name }))}`
  btn.onclick = () => saveSnapshot()
  body.append(btn)
  if (!S.data.snapshots.length) { body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('archive')}<div>${T('Noch keine Zeitkapseln')}</div></div>`); return }
  body.insertAdjacentHTML('beforeend', `<div class="group-title">${T('Gespeichert')}</div>`)
  for (const snap of S.data.snapshots) {
    const card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = `<div class="flex"><span class="space-btn active" style="--sc:${esc(snap.color)};cursor:default">${esc(snap.icon)}</span><div class="grow"><h3>${esc(snap.name)}</h3><div class="muted" style="font-size:12px">${T('{n} Tabs', { n: snap.tabs.length })} · ${new Date(snap.created).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' })}</div></div></div><div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">${snap.tabs.slice(0, 4).map(t => esc(t.title || hostOf(t.url))).join(' · ')}${snap.tabs.length > 4 ? ' …' : ''}</div><div class="ext-actions"><button class="btn sm" data-a="open">${T('Öffnen')}</button><button class="btn ghost sm" data-a="del">${T('Löschen')}</button></div>`
    card.querySelector('[data-a=open]').onclick = () => restoreSnapshot(snap)
    card.querySelector('[data-a=del]').onclick = () => { S.data.snapshots = S.data.snapshots.filter(s => s !== snap); save('snapshots'); renderPanel() }
    body.append(card)
  }
}

async function renderExtensions (body) {
  const list = await A.invoke('ext:list')
  body.innerHTML = ''
  body.insertAdjacentHTML('beforeend', `<p class="panel-note">${T('Caravel unterstützt Chrome-Erweiterungen direkt aus dem Chrome Web Store. Öffne den Store und klicke bei einer Erweiterung auf „Hinzufügen“. Aktionssymbole erscheinen rechts in der Werkzeugleiste.')}</p>`)
  const actions = document.createElement('div')
  actions.className = 'flex'
  actions.style.marginBottom = '12px'
  actions.innerHTML = `<button class="btn" id="ext-store">${icon('external')} Chrome Web Store</button><button class="btn ghost" id="ext-unpacked">${icon('folder')} ${T('Entpackt laden')}</button>`
  body.append(actions)
  $('#ext-store', body).onclick = () => createTab({ url: 'https://chromewebstore.google.com/' })
  $('#ext-unpacked', body).onclick = async () => {
    try {
      const ext = await A.invoke('ext:load-unpacked')
      if (ext) { toast('Erweiterung geladen', ext.name, 'puzzle'); renderPanel() }
    } catch (err) { toast('Laden fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: /, ''), 'warning') }
  }
  if (!list.length) {
    body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('puzzle')}<div>${T('Noch keine Erweiterungen installiert.')}<br><span style="font-size:12px">${T('Beliebt:')} Dark Reader, Bitwarden, Grammarly, DeepL</span></div></div>`)
    return
  }
  body.insertAdjacentHTML('beforeend', `<div class="group-title">${T('Installiert ({n})', { n: list.length })}</div>`)
  for (const ext of list) {
    const card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = `<div class="ext-row">${ext.icon ? `<img src="${ext.icon}">` : `<div class="ext-ph">${icon('puzzle')}</div>`}<div class="grow" style="min-width:0"><h3>${esc(ext.name)}</h3><div class="muted" style="font-size:12px">${T('Version')} ${esc(ext.version)}${ext.unpacked ? ' · ' + T('entpackt') : ' · Chrome Web Store'}</div>${ext.description ? `<div class="muted" style="font-size:12px;margin-top:6px;line-height:1.45">${esc(ext.description)}</div>` : ''}</div></div><div class="ext-actions"></div>`
    const act = $('.ext-actions', card)
    if (ext.options) {
      const o = document.createElement('button')
      o.className = 'btn ghost sm'
      o.textContent = T('Optionen')
      o.onclick = () => createTab({ url: `chrome-extension://${ext.id}/${ext.options}` })
      act.append(o)
    }
    const r = document.createElement('button')
    r.className = 'btn ghost sm'
    r.textContent = T('Entfernen')
    r.onclick = () => confirmDialog(T('„{name}“ entfernen?', { name: ext.name }), 'Die Erweiterung und ihre Daten werden aus Caravel entfernt.', 'Entfernen', async () => {
      await A.invoke('ext:remove', ext.id)
      toast('Erweiterung entfernt', ext.name, 'puzzle')
      renderPanel()
    })
    act.append(r)
    body.append(card)
  }
}

/* ---------------------------------------------------------------------
   Befehlspalette
   --------------------------------------------------------------------- */

function commands () {
  const t = activeTab()
  const list = [
    { title: 'Neuer Tab', icon: 'plus', hint: 'Strg+T', run: () => createTab() },
    { title: 'Tab schließen', icon: 'x', hint: 'Strg+W', run: () => t && closeTab(t.id) },
    { title: 'Geschlossenen Tab wiederherstellen', icon: 'history', hint: 'Strg+Umschalt+T', run: reopenClosed },
    { title: 'Split View umschalten', icon: 'split', hint: 'Strg+Umschalt+S', run: toggleSplit },
    { title: 'Leser-Modus', icon: 'reader', hint: 'F9', run: toggleReader },
    { title: 'Screenshot aufnehmen', icon: 'camera', hint: 'Strg+Umschalt+X', run: screenshot },
    { title: S.focus.active ? 'Fokus-Modus beenden' : 'Fokus-Modus starten', icon: 'focus', hint: 'Strg+Umschalt+F', run: () => S.focus.active ? endFocus(false) : startFocus(settings().focusMinutes) },
    { title: 'Streamen (Chromecast)', icon: 'cast', run: () => openCast() },
    ...(dockEnabled() ? [
      { title: T('{ai}-Seitenleiste', { ai: assistant().name }), icon: 'chat', hint: 'Strg+E', run: () => toggleDock() },
      { title: T('Seite an {ai} übergeben', { ai: assistant().name }), icon: 'send', hint: 'Strg+Umschalt+L', run: () => sendPageToClaude('context') },
      { title: T('Seite mit {ai} zusammenfassen', { ai: assistant().name }), icon: 'chat', run: () => sendPageToClaude('summarize') }
    ] : []),
    ...(settings().assistant === 'claude' ? [{ title: 'Claude in Chrome öffnen', icon: 'agent', run: openClaudeExtension }] : []),
    { title: 'KI-Assistent wählen', icon: 'chat', run: () => openSettings('claude') },
    { title: 'Seite als Markdown kopieren', icon: 'markdown', run: copyPageAsMarkdown },
    { title: S.vpn?.status === 'on' ? 'VPN trennen' : 'VPN verbinden', icon: 'vpn', run: () => S.vpn?.status === 'on' ? A.invoke('vpn:disconnect') : A.invoke('vpn:connect') },
    { title: 'VPN-Menü', icon: 'vpn', run: openVpnPopover },
    { title: 'Werbeblocker-Einstellungen', icon: 'shieldCheck', run: () => openSettings('adblock') },
    { title: 'Lesezeichen setzen/entfernen', icon: 'star', hint: 'Strg+D', run: toggleBookmark },
    { title: 'Seite drucken', icon: 'print', hint: 'Strg+P', run: () => t?.ready && t.webview.print() },
    { title: 'Neuer Space', icon: 'layers', run: () => editSpaceDialog(null) },
    ...S.spaces.map((sp, i) => ({ title: `Space: ${sp.name}`, user: true, icon: 'layers', hint: `Alt+${i + 1}`, run: () => switchSpace(sp.id) })),
    { title: 'Zeitkapsel dieses Spaces speichern', icon: 'archive', run: () => saveSnapshot() },
    { title: 'Verlauf anzeigen', icon: 'history', hint: 'Strg+H', run: () => togglePanel('history') },
    { title: 'Downloads anzeigen', icon: 'download', hint: 'Strg+J', run: () => togglePanel('downloads') },
    { title: 'Seiten-Notizen', icon: 'note', hint: 'Strg+Umschalt+U', run: () => togglePanel('notes') },
    { title: 'Privater Space (Inkognito)', icon: 'incognito', hint: 'Strg+Umschalt+N', run: () => openPrivate() },
    { title: 'Seite übersetzen', icon: 'translate', run: openTranslatePopover },
    { title: 'Bild-im-Bild', icon: 'pip', run: togglePip },
    { title: 'Seite speichern unter …', icon: 'download', hint: 'Strg+S', run: savePage },
    { title: 'Datei öffnen …', icon: 'file', hint: 'Strg+O', run: openFile },
    { title: 'Alle Tabs als Favoriten speichern', icon: 'star', run: () => bookmarkAllTabs() },
    { title: 'Website-Einstellungen', icon: 'lock', run: openSitePopover },
    { title: 'Passwörter verwalten', icon: 'key', run: () => openSettings('passwords') },
    { title: 'Favoriten und Verlauf importieren', icon: 'importIcon', run: openImportDialog },
    { title: 'Nach Updates suchen', icon: 'refresh', run: () => openSettings('about') },
    { title: 'Erweiterungen verwalten', icon: 'puzzle', hint: 'Strg+Umschalt+E', run: () => togglePanel('extensions') },
    { title: 'Chrome Web Store öffnen', icon: 'external', run: () => createTab({ url: 'https://chromewebstore.google.com/' }) },
    { title: 'Einstellungen', icon: 'settings', hint: 'Strg+,', run: () => openSettings() },
    { title: isDark() ? 'Helles Design' : 'Dunkles Design', icon: isDark() ? 'sun' : 'moon', run: () => { settings().theme = isDark() ? 'light' : 'dark'; save('settings'); applyTheme() } },
    { title: 'Seitenleiste ein-/ausklappen', icon: 'sidebar', hint: 'Strg+B', run: toggleSidebar },
    { title: 'Alle Hintergrund-Tabs schlafen legen', icon: 'zzz', run: sleepAll },
    { title: 'Entwicklertools', icon: 'command', hint: 'F12', run: devtools },
    { title: 'Tastenkürzel anzeigen', icon: 'keyboard', run: showShortcuts },
    { title: 'Browserdaten löschen', icon: 'trash', run: () => openSettings('privacy') }
  ]
  // Befehle in der aktuellen Sprache (Nutzerinhalte wie Space-Namen bleiben unverändert)
  return list.map(c => ({ ...c, title: c.user ? c.title : T(c.title), hint: c.hint && T(c.hint), kind: T('Befehle') }))
}

function fuzzy (q, text) {
  const t = text.toLowerCase()
  const i = t.indexOf(q)
  if (i >= 0) return 100 - Math.min(i, 50) + (i === 0 ? 20 : 0)
  let p = 0
  for (const c of q) { p = t.indexOf(c, p); if (p < 0) return -1; p++ }
  return 10
}

function openPalette () {
  closeFloating()
  const ov = $('#palette')
  const input = $('#palette-input')
  const list = $('#palette-list')
  $('.pi-icon', ov).innerHTML = icon('command')
  ov.hidden = false
  input.value = ''
  let items = []
  let sel = 0

  const build = () => {
    const q = input.value.trim().toLowerCase()
    const tabs = [...S.tabs.values()].map(t => ({
      title: t.title || T('Neuer Tab'), sub: (space(t.spaceId)?.name || '') + ' · ' + (prettyUrl(t.url) || T('Neuer Tab')), url: t.url, favicon: t.favicon, kind: T('Offene Tabs'), run: () => activate(t.id)
    }))
    if (!q) {
      items = [...tabs.filter(t => space(S.activeSpace)).slice(0, 6), ...commands().slice(0, 10)]
    } else {
      const score = arr => arr.map(x => ({ x, s: fuzzy(q, x.title + ' ' + (x.sub || '')) })).filter(o => o.s >= 0).sort((a, b) => b.s - a.s).map(o => o.x)
      const bms = bmFlat().map(b => ({ title: b.title, sub: hostOf(b.url), url: b.url, favicon: b.favicon, kind: T('Lesezeichen'), run: () => createTab({ url: b.url }) }))
      const hist = []
      const seen = new Set()
      for (const h of S.data.history) {
        if (hist.length >= 6) break
        if (seen.has(h.url)) continue
        if ((h.title + ' ' + h.url).toLowerCase().includes(q)) { seen.add(h.url); hist.push({ title: h.title || h.url, sub: hostOf(h.url), url: h.url, kind: T('Verlauf'), run: () => createTab({ url: h.url }) }) }
      }
      items = [...score(commands()).slice(0, 6), ...score(tabs).slice(0, 5), ...score(bms).slice(0, 4), ...hist,
        { title: T('Im Web suchen: „{q}“', { q: input.value.trim() }), icon: 'search', kind: 'Web', run: () => createTab({ url: searchUrl(input.value.trim()) }) }]
    }
    sel = 0
    render()
  }
  const render = () => {
    list.innerHTML = ''
    if (!items.length) { list.innerHTML = `<div class="p-empty">${T('Keine Treffer')}</div>`; return }
    let lastKind = ''
    items.forEach((it, i) => {
      if (it.kind !== lastKind) { list.insertAdjacentHTML('beforeend', `<div class="p-sec">${esc(it.kind)}</div>`); lastKind = it.kind }
      const el = document.createElement('div')
      el.className = 'p-item' + (i === sel ? ' sel' : '')
      const ico = document.createElement('span')
      ico.className = 'p-ico'
      if (it.url) ico.append(faviconEl(it.favicon, it.url)); else ico.innerHTML = icon(it.icon || 'command')
      el.append(ico)
      el.insertAdjacentHTML('beforeend', `<div class="p-main"><div class="p-title">${esc(it.title)}</div>${it.sub ? `<div class="p-sub">${esc(it.sub)}</div>` : ''}</div>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}`)
      el.onmouseenter = () => { sel = i; $$('.p-item', list).forEach((x, j) => x.classList.toggle('sel', j === i)) }
      el.onclick = () => exec(it)
      list.append(el)
    })
    $('.p-item.sel', list)?.scrollIntoView({ block: 'nearest' })
  }
  const exec = it => { closePalette(); it.run() }
  input.oninput = build
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render() }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel] && exec(items[sel]) }
    else if (e.key === 'Escape') closePalette()
  }
  ov.onmousedown = e => { if (e.target === ov) closePalette() }
  build()
  setTimeout(() => input.focus(), 0)
}
function closePalette () { $('#palette').hidden = true }

/* ---------------------------------------------------------------------
   Peek
   --------------------------------------------------------------------- */

function openPeek (url) {
  closePeek()
  closeFloating()
  const ov = $('#peek')
  ov.hidden = false
  $('#peek-url').textContent = url
  const wv = document.createElement('webview')
  // Vorschau aus dem privaten Space bleibt privat
  wv.setAttribute('partition', curSpace()?.private ? PRIVATE_PARTITION : PARTITION)
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('src', url)
  $('#peek-body').append(wv)
  S.peek = { wv, url }
  wv.addEventListener('dom-ready', () => { if (S.peek?.wv === wv) A.send('ui:peek-wc', wv.getWebContentsId()) }, { once: true })
  trackWebview(wv)
  wv.addEventListener('did-navigate', e => { if (S.peek) { S.peek.url = e.url; $('#peek-url').textContent = e.url } })
  wv.addEventListener('ipc-message', e => { if (e.channel === 'peek') wv.loadURL(e.args[0]) })
}
function closePeek () {
  if (!S.peek) return
  S.peek.wv.remove()
  S.peek = null
  $('#peek').hidden = true
  A.send('ui:peek-wc', null)
}
function initPeek () {
  $('#peek-close').innerHTML = icon('x')
  $('#peek-close').onclick = closePeek
  $('#peek-open').onclick = () => { const url = S.peek?.url; closePeek(); if (url) createTab({ url }) }
  $('#peek-split').onclick = () => { const url = S.peek?.url; closePeek(); if (url) openInSplit(url) }
  $('#peek').addEventListener('mousedown', e => { if (e.target.id === 'peek') closePeek() })
}

/* ---------------------------------------------------------------------
   Leser-Modus (mit Vorlesefunktion)
   --------------------------------------------------------------------- */

async function toggleReader () {
  if (S.reader) return closeReader()
  const tab = activeTab()
  if (!tab?.ready || !/^https?:/.test(tab.url)) return
  let art = null
  try {
    art = await tab.webview.executeJavaScript(`(function () {
      ${A.readabilitySource()}
      try {
        var doc = document.cloneNode(true);
        var r = new Readability(doc, { charThreshold: 250 }).parse();
        return r ? { title: r.title, byline: r.byline, siteName: r.siteName, content: r.content, text: r.textContent, lang: document.documentElement.lang || '' } : null;
      } catch (e) { return null; }
    })()`)
  } catch { art = null }
  if (!art || !art.content) return toast('Leser-Modus nicht verfügbar', 'Auf dieser Seite wurde kein Artikel erkannt.', 'reader')
  const st = settings()
  S.reader = { art, tabId: tab.id, size: st.readerSize || 19, font: st.readerFont || 'serif', theme: st.readerTheme || (isDark() ? 'dark' : 'light'), speaking: false }
  renderReader()
  updateNav()
}

function renderReader () {
  const r = S.reader
  const box = $('#reader')
  box.hidden = false
  box.className = `reader r-${r.theme}`
  const words = (r.art.text || '').trim().split(/\s+/).length
  const minutes = Math.max(1, Math.round(words / 220))
  const fonts = { serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', serif", sans: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" }
  const colors = { light: ['#fbfaf7', '#1d1d22'], sepia: ['#f4ecd8', '#433422'], dark: ['#15151c', '#dcdce6'] }[r.theme]
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  const doc = `<!doctype html><html lang="${esc(r.art.lang)}"><head><meta charset="utf-8"><base target="_blank"><style>
    html{background:${colors[0]};color-scheme:${r.theme === 'dark' ? 'dark' : 'light'}}
    body{margin:0;color:${colors[1]};font:${r.size}px/1.75 ${fonts[r.font]};-webkit-font-smoothing:antialiased;overflow-x:hidden;overflow-wrap:break-word}
    main *{max-width:100%}
    table{display:block;overflow-x:auto}
    main{max-width:700px;margin:0 auto;padding:56px 32px 140px}
    .site{font:600 12px/1 'Segoe UI',sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${accent};margin-bottom:18px}
    h1{font-size:2.05em;line-height:1.18;margin:0 0 .45em;letter-spacing:-.01em}
    .meta{font:14px 'Segoe UI',sans-serif;opacity:.6;margin-bottom:2.4em;padding-bottom:1.6em;border-bottom:1px solid rgba(127,127,127,.25)}
    h2,h3{line-height:1.3;margin:1.8em 0 .6em}
    p{margin:0 0 1.15em}
    img,video,figure,picture{max-width:100%;height:auto;border-radius:10px}
    figure{margin:1.6em 0} figcaption{font-size:.8em;opacity:.65;margin-top:.5em}
    a{color:${accent};text-decoration-thickness:1px;text-underline-offset:3px}
    pre,code{font-family:'Cascadia Code',Consolas,monospace;font-size:.85em}
    pre{overflow:auto;background:rgba(127,127,127,.12);padding:14px;border-radius:10px}
    blockquote{border-left:3px solid ${accent};margin:1.4em 0;padding:.1em 1.2em;opacity:.85;font-style:italic}
    table{border-collapse:collapse;width:100%;font-size:.9em} td,th{border:1px solid rgba(127,127,127,.3);padding:6px 10px}
    ::selection{background:${accent}44}
  </style></head><body><main><div class="site">${esc(r.art.siteName || hostOf(activeTab()?.url))}</div><h1>${esc(r.art.title)}</h1><div class="meta">${r.art.byline ? esc(r.art.byline) + ' · ' : ''}${T('{n} Min. Lesezeit', { n: minutes })}</div>${r.art.content}</main></body></html>`

  box.innerHTML = `<div class="reader-bar">
      <button class="icon-btn sm" data-r="close" title="${T('Leser-Modus verlassen (Esc)')}">${icon('x')}</button>
      <span class="rb-title">${esc(r.art.title)}</span>
      <button class="icon-btn sm ${r.speaking ? 'on' : ''}" data-r="speak" title="${T('Vorlesen')}">${icon(r.speaking ? 'pause' : 'speak')}</button>
      <span class="rb-sep"></span>
      <button class="icon-btn sm" data-r="smaller" title="${T('Kleiner')}">${icon('minus')}</button>
      <button class="icon-btn sm" data-r="font" title="${T('Schriftart wechseln')}">${icon('type')}</button>
      <button class="icon-btn sm" data-r="bigger" title="${T('Größer')}">${icon('plus')}</button>
      <span class="rb-sep"></span>
      <span class="dotc" data-r="light" style="background:#fbfaf7" title="${T('Hell')}"></span>
      <span class="dotc" data-r="sepia" style="background:#f4ecd8" title="${T('Sepia')}"></span>
      <span class="dotc" data-r="dark" style="background:#15151c" title="${T('Dunkel')}"></span>
    </div>`
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-popups')
  frame.srcdoc = doc
  box.append(frame)
  box.querySelector('.reader-bar').onclick = e => {
    const a = e.target.closest('[data-r]')?.dataset.r
    if (!a) return
    const st = settings()
    if (a === 'close') return closeReader()
    if (a === 'speak') return toggleSpeak()
    if (a === 'smaller') r.size = Math.max(14, r.size - 1)
    if (a === 'bigger') r.size = Math.min(30, r.size + 1)
    if (a === 'font') r.font = r.font === 'serif' ? 'sans' : 'serif'
    if (['light', 'sepia', 'dark'].includes(a)) r.theme = a
    Object.assign(st, { readerSize: r.size, readerFont: r.font, readerTheme: r.theme })
    save('settings')
    renderReader()
  }
}

function toggleSpeak () {
  const r = S.reader
  if (!r) return
  if (r.speaking) {
    speechSynthesis.cancel()
    r.speaking = false
    return renderReader()
  }
  const text = (r.art.title + '. ' + r.art.text).replace(/\s+/g, ' ')
  const chunks = text.match(/[^.!?]{1,240}[.!?]*|.{1,240}/g) || []
  const lang = (r.art.lang || I18N.lang).slice(0, 2)
  const voice = speechSynthesis.getVoices().find(v => v.lang.startsWith(lang))
  speechSynthesis.cancel()
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c)
    if (voice) u.voice = voice
    u.lang = voice?.lang || lang
    u.rate = 1.02
    if (i === chunks.length - 1) u.onend = () => { if (S.reader === r) { r.speaking = false; renderReader() } }
    speechSynthesis.speak(u)
  })
  r.speaking = true
  renderReader()
}

function closeReader () {
  if (!S.reader) return
  speechSynthesis.cancel()
  S.reader = null
  $('#reader').hidden = true
  $('#reader').innerHTML = ''
  updateNav()
}

/* ---------------------------------------------------------------------
   Werbeblocker (Filterlisten von uBlock Origin)
   --------------------------------------------------------------------- */

function saveSettingsNow () {
  clearTimeout(saveTimers.settings)
  A.send('store:set', 'settings', settings())
}

async function openAdblockPopover () {
  const t = activeTab()
  const st = settings()
  const host = hostOf(t?.url || '')
  const global = st.adblock !== false
  const paused = adblockPaused(t?.url || '')
  const info = await A.invoke('adblock:info').catch(() => ({}))
  const updated = info.updated ? new Date(info.updated).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }) : '–'
  const p = showPopover($('#btn-adblock'), `
    <h3>${icon('shieldCheck')} ${T('Werbeblocker')}</h3>
    <div class="sub">${T('Mit den Filterlisten von uBlock Origin – blockiert Werbung (auch auf YouTube), Tracker und Schadseiten.')}</div>
    <div class="flex" style="gap:10px">
      <div class="card grow" style="margin:0;text-align:center"><div style="font:700 26px var(--font-display)">${global && !paused ? t?.blocked || 0 : '–'}</div><div class="muted" style="font-size:12px">${T('auf dieser Seite')}</div></div>
      <div class="card grow" style="margin:0;text-align:center"><div style="font:700 26px var(--font-display)">${(S.adblockTotal || 0).toLocaleString(I18N.locale)}</div><div class="muted" style="font-size:12px">${T('insgesamt')}</div></div>
    </div>
    <div class="pop-sep"></div>
    ${host ? `<div class="set-row" style="padding:0 0 10px;border:0"><div><div class="t">${esc(T('Auf {host} aktiv', { host }))}</div><div class="d">${T('Ausschalten, falls eine Seite nicht richtig funktioniert.')}</div></div><label class="switch"><input type="checkbox" id="ab-site" ${!paused ? 'checked' : ''} ${global ? '' : 'disabled'}><span></span></label></div>` : ''}
    <div class="set-row" style="padding:0 0 10px;border:0"><div><div class="t">${T('Cookie-Banner ausblenden')}</div></div><label class="switch"><input type="checkbox" id="ab-cookies" ${st.adblockCookies ? 'checked' : ''}><span></span></label></div>
    <div class="set-row" style="padding:0;border:0"><div><div class="t">${T('Werbeblocker')}</div><div class="d">${T('Listen aktualisiert: {date}', { date: esc(updated) })}</div></div><label class="switch"><input type="checkbox" id="ab-global" ${global ? 'checked' : ''}><span></span></label></div>
    <div class="flex" style="margin-top:12px"><button class="btn ghost sm" id="ab-update">${icon('refresh')} ${T('Filterlisten aktualisieren')}</button></div>`, 'adblock')
  const reloadActive = () => { const a = activeTab(); if (a?.ready) a.webview.reload() }
  const siteToggle = $('#ab-site', p)
  if (siteToggle) {
    siteToggle.onchange = e => {
      const list = new Set(st.adblockAllowlist || [])
      if (e.target.checked) list.delete(host); else list.add(host)
      st.adblockAllowlist = [...list]
      saveSettingsNow()
      updateAdblockChip()
      reloadActive()
    }
  }
  $('#ab-cookies', p).onchange = e => { st.adblockCookies = e.target.checked; saveSettingsNow(); toast('Werbeblocker', 'Listen werden neu geladen …', 'shield') }
  $('#ab-global', p).onchange = e => { st.adblock = e.target.checked; saveSettingsNow(); updateAdblockChip(); reloadActive() }
  $('#ab-update', p).onclick = async () => {
    toast('Filterlisten', 'Lade aktuelle Listen von uBlock Origin …', 'refresh')
    try { await A.invoke('adblock:update'); toast('Filterlisten aktualisiert', 'Gilt ab dem nächsten Seitenaufruf.', 'check') } catch (err) { toast('Aktualisierung fehlgeschlagen', String(err.message || err), 'warning') }
  }
}

/* ---------------------------------------------------------------------
   Website-Einstellungen: Zoom, Ton, Pop-ups und Berechtigungen pro Website
   --------------------------------------------------------------------- */

const siteCfg = url => S.data.sites?.[hostOf(url)] || {}

function setSiteCfg (url, key, value) {
  const host = hostOf(url)
  if (!host) return
  S.data.sites = S.data.sites || {}
  const cfg = { ...(S.data.sites[host] || {}) }
  if (value === undefined || value === null || value === 0) delete cfg[key]
  else cfg[key] = value
  if (Object.keys(cfg).length) S.data.sites[host] = cfg
  else delete S.data.sites[host]
  save('sites')
}

// Gespeicherten Zoom und Ton der Website anwenden (nach jedem Seitenwechsel)
function applySiteSettings (tab) {
  if (!tab.ready || !/^(https?|file):/.test(tab.url)) return
  const cfg = siteCfg(tab.url)
  const z = cfg.zoom || 0
  if (tab.zoom !== z) { tab.zoom = z; tab.webview.setZoomLevel(z) }
  const muted = tab.muted || cfg.sound === 'mute'
  if (tab.webview.isAudioMuted() !== muted) tab.webview.setAudioMuted(muted)
  tab.siteMuted = cfg.sound === 'mute'
  updateTabEl(tab)
}

const PERM_ROWS = [['media-video', 'Kamera'], ['media-audio', 'Mikrofon'], ['geolocation', 'Standort'], ['notifications', 'Benachrichtigungen']]

function openSitePopover () {
  const t = activeTab()
  if (!t || !/^https?:/.test(t.url)) return
  if (S.popover === 'site') return hidePopover()
  const u = new URL(t.url)
  const origin = u.origin
  const host = hostOf(t.url)
  const cfg = siteCfg(t.url)
  const perms = S.data.permissions[origin] || {}
  const sel = (key, value, options) => `<select class="input sm" data-k="${key}">${options.map(([v, l]) => `<option value="${v}" ${String(value ?? '') === v ? 'selected' : ''}>${T(l)}</option>`).join('')}</select>`
  const permOpts = [['', 'Fragen'], ['true', 'Zulassen'], ['false', 'Blockieren']]
  const secure = u.protocol === 'https:' && !S.certOverrides.has(u.host)
  const conn = u.protocol === 'http:' ? T('Die Verbindung ist nicht verschlüsselt. Gib hier keine Passwörter oder Zahlungsdaten ein.')
    : S.certOverrides.has(u.host) ? T('Das Zertifikat dieser Website ist ungültig und wurde von dir manuell zugelassen.')
      : T('Die Verbindung ist sicher. Deine Daten werden verschlüsselt übertragen.')
  const pct = Math.round(Math.pow(1.2, cfg.zoom || 0) * 100)
  const html = `
    <h3>${icon(secure ? 'lock' : 'warning')} ${esc(host)}</h3>
    <div class="sub">${esc(conn)}</div>
    <div class="site-grid">
      ${PERM_ROWS.map(([k, l]) => `<span>${T(l)}</span>${sel('perm:' + k, perms[k], permOpts)}`).join('')}
      <span>${T('Pop-ups und Weiterleitungen')}</span>${sel('popups', cfg.popups, [['', 'Blockieren (Standard)'], ['allow', 'Zulassen'], ['block', 'Blockieren ohne Hinweis']])}
      <span>${T('Ton')}</span>${sel('sound', cfg.sound, [['', 'Automatisch'], ['mute', 'Stumm']])}
    </div>
    ${cfg.zoom ? `<div class="flex" style="margin-top:10px"><span class="grow muted">${T('Zoom: {pct} %', { pct })}</span><button class="btn ghost sm" id="site-zoom">${T('Zurücksetzen')}</button></div>` : ''}
    <div class="pop-sep"></div>
    <div class="flex" style="gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="site-clear">${icon('trash')} ${T('Cookies und Website-Daten löschen')}</button><button class="btn ghost sm" id="site-all">${T('Alle Website-Einstellungen')}</button></div>`
  const p = showPopover($('#omni-site'), html, 'site', 340)
  p.style.left = Math.max(8, $('#omni-site').getBoundingClientRect().left - 8) + 'px'
  p.querySelectorAll('select[data-k]').forEach(s => {
    s.onchange = () => {
      const k = s.dataset.k
      if (k.startsWith('perm:')) {
        const key = k.slice(5)
        const entry = { ...(S.data.permissions[origin] || {}) }
        if (s.value === '') delete entry[key]
        else entry[key] = s.value === 'true'
        if (Object.keys(entry).length) S.data.permissions[origin] = entry
        else delete S.data.permissions[origin]
        save('permissions')
      } else {
        setSiteCfg(t.url, k, s.value || undefined)
        if (k === 'sound') applySiteSettings(t)
      }
      toast('Gespeichert', 'Gilt ab dem nächsten Laden der Seite.', 'check', { duration: 1800 })
    }
  })
  const zr = $('#site-zoom', p)
  if (zr) zr.onclick = () => { setSiteCfg(t.url, 'zoom', 0); applySiteSettings(t); hidePopover() }
  $('#site-clear', p).onclick = async () => {
    hidePopover()
    await A.invoke('site:clear-data', origin)
    toast('Website-Daten gelöscht', host, 'trash')
    if (t.ready) t.webview.reload()
  }
  $('#site-all', p).onclick = () => openSettings('privacy')
}

/* ---------------------------------------------------------------------
   Pop-up-Blocker
   --------------------------------------------------------------------- */

function updatePopupButton () {
  const t = activeTab()
  const b = $('#btn-popup')
  b.hidden = !t?.blockedPopups?.length
  b.innerHTML = icon('popup')
  b.title = T('Pop-up blockiert')
}

function openPopupPopover () {
  const t = activeTab()
  if (!t?.blockedPopups?.length) return
  if (S.popover === 'popup') return hidePopover()
  const host = hostOf(t.url)
  const html = `
    <h3>${icon('popup')} ${T('Pop-ups blockiert')}</h3>
    <div class="sub">${T('Diese Seite wollte ohne Klick neue Fenster öffnen:')}</div>
    <div class="popup-list">${t.blockedPopups.map((u, i) => `<a href="#" data-i="${i}">${esc(u)}</a>`).join('')}</div>
    <div class="flex" style="margin-top:12px;gap:8px"><button class="btn ghost sm" id="pp-allow">${esc(T('Pop-ups von {host} immer erlauben', { host }))}</button><span class="grow"></span><button class="btn sm" id="pp-done">${T('Fertig')}</button></div>`
  const p = showPopover($('#btn-popup'), html, 'popup', 360)
  p.querySelectorAll('[data-i]').forEach(a => {
    a.onclick = e => {
      e.preventDefault()
      A.send('popup:open', t.wcId, t.blockedPopups[+a.dataset.i])
      hidePopover()
    }
  })
  $('#pp-allow', p).onclick = () => {
    setSiteCfg(t.url, 'popups', 'allow')
    for (const u of t.blockedPopups) A.send('popup:open', t.wcId, u)
    t.blockedPopups = []
    updatePopupButton()
    hidePopover()
  }
  $('#pp-done', p).onclick = hidePopover
}

/* ---------------------------------------------------------------------
   Seite übersetzen (über Google Übersetzer; funktioniert für öffentlich erreichbare Seiten)
   --------------------------------------------------------------------- */

const LANGS = {
  de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', nl: 'Niederländisch', pl: 'Polnisch',
  pt: 'Portugiesisch', sv: 'Schwedisch', da: 'Dänisch', tr: 'Türkisch', uk: 'Ukrainisch', ru: 'Russisch', ja: 'Japanisch', zh: 'Chinesisch', ko: 'Koreanisch', ar: 'Arabisch'
}
const langName = code => { const c = String(code || '').slice(0, 2); return LANGS[c] ? T(LANGS[c]) : c.toUpperCase() || '?' }
const translateTarget = () => settings().translateTarget || I18N.lang

function isTranslated (url) {
  try { return new URL(url).hostname.endsWith('.translate.goog') } catch { return false }
}

// Original-Adresse einer übersetzten Seite: www-example--shop-de.translate.goog → www.example-shop.de
function originalUrl (url) {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('.translate.goog')) return url
    const host = u.hostname.slice(0, -'.translate.goog'.length).replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-')
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('_x_tr_')) u.searchParams.delete(k)
    return `https://${host}${u.pathname}${u.search}${u.hash}`
  } catch { return url }
}

function translateTab (t, tl = translateTarget()) {
  if (!t || !/^https?:/.test(t.url)) return
  const src = originalUrl(t.url)
  loadInTab(t, `https://translate.google.com/translate?sl=auto&tl=${encodeURIComponent(tl)}&hl=${I18N.lang}&u=${encodeURIComponent(src)}`)
}

function updateTranslateButton () {
  const t = activeTab()
  const b = $('#btn-translate')
  const translated = !!t && isTranslated(t.url)
  const foreign = !!t?.lang && /^https?:/.test(t.url) && t.lang.slice(0, 2) !== translateTarget().slice(0, 2)
  b.hidden = !(translated || (foreign && settings().translateOffer !== false))
  b.classList.toggle('on', translated)
  b.innerHTML = icon('translate')
  b.title = translated ? T('Übersetzt – Original anzeigen?') : T('Seite übersetzen')
}

function openTranslatePopover () {
  const t = activeTab()
  if (!t || !/^https?:/.test(t.url)) return
  if (S.popover === 'translate') return hidePopover()
  const translated = isTranslated(t.url)
  const target = translateTarget()
  const html = `
    <h3>${icon('translate')} ${T(translated ? 'Seite übersetzt' : 'Seite übersetzen')}</h3>
    <div class="sub">${translated ? T('Die Seite wird über Google Übersetzer angezeigt.') : t.lang ? esc(T('Diese Seite ist auf {lang}.', { lang: langName(t.lang) })) : T('Die Sprache der Seite ist unbekannt.')}</div>
    <div class="field"><label>${T('Übersetzen in')}</label><select class="input" id="tr-lang">${Object.keys(LANGS).map(c => `<option value="${c}" ${c === target.slice(0, 2) ? 'selected' : ''}>${langName(c)}</option>`).join('')}</select></div>
    <div class="set-row" style="padding:6px 0 0;border:0"><div><div class="t">${T('Übersetzung anbieten')}</div><div class="d">${T('Symbol in der Adressleiste bei fremdsprachigen Seiten')}</div></div><label class="switch"><input type="checkbox" id="tr-offer" ${settings().translateOffer !== false ? 'checked' : ''}><span></span></label></div>
    <div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:8px">${T('Seiten hinter einer Anmeldung lassen sich so nicht übersetzen – dafür im Kontextmenü „Mit {ai} übersetzen“ nutzen.', { ai: assistant()?.name || 'KI' })}</div>
    <div class="flex" style="margin-top:12px;gap:8px">${translated ? `<button class="btn ghost sm" id="tr-orig">${T('Original anzeigen')}</button>` : ''}<span class="grow"></span><button class="btn sm" id="tr-go">${T('Übersetzen')}</button></div>`
  const p = showPopover($('#btn-translate').hidden ? $('#omni-site') : $('#btn-translate'), html, 'translate', 340)
  $('#tr-lang', p).onchange = e => { settings().translateTarget = e.target.value; save('settings') }
  $('#tr-offer', p).onchange = e => { settings().translateOffer = e.target.checked; save('settings'); updateTranslateButton() }
  $('#tr-go', p).onclick = () => { hidePopover(); translateTab(t, $('#tr-lang', p).value) }
  const orig = $('#tr-orig', p)
  if (orig) orig.onclick = () => { hidePopover(); loadInTab(t, originalUrl(t.url)) }
}

/* ---------------------------------------------------------------------
   Geräteauswahl (WebUSB, WebHID, Web Serial, Web Bluetooth)
   --------------------------------------------------------------------- */

const DEVICE_KINDS = { usb: 'USB-Gerät', hid: 'HID-Gerät', serial: 'serielle Schnittstelle', bluetooth: 'Bluetooth-Gerät' }

function openDevicePicker ({ reqId, kind, origin, devices }) {
  S.devicePick = { reqId, devices }
  const done = id => {
    if (!S.devicePick || S.devicePick.reqId !== reqId) return
    S.devicePick = null
    A.send('ui:reply', reqId, id)
    closeModal()
  }
  const render = () => {
    const list = S.devicePick?.devices || []
    $('#dev-list').innerHTML = list.length
      ? list.map(d => `<div class="row" data-id="${esc(d.id)}"><span class="r-ico">${icon('usb')}</span><div class="r-main"><div class="r-title">${esc(d.name)}</div></div></div>`).join('')
      : `<div class="empty">${icon('usb')}<div>${kind === 'bluetooth' ? T('Suche nach Geräten …') : T('Keine passenden Geräte gefunden.')}</div></div>`
    $('#dev-list').querySelectorAll('[data-id]').forEach(r => { r.onclick = () => done(r.dataset.id) })
  }
  showModal(`
    <div class="modal-head"><h2>${esc(T('{site} möchte eine Verbindung herstellen', { site: origin || T('Eine Website') }))}</h2></div>
    <div class="modal-body"><p class="muted" style="margin-top:0">${esc(T('Wähle ein {kind}:', { kind: T(DEVICE_KINDS[kind] || 'Gerät') }))}</p><div id="dev-list"></div></div>
    <div class="modal-foot"><button class="btn ghost" id="dev-cancel">${T('Abbrechen')}</button></div>`)
  $('#dev-cancel').onclick = () => done(null)
  S.devicePick.render = render
  render()
}

/* ---------------------------------------------------------------------
   Passwörter: Speichern anbieten
   --------------------------------------------------------------------- */

function offerPassword ({ offerId, origin, username, update }) {
  let host = origin
  try { host = new URL(origin).hostname.replace(/^www\./, '') } catch {}
  let answered = false
  const reply = choice => { answered = true; A.send('pw:offer-reply', offerId, choice) }
  toast(update ? T('Passwort für {host} aktualisieren?', { host }) : T('Passwort für {host} speichern?', { host }),
    username ? T('Benutzer: {user}', { user: username }) : T('Ohne Benutzernamen'), 'key', {
      duration: 45000,
      actions: [
        { label: update ? 'Aktualisieren' : 'Speichern', run: () => { reply('save'); toast('Passwort gespeichert', host, 'key', { duration: 2000 }) } },
        ...(update ? [] : [{ label: 'Nie für diese Website', run: () => reply('never') }])
      ]
    })
  setTimeout(() => { if (!answered) A.send('pw:offer-reply', offerId, 'dismiss') }, 46000)
}

/* ---------------------------------------------------------------------
   VPN (Tor mit Länderwahl oder eigene Server)
   --------------------------------------------------------------------- */

const VPN_TYPES = { socks5: 'SOCKS5', http: 'HTTP-Proxy', https: 'HTTPS-Proxy', wireguard: 'WireGuard' } // Fachbegriffe, keine Übersetzung nötig

function updateVpnPill () {
  const v = S.vpn || { status: 'off' }
  const b = $('#btn-vpn')
  b.className = 'vpn-pill ' + ({ on: 'on', connecting: 'connecting', error: 'error' }[v.status] || '')
  const label = v.status === 'on' ? (v.country || 'VPN') : v.status === 'connecting' ? `${v.progress || 0} %` : 'VPN'
  b.innerHTML = `<span class="dotv"></span>${esc(label)}`
  b.title = v.status === 'on' ? T('VPN aktiv: {label}', { label: v.label }) + (v.ip ? ' · ' + v.ip : '') : v.status === 'connecting' ? T('VPN verbindet …') : v.status === 'error' ? T('VPN-Fehler: {error}', { error: v.error }) : T('VPN (aus)')
}

async function openVpnPopover () {
  if (!S.vpnCountries) {
    const st = await A.invoke('vpn:state')
    S.vpnCountries = st.countries
    S.vpn = { ...st }
  }
  renderVpnPopover()
}

function renderVpnPopover () {
  const v = S.vpn || { status: 'off' }
  const st = settings()
  const mode = st.vpnMode
  const on = v.status === 'on'
  const busy = v.status === 'connecting'
  const heroSub = on
    ? `${esc(v.label)}${v.ip ? ` · ${esc(v.ip)}` : ''}${v.city ? ` · ${esc(v.city)}` : ''}`
    : busy ? esc(T('Verbinde mit {label}', { label: v.label || '…' })) : v.status === 'error' ? esc(v.error || T('Fehler')) : T('Dein Verkehr läuft direkt über deine eigene IP.')
  const countries = (S.vpnCountries || []).map(([code, name]) => `
    <div class="server ${st.vpnCountry === code ? 'sel' : ''}" data-country="${code}">
      <span class="s-flag"><span class="kbd" style="font:600 10px var(--mono);color:var(--text-2)">${code === 'auto' ? '★' : code.toUpperCase()}</span></span>
      <div class="s-main"><div>${esc(name)}</div></div>
    </div>`).join('')
  const servers = st.vpnServers.map(s => `
    <div class="server ${st.vpnServerId === s.id ? 'sel' : ''}" data-server="${esc(s.id)}">
      <span class="s-flag">${icon(s.type === 'wireguard' ? 'vpn' : 'globe')}</span>
      <div class="s-main"><div>${esc(s.name)}</div><div>${VPN_TYPES[s.type]}${s.host ? ' · ' + esc(s.host) : ''}</div></div>
      <button class="icon-btn sm" data-del="${esc(s.id)}" title="${T('Entfernen')}">${icon('trash')}</button>
    </div>`).join('')
  const html = `
    <h3>${icon('vpn')} VPN</h3>
    <div class="sub">${T('Leitet den gesamten Tab-Verkehr (inkl. DNS) durch einen verschlüsselten Tunnel und verbirgt deine IP-Adresse.')}</div>
    <div class="vpn-hero ${on ? 'on' : ''}">
      <div class="globe">${icon(on ? 'vpn' : 'globe')}</div>
      <div class="grow" style="min-width:0">
        <div class="v-title">${T(on ? 'Geschützt' : busy ? 'Verbinde …' : v.status === 'error' ? 'Nicht verbunden' : 'Ungeschützt')}</div>
        <div class="v-sub">${heroSub}</div>
        ${busy ? `<div class="vpn-progress"><i style="width:${v.progress || 5}%"></i></div>` : ''}
      </div>
    </div>
    <div class="flex" style="margin-bottom:12px">
      <button class="btn grow" id="vpn-toggle" style="justify-content:center">${on || busy ? T('Trennen') : T('Verbinden')}</button>
      ${on && v.mode === 'tor' ? `<button class="btn ghost" id="vpn-newnym" title="${T('Neue Route und neue IP')}">${icon('refresh')}</button>` : ''}
    </div>
    <div class="seg" id="vpn-mode" style="width:100%;margin-bottom:8px">
      <button data-mode="tor" class="${mode === 'tor' ? 'on' : ''}" style="flex:1">${T('Tor · kostenlos')}</button>
      <button data-mode="server" class="${mode === 'server' ? 'on' : ''}" style="flex:1">${T('Eigene Server')}</button>
    </div>
    ${mode === 'tor'
      ? `<div class="server-list">${countries}</div>
         <div class="muted" style="font-size:11.5px;line-height:1.5">${T('Tor ist kostenlos und braucht kein Konto, ist aber langsamer; manche Seiten zeigen Captchas. Für echte Anonymität eignet sich weiterhin der Tor Browser.')}</div>`
      : `<div class="server-list">${servers || `<div class="muted" style="font-size:12px;padding:8px 2px">${T('Noch keine Server. Füge WireGuard-Konfigurationen (z. B. kostenlos von Proton VPN) oder SOCKS5-/HTTP-Zugänge deines Anbieters hinzu.')}</div>`}</div>
         <div class="flex"><button class="btn ghost sm" id="vpn-import">${icon('folder')} ${T('WireGuard importieren')}</button><button class="btn ghost sm" id="vpn-add">${icon('plus')} ${T('Server hinzufügen')}</button></div>`}`
  const p = S.popover === 'vpn' ? $('#popover') : null
  const pop = p || showPopover($('#btn-vpn'), html, 'vpn', 360)
  if (p) p.innerHTML = html
  pop.onclick = async e => {
    if (e.target.closest('#vpn-toggle')) {
      if (on || busy) await A.invoke('vpn:disconnect')
      else {
        if (mode === 'server' && !st.vpnServers.length) return toast('Kein Server', 'Füge zuerst einen Server hinzu.', 'vpn')
        A.invoke('vpn:connect')
      }
      return
    }
    if (e.target.closest('#vpn-newnym')) { await A.invoke('vpn:new-identity'); return toast('Neue Tor-Identität', 'Neue Route wird aufgebaut.', 'refresh') }
    const m = e.target.closest('[data-mode]')
    if (m) { st.vpnMode = m.dataset.mode; saveSettingsNow(); return renderVpnPopover() }
    const c = e.target.closest('[data-country]')
    if (c) { st.vpnCountry = c.dataset.country; await A.invoke('vpn:set-country', c.dataset.country); return renderVpnPopover() }
    const del = e.target.closest('[data-del]')
    if (del) {
      st.vpnServers = st.vpnServers.filter(s => s.id !== del.dataset.del)
      if (st.vpnServerId === del.dataset.del) st.vpnServerId = st.vpnServers[0]?.id || null
      saveSettingsNow(); return renderVpnPopover()
    }
    const sv = e.target.closest('[data-server]')
    if (sv) {
      st.vpnServerId = sv.dataset.server; saveSettingsNow(); renderVpnPopover()
      if (S.vpn?.status === 'on' && S.vpn.mode === 'server') A.invoke('vpn:connect')
      return
    }
    if (e.target.closest('#vpn-import')) {
      const list = await A.invoke('vpn:import-wireguard')
      for (const { name, config } of list) {
        const host = (/^\s*Endpoint\s*=\s*([^:\s]+)/mi.exec(config) || [])[1] || ''
        st.vpnServers.push({ id: 'srv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, type: 'wireguard', host, config })
      }
      if (list.length) {
        if (!st.vpnServerId) st.vpnServerId = st.vpnServers[0].id
        saveSettingsNow(); renderVpnPopover()
        toast('WireGuard importiert', T('{n} Server hinzugefügt.', { n: list.length }), 'vpn')
      }
      return
    }
    if (e.target.closest('#vpn-add')) { hidePopover(); addServerDialog() }
  }
}

function addServerDialog () {
  showModal(`
    <div class="modal-head"><h2>${T('VPN-Server hinzufügen')}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0;line-height:1.5">${T('Die Zugangsdaten findest du im Kundenbereich deines VPN-Anbieters (oft unter „Manuelle Einrichtung“, „SOCKS5“ oder „WireGuard“). Sie werden nur lokal auf diesem PC gespeichert.')}</p>
      <div class="field"><label>${T('Name')}</label><input class="input" id="sv-name" placeholder="${T('z. B. Mullvad Frankfurt')}"></div>
      <div class="field"><label>${T('Typ')}</label><select class="input" id="sv-type">${Object.entries(VPN_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div id="sv-proxy">
        <div class="flex" style="align-items:flex-start"><div class="field grow"><label>${T('Adresse')}</label><input class="input" id="sv-host" placeholder="${T('de-fra.anbieter.net')}"></div><div class="field" style="width:110px"><label>Port</label><input class="input" id="sv-port" placeholder="1080"></div></div>
        <div class="flex" style="align-items:flex-start"><div class="field grow"><label>${T('Benutzer (optional)')}</label><input class="input" id="sv-user"></div><div class="field grow"><label>${T('Passwort (optional)')}</label><input class="input" id="sv-pass" type="password"></div></div>
      </div>
      <div id="sv-wg" hidden><div class="field"><label>${T('WireGuard-Konfiguration')}</label><textarea class="input" id="sv-conf" rows="9" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = …&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = …"></textarea></div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>${T('Abbrechen')}</button><button class="btn" id="sv-save">${T('Speichern')}</button></div>`)
  const type = $('#sv-type')
  type.onchange = () => { $('#sv-wg').hidden = type.value !== 'wireguard'; $('#sv-proxy').hidden = type.value === 'wireguard' }
  $('#sv-save').onclick = () => {
    const st = settings()
    const t = type.value
    const server = { id: 'srv-' + Date.now().toString(36), name: $('#sv-name').value.trim() || VPN_TYPES[t], type: t }
    if (t === 'wireguard') {
      server.config = $('#sv-conf').value
      server.host = (/^\s*Endpoint\s*=\s*([^:\s]+)/mi.exec(server.config) || [])[1] || ''
      if (!/\[Interface\]/i.test(server.config)) return toast('Ungültig', 'Die WireGuard-Konfiguration braucht einen [Interface]-Abschnitt.', 'warning')
    } else {
      Object.assign(server, { host: $('#sv-host').value.trim(), port: +$('#sv-port').value, user: $('#sv-user').value, pass: $('#sv-pass').value })
      if (!server.host || !server.port) return toast('Unvollständig', 'Adresse und Port werden benötigt.', 'warning')
    }
    st.vpnServers.push(server)
    st.vpnServerId = server.id
    st.vpnMode = 'server'
    saveSettingsNow()
    closeModal()
    toast('Server gespeichert', server.name, 'vpn')
  }
}

/* ---------------------------------------------------------------------
   Claude: Seitenleiste, Seiten übergeben, Claude in Chrome
   --------------------------------------------------------------------- */

const CLAUDE_EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const DOCK = { open: false, mode: 'claude', claude: null, panels: new Map() }

// Wählbare KI-Assistenten für Seitenleiste, Kontextmenü und Seitenübergabe
const ASSISTANTS = {
  claude: { name: 'Claude', url: 'https://claude.ai/new', editor: 'div.ProseMirror[contenteditable="true"]', color: '#e0845f' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', editor: '#prompt-textarea, #mobile-composer-prompt', color: '#10a37f' }
}
const assistant = () => ASSISTANTS[settings().assistant] || null
const dockEnabled = () => !!assistant() && !!settings().claudeSidebar

function applyAssistant () {
  const a = assistant()
  document.documentElement.style.setProperty('--claude', a?.color || '#e0845f')
  $('#btn-claude').innerHTML = `${icon('chat')}<span>${esc(a?.name || T('KI'))}</span>`
  $('#btn-claude').title = T('{ai}-Seitenleiste (Strg+E)', { ai: a?.name || T('KI') })
  $('#dock-send').title = T('Aktuelle Seite an {ai} übergeben', { ai: a?.name || T('die KI') })
  $('#btn-claude').hidden = !dockEnabled()
  // Assistent gewechselt: alte Seitenleisten-Webview verwerfen
  if (DOCK.claude && DOCK.claudeFor !== settings().assistant) {
    DOCK.claude.remove()
    DOCK.claude = null
    DOCK.claudeReady = false
  }
}

function applyDockWidth () {
  document.documentElement.style.setProperty('--dock-w', (settings().claudeDockWidth || 420) + 'px')
}

function trackWebview (wv) {
  wv.addEventListener('dom-ready', () => { try { A.send('ui:webview', wv.getWebContentsId()) } catch {} }, { once: true })
}

function ensureClaudeWebview () {
  if (DOCK.claude) return DOCK.claude
  const wv = document.createElement('webview')
  wv.setAttribute('partition', PARTITION)
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('src', assistant().url)
  wv.dataset.dock = 'claude'
  trackWebview(wv)
  wv.addEventListener('dom-ready', () => { if (DOCK.claude === wv) DOCK.claudeReady = true }, { once: true })
  $('#dock-body').append(wv)
  DOCK.claude = wv
  DOCK.claudeFor = settings().assistant
  return wv
}

function currentPanel () {
  const t = activeTab()
  if (!t) return null
  return [...DOCK.panels.values()].find(p => p.tabId === t.wcId) || null
}

function renderDock () {
  const dock = $('#claude-dock')
  dock.hidden = !DOCK.open
  $('#btn-claude').classList.toggle('on', DOCK.open)
  if (!DOCK.open) return
  const panel = currentPanel()
  if (DOCK.mode !== 'claude' && !panel) DOCK.mode = dockEnabled() ? 'claude' : null
  if (DOCK.mode === 'claude' && !dockEnabled()) DOCK.mode = panel ? panel.key : null
  if (!DOCK.mode) { DOCK.open = false; return renderDock() }
  if (DOCK.mode === 'claude') ensureClaudeWebview()
  const tabs = []
  if (dockEnabled()) tabs.push(`<button data-dock="claude" class="${DOCK.mode === 'claude' ? 'on' : ''}">${icon('chat')} ${esc(assistant().name)}</button>`)
  if (panel) tabs.push(`<button data-dock="${esc(panel.key)}" class="${DOCK.mode === panel.key ? 'on' : ''}">${icon('agent')} ${esc(panel.name)}</button>`)
  $('#dock-tabs').innerHTML = tabs.join('')
  $('#dock-tabs').hidden = tabs.length < 2 && !panel
  for (const wv of $$('#dock-body webview')) wv.classList.remove('visible')
  if (DOCK.mode === 'claude') DOCK.claude.classList.add('visible')
  else panel?.wv.classList.add('visible')
  $('#dock-send').hidden = DOCK.mode !== 'claude'
  $('#dock-new').hidden = DOCK.mode !== 'claude'
}

function toggleDock (force) {
  const open = force ?? !DOCK.open
  if (open && !dockEnabled() && !currentPanel()) {
    return toast(assistant() ? T('{ai}-Seitenleiste ist aus', { ai: assistant().name }) : 'Kein KI-Assistent gewählt',
      'Du kannst das unter Einstellungen › KI-Assistent ändern.', 'chat', {
        actions: [{ label: 'Einstellungen', run: () => openSettings('claude') }]
      })
  }
  DOCK.open = open
  if (open && !DOCK.mode) DOCK.mode = 'claude'
  renderDock()
}

function openExtPanel ({ extId, tabId, url, name }) {
  const key = `${extId}:${tabId}`
  let panel = DOCK.panels.get(key)
  if (!panel) {
    const wv = document.createElement('webview')
    wv.setAttribute('partition', PARTITION)
    wv.setAttribute('allowpopups', '')
    wv.setAttribute('src', url)
    trackWebview(wv)
    wv.addEventListener('close', () => closeExtPanel(extId, tabId, true))
    $('#dock-body').append(wv)
    panel = { key, extId, tabId, url, wv, name: extId === CLAUDE_EXT ? 'Claude in Chrome' : (name || T('Erweiterung')) }
    DOCK.panels.set(key, panel)
  }
  const t = activeTab()
  if (t && t.wcId !== tabId) {
    const target = tabByWc(tabId)
    if (target) activate(target.id)
  }
  DOCK.open = true
  DOCK.mode = key
  renderDock()
}

function closeExtPanel (extId, tabId, notify) {
  const key = `${extId}:${tabId}`
  const panel = DOCK.panels.get(key)
  if (!panel) return
  panel.wv.remove()
  DOCK.panels.delete(key)
  if (notify) A.send('crx:sidepanel-closed', extId, tabId)
  if (DOCK.mode === key) DOCK.mode = dockEnabled() ? 'claude' : null
  renderDock()
}

function initDock () {
  applyDockWidth()
  $('#btn-claude').onclick = () => toggleDock()
  $('#dock-send').innerHTML = icon('send')
  $('#dock-send').onclick = () => sendPageToClaude('context')
  $('#dock-new').innerHTML = icon('plus')
  $('#dock-new').onclick = () => { ensureClaudeWebview().loadURL(assistant().url).catch(() => {}) }
  $('#dock-close').innerHTML = icon('x')
  $('#dock-close').onclick = () => toggleDock(false)
  $('#dock-tabs').onclick = e => {
    const b = e.target.closest('[data-dock]')
    if (b) { DOCK.mode = b.dataset.dock; renderDock() }
  }
  $('#dock-resize').addEventListener('mousedown', e => {
    e.preventDefault()
    const shield = document.createElement('div')
    shield.style.cssText = 'position:fixed;inset:0;z-index:999;cursor:col-resize'
    document.body.append(shield)
    const right = $('#claude-dock').getBoundingClientRect().right
    const move = ev => {
      const w = Math.round(Math.min(760, Math.max(320, right - ev.clientX)))
      settings().claudeDockWidth = w
      applyDockWidth()
    }
    const up = () => { shield.remove(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); save('settings') }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  applyAssistant()
}

// Liest die aktuelle Seite als sauberes Markdown (Readability + Turndown)
async function pageAsMarkdown (tab = activeTab()) {
  if (!tab?.ready || !/^https?:|^file:/.test(tab.url)) return null
  try {
    return await tab.webview.executeJavaScript(`(function () {
      ${A.readabilitySource()}
      ${A.turndownSource()}
      var html = null, title = document.title;
      try {
        var art = new Readability(document.cloneNode(true), { charThreshold: 250 }).parse();
        if (art && art.content) { html = art.content; title = art.title || title; }
      } catch (e) {}
      var md;
      try {
        var td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
        td.remove(['script', 'style', 'noscript', 'iframe']);
        md = td.turndown(html || document.body.innerHTML);
      } catch (e) { md = (document.body && document.body.innerText) || ''; }
      return { title: title, url: location.href, markdown: md.replace(/\\n{3,}/g, '\\n\\n').trim() };
    })()`)
  } catch { return null }
}

async function copyPageAsMarkdown () {
  const page = await pageAsMarkdown()
  if (!page) return toast('Nicht möglich', 'Diese Seite lässt sich nicht als Markdown lesen.', 'markdown')
  A.send('clipboard:write', `# ${page.title}\n\n${T('Quelle')}: ${page.url}\n\n${page.markdown}`)
  toast('Als Markdown kopiert', T('{n} Zeichen – bereit zum Einfügen in einen KI-Chat.', { n: page.markdown.length.toLocaleString(I18N.locale) }), 'markdown')
}

async function insertIntoClaude (text) {
  const a = assistant()
  if (!dockEnabled()) {
    A.send('clipboard:write', text)
    return toast('In Zwischenablage kopiert', a ? T('Die {ai}-Seitenleiste ist ausgeschaltet.', { ai: a.name }) : 'Es ist kein KI-Assistent gewählt.', 'chat')
  }
  DOCK.mode = 'claude'
  toggleDock(true)
  const wv = ensureClaudeWebview()
  if (!DOCK.claudeReady) await new Promise(r => wv.addEventListener('dom-ready', r, { once: true }))
  let ok = false
  try {
    ok = await wv.executeJavaScript(`(async function (text) {
      const find = () => document.querySelector(${JSON.stringify(a.editor)}) || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
      let ed = null;
      for (let i = 0; i < 60 && !(ed = find()); i++) await new Promise(r => setTimeout(r, 250));
      if (!ed) return false;
      const read = () => (ed.tagName === 'TEXTAREA' ? ed.value : ed.innerText) || '';
      const before = read().length;
      ed.focus();
      document.execCommand('insertText', false, text);
      if (read().length <= before) {
        if (ed.tagName === 'TEXTAREA') {
          // React-Textfeld: Wert über den nativen Setter setzen, damit React die Änderung bemerkt
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ed, ed.value + text);
          ed.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Editor (ProseMirror) als Einfügen aus der Zwischenablage füttern
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return read().length > before;
    })(${JSON.stringify(text)})`)
  } catch {}
  wv.focus()
  if (ok) toast(T('An {ai} übergeben', { ai: a.name }), 'Mit Enter absenden oder vorher ergänzen.', 'chat')
  else {
    A.send('clipboard:write', text)
    toast('In Zwischenablage kopiert', T('Das Eingabefeld von {ai} war nicht erreichbar (z. B. Anmeldung oder Hinweisfenster offen) – einfach mit Strg+V einfügen.', { ai: a.name }), 'chat', { duration: 7000 })
  }
}

async function sendPageToClaude (prompt = 'context') {
  const page = await pageAsMarkdown()
  if (!page) return toast('Nicht möglich', 'Öffne zuerst eine Website.', 'chat')
  const content = page.markdown.length > 60000 ? page.markdown.slice(0, 60000) + '\n\n' + T('[… gekürzt]') : page.markdown
  const intro = prompt === 'summarize'
    ? T('Fasse die folgende Webseite prägnant auf Deutsch zusammen (Kernaussagen als Stichpunkte):')
    : T('Hier ist der Inhalt einer Webseite, zu der ich Fragen habe:')
  insertIntoClaude(`${intro}\n\n# ${page.title}\n${T('Quelle')}: ${page.url}\n\n${content}\n\n`)
}

function sendSelectionToClaude (text, prompt) {
  const t = activeTab()
  const src = t ? T('„{title}“ ({url})', { title: t.title, url: t.url }) : T('einer Webseite')
  const intro = T(prompt === 'explain'
    ? 'Erkläre mir diesen Ausschnitt aus {src} verständlich:'
    : prompt === 'translate'
      ? 'Übersetze diesen Ausschnitt aus {src} ins Deutsche (falls er schon deutsch ist, ins Englische):'
      : 'Zu diesem Ausschnitt aus {src}:', { src })
  insertIntoClaude(`${intro}\n\n> ${text.replace(/\n/g, '\n> ')}\n\n`)
}

/* ---------------------------------------------------------------------
   Einstellungsseite „Claude“ – Status abrufen
   --------------------------------------------------------------------- */

async function claudeStatus () {
  try { return await A.invoke('claude:status') } catch { return {} }
}

/* ---------------------------------------------------------------------
   Fokus-Modus
   --------------------------------------------------------------------- */

function openFocusPopover () {
  if (S.focus.active) {
    const rem = Math.max(0, S.focus.endsAt - Date.now())
    const p = showPopover($('#btn-focus'), `
      <h3>${icon('focus')} ${T('Fokus läuft')}</h3>
      <div class="sub">${T('Noch {time} – ablenkende Seiten sind gesperrt.', { time: fmtTime(rem / 1000) })}</div>
      <button class="btn block ghost" id="focus-stop">${T('Session beenden')}</button>`, 'focus')
    $('#focus-stop', p).onclick = () => { hidePopover(); endFocus(false) }
    return
  }
  let minutes = settings().focusMinutes || 25
  const list = settings().focusBlocklist
  const p = showPopover($('#btn-focus'), `
    <h3>${icon('focus')} ${T('Fokus-Modus')}</h3>
    <div class="sub">${T('Ein Timer, eine ruhige Oberfläche und gesperrte Ablenkungen. Wenn die Zeit um ist, gibt Caravel alles wieder frei.')}</div>
    <div class="seg" id="focus-min" style="width:100%;justify-content:space-between">${[15, 25, 45, 60, 90].map(m => `<button data-m="${m}" class="${m === minutes ? 'on' : ''}">${T('{n} Min.', { n: m })}</button>`).join('')}</div>
    <div class="muted" style="font-size:12px;margin:12px 0 4px">${T('Gesperrt während der Session:')}</div>
    <div style="font-size:12px;line-height:1.6;color:var(--text-2)">${list.map(esc).join(' · ') || '—'}</div>
    <div class="pop-sep"></div>
    <div class="flex"><button class="btn ghost sm" id="focus-edit">${T('Liste bearbeiten')}</button><span class="grow"></span><button class="btn" id="focus-start">${icon('play')} ${T('Starten')}</button></div>`, 'focus')
  $('#focus-min', p).onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b) return
    minutes = +b.dataset.m
    $$('#focus-min button', p).forEach(x => x.classList.toggle('on', x === b))
  }
  $('#focus-edit', p).onclick = () => { hidePopover(); openSettings('focus') }
  $('#focus-start', p).onclick = () => { hidePopover(); settings().focusMinutes = minutes; save('settings'); startFocus(minutes) }
}

function startFocus (minutes) {
  S.focus = { active: true, total: minutes * 60000, endsAt: Date.now() + minutes * 60000, timer: null }
  A.send('focus:set', true, settings().focusBlocklist)
  document.body.classList.add('focus-mode')
  S.focus.timer = setInterval(tickFocus, 1000)
  tickFocus()
  toast('Fokus-Modus gestartet', T('{n} Minuten konzentriertes Arbeiten. Du schaffst das!', { n: minutes }), 'focus')
  const t = activeTab()
  if (t?.ready && settings().focusBlocklist.some(d => hostOf(t.url) === d || hostOf(t.url).endsWith('.' + d))) t.webview.reload()
}

function tickFocus () {
  const hud = $('#focus-hud')
  const rem = S.focus.endsAt - Date.now()
  if (rem <= 0) return endFocus(true)
  const C = 2 * Math.PI * 9
  const frac = rem / S.focus.total
  hud.hidden = false
  hud.innerHTML = `<svg viewBox="0 0 22 22"><circle class="track" cx="11" cy="11" r="9"/><circle class="bar" cx="11" cy="11" r="9" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg><span>${fmtTime(rem / 1000)}</span>`
}

function endFocus (completed) {
  clearInterval(S.focus.timer)
  const minutes = Math.round((S.focus.total - Math.max(0, S.focus.endsAt - Date.now())) / 60000)
  S.focus = { active: false, endsAt: 0, total: 0, timer: null }
  A.send('focus:set', false, [])
  document.body.classList.remove('focus-mode')
  $('#focus-hud').hidden = true
  const fs = S.data.focusStats
  fs.minutes += minutes
  if (completed) fs.sessions++
  save('focusStats')
  for (const t of S.tabs.values()) {
    if (t.url.startsWith('caravel://blocked')) loadInTab(t, displayUrl(t.url))
  }
  if (completed) {
    toast('Fokus-Session geschafft! 🎉', T('{n} Minuten fokussiert · {s} Sessions insgesamt', { n: minutes, s: fs.sessions }), 'sparkles', { duration: 7000 })
    new Notification(T('Caravel – Fokus-Session beendet'), { body: T('Stark! {n} Minuten fokussiert. Zeit für eine Pause.', { n: minutes }), silent: false })
  } else {
    toast('Fokus-Modus beendet', T('{n} Minuten fokussiert.', { n: minutes }), 'focus')
  }
}

/* ---------------------------------------------------------------------
   Chromecast
   --------------------------------------------------------------------- */

// Dialog wie in Chrome: alle Geräte mit ihrem Status, Klick auf ein Gerät startet die gewählte Quelle,
// Klick auf ein aktives Gerät beendet die Übertragung. Quellen: App der Website (Cast SDK), Tab, Bildschirm,
// das Video der Seite direkt oder eine lokale Datei.
const CAST_SOURCES = {
  app: { icon: 'cast', label: c => T('App von {host}', { host: c.page?.host || T('dieser Website') }) },
  tab: { icon: 'tab', label: () => T('Tab streamen') },
  screen: { icon: 'monitor', label: () => T('Bildschirm streamen') },
  media: { icon: 'play', label: () => T('Nur das Video dieser Seite') },
  file: { icon: 'folder', label: () => T('Datei streamen') }
}

const castHost = origin => { try { return new URL(origin).hostname.replace(/^www\./, '') } catch { return '' } }

async function openCast (opts = {}) {
  if (typeof opts === 'string') opts = { preset: opts }
  const c = S.cast
  // Eine noch offene Anfrage einer Webseite gilt als abgebrochen
  if (c.request && c.request !== opts.request) A.send('ui:reply', c.request.reqId, null)
  c.request = opts.request || null
  c.preset = opts.preset || null
  c.menu = false
  c.avail = null
  c.scanning = !c.devices.length
  A.send('cast:scan')
  clearTimeout(c.scanTimer)
  c.scanTimer = setTimeout(() => { c.scanning = false; if (S.popover === 'cast') renderCast() }, 9000)
  const t = activeTab()
  c.page = null
  if (c.request) {
    c.page = { appIds: c.request.appIds, host: castHost(c.request.origin) }
  } else if (t?.wcId) {
    const app = await A.invoke('cast:page-app', t.wcId).catch(() => null)
    if (app) c.page = { ...app, host: castHost(app.origin) }
  }
  c.media = c.preset ? { url: c.preset, title: T('Ausgewähltes Medium') } : c.request ? null : await detectMedia()
  c.source = c.page ? 'app' : c.preset ? 'media' : 'tab'
  renderCast()
  if (c.page) {
    A.invoke('cast:availability', c.page.appIds).then(av => { c.avail = av; if (S.popover === 'cast') renderCast() })
  }
  clearInterval(c.ticker)
  c.ticker = setInterval(() => {
    if (S.popover !== 'cast') return clearInterval(c.ticker)
    tickCastControls()
  }, 1000)
}

// Wird beim Schließen des Popovers aufgerufen (siehe hidePopover)
function castDialogClosed () {
  const c = S.cast
  if (c.request) { A.send('ui:reply', c.request.reqId, null); c.request = null }
  clearInterval(c.ticker)
  A.send('cast:idle')
}

async function detectMedia () {
  const t = activeTab()
  if (!t?.ready) return null
  try {
    const info = await t.webview.executeJavaScript(`(() => {
      const list = [...document.querySelectorAll('video, audio')];
      const v = list.sort((a, b) => (b.videoWidth || 0) * (b.videoHeight || 0) - (a.videoWidth || 0) * (a.videoHeight || 0))[0];
      if (!v) return null;
      return { src: v.currentSrc || v.src, time: v.currentTime || 0, poster: v.poster || '', title: document.title };
    })()`)
    if (info && /^https?:/.test(info.src)) return { url: info.src, title: info.title, startTime: info.time, poster: info.poster }
  } catch {}
  return null
}

function castSessionLabel (s) {
  if (s.kind === 'tab') return T('Tab wird gestreamt · {title}', { title: s.title || '' })
  if (s.kind === 'screen') return T('Bildschirm wird gestreamt')
  if (s.kind === 'app') return s.appName || s.title || 'App'
  return (s.state === 'PAUSED' ? T('Pausiert') + ' · ' : '') + (s.title || T('Medium'))
}

function castTime (s) {
  return (s.time || 0) + (s.state === 'PLAYING' && s.at ? (Date.now() - s.at) / 1000 : 0)
}

function castControls (s) {
  const playable = (s.kind === 'media' || s.kind === 'file' || s.kind === 'app') && s.state && s.duration
  const vol = Math.round((s.volume?.level ?? 1) * 100)
  const t = castTime(s)
  return `<div class="cast-ctl" data-dev="${esc(s.deviceId)}">
    ${playable ? `<div class="flex">
      <button class="icon-btn sm" data-c="toggle" title="${s.state === 'PAUSED' ? T('Fortsetzen') : T('Pause')}">${icon(s.state === 'PAUSED' ? 'play' : 'pause')}</button>
      <input type="range" class="grow" data-c="seek" min="0" max="${Math.round(s.duration)}" value="${Math.round(t)}">
      <span class="muted ct-time">${fmtTime(t)} / ${fmtTime(s.duration)}</span>
    </div>` : ''}
    <div class="flex">
      <button class="icon-btn sm" data-c="mute" title="${s.volume?.muted ? T('Ton an') : T('Stumm')}">${icon(s.volume?.muted ? 'mute' : 'volume')}</button>
      <input type="range" class="grow" data-c="vol" min="0" max="100" value="${vol}" title="${T('Lautstärke am Gerät')}">
    </div>
  </div>`
}

function tickCastControls () {
  for (const el of document.querySelectorAll('#popover .cast-ctl')) {
    const s = S.cast.sessions.find(x => x.deviceId === el.dataset.dev)
    if (!s || s.state !== 'PLAYING') continue
    const seek = el.querySelector('[data-c="seek"]')
    if (seek && !seek.matches(':active')) seek.value = Math.round(castTime(s))
    const label = el.querySelector('.ct-time')
    if (label) label.textContent = `${fmtTime(castTime(s))} / ${fmtTime(s.duration)}`
  }
}

function castSourceText (c) {
  const t = activeTab()
  switch (c.source) {
    case 'app': return c.request ? T('{host} möchte auf ein Gerät streamen', { host: c.page.host }) : T('App von {host} auf dem Gerät öffnen', { host: c.page?.host })
    case 'tab': return T('Tab: {title}', { title: t?.title || T('Aktueller Tab') })
    case 'screen': return T('Gesamter Bildschirm mit Ton')
    case 'media': return c.media?.title || T('Video dieser Seite')
    case 'file': return c.file ? c.file.split(/[\\/]/).pop() : T('Datei auswählen …')
  }
  return ''
}

function renderCast () {
  const c = S.cast
  const sessions = new Map(c.sessions.map(s => [s.deviceId, s]))
  const sources = c.request ? [] : Object.keys(CAST_SOURCES).filter(k => (k !== 'app' || c.page) && (k !== 'media' || c.media?.url))
  const mirrorSrc = c.source === 'tab' || c.source === 'screen'

  const row = d => {
    const s = sessions.get(d.id)
    const ico = d.kind === 'tv' ? 'tv' : d.kind === 'group' ? 'speakers' : 'speaker'
    let status = d.app || d.model
    let disabled = false
    if (s) status = castSessionLabel(s)
    else if (c.source === 'app' && c.avail && c.avail[d.id] === false) { status = T('Diese App wird hier nicht unterstützt'); disabled = true }
    else if (mirrorSrc && d.kind !== 'tv') status = T('Nur Ton · {status}', { status })
    return `<div class="device${s ? ' active' : ''}${disabled ? ' disabled' : ''}" data-d="${esc(d.id)}" title="${s && !c.request ? T('Klicken zum Beenden') : ''}">
        <div class="d-ico">${icon(ico)}</div>
        <div class="d-main"><div class="d-name">${esc(d.name)}</div><div class="d-host">${esc(status)}</div></div>
        ${s ? `<button class="btn sm ghost d-stop" data-stop="${esc(d.id)}">${T('Beenden')}</button>` : ''}
      </div>${s ? castControls(s) : ''}`
  }

  const html = `
    <div class="cast-head">
      <h3>${icon('cast')} ${T('Streamen')}</h3>
      ${sources.length > 1 ? `<button class="btn ghost sm" id="cast-src">${T('Quellen')} ${icon('chevronDown')}</button>` : ''}
    </div>
    <div class="cast-source">${icon(CAST_SOURCES[c.source].icon)}<span>${esc(castSourceText(c))}</span></div>
    ${c.menu ? `<div class="cast-menu">${sources.map(k => `
      <div class="cast-opt${k === c.source ? ' sel' : ''}" data-src="${k}">${icon(CAST_SOURCES[k].icon)}<span>${esc(CAST_SOURCES[k].label(c))}</span>${k === c.source ? icon('check') : ''}</div>`).join('')}
    </div>` : ''}
    <div class="cast-devs">${c.devices.map(row).join('')}</div>
    ${c.scanning || !c.devices.length
      ? `<div class="scan">${c.scanning ? `<span class="pulse"></span> ${T('Suche nach Geräten …')}` : `${icon('info')} ${T('Keine Geräte gefunden. PC und Chromecast müssen im selben WLAN sein.')}`}</div>`
      : ''}`

  const p = S.popover === 'cast' ? $('#popover') : null
  const pop = p || showPopover($('#btn-cast'), html, 'cast', 380)
  if (p) p.innerHTML = html

  pop.onclick = async e => {
    if (e.target.closest('#cast-src')) { c.menu = !c.menu; return renderCast() }
    const opt = e.target.closest('[data-src]')
    if (opt) {
      c.menu = false
      c.source = opt.dataset.src
      if (c.source === 'file') {
        const file = await A.invoke('cast:pick-file')
        if (file) c.file = file
        else if (!c.file) c.source = 'tab'
      }
      if (c.source === 'app' && c.page && !c.avail) A.invoke('cast:availability', c.page.appIds).then(av => { c.avail = av; if (S.popover === 'cast') renderCast() })
      return renderCast()
    }
    const stop = e.target.closest('[data-stop]')
    if (stop) return castStop(stop.dataset.stop)
    const ctl = e.target.closest('[data-c]')
    const box = e.target.closest('.cast-ctl')
    if (box) {
      const id = box.dataset.dev
      const s = c.sessions.find(x => x.deviceId === id)
      if (ctl?.dataset.c === 'toggle') A.send('cast:control', id, s?.state === 'PAUSED' ? 'resume' : 'pause')
      if (ctl?.dataset.c === 'mute') A.send('cast:control', id, 'mute', !s?.volume?.muted)
      return
    }
    const d = e.target.closest('[data-d]')
    if (!d || d.classList.contains('disabled')) return
    if (sessions.has(d.dataset.d) && !c.request) return castStop(d.dataset.d)
    castStart(d.dataset.d)
  }
  for (const input of pop.querySelectorAll('.cast-ctl input[type="range"]')) {
    const id = input.closest('.cast-ctl').dataset.dev
    input.onchange = () => {
      if (input.dataset.c === 'seek') A.send('cast:control', id, 'seekTo', +input.value)
      if (input.dataset.c === 'vol') A.send('cast:control', id, 'volume', input.value / 100)
    }
  }
}

// Neu zeichnen, aber nicht, während ein Regler gezogen wird
function refreshCast () {
  if (S.popover !== 'cast') return
  if (document.querySelector('#popover input[type="range"]:active')) return
  renderCast()
}

async function castStart (deviceId) {
  const c = S.cast
  const dev = c.devices.find(d => d.id === deviceId)
  if (!dev) return
  if (c.request) {
    const req = c.request
    c.request = null
    A.send('ui:reply', req.reqId, deviceId)
    hidePopover()
    return toast('Verbinde …', T('{host} auf {device}', { host: castHost(req.origin), device: dev.name }), 'cast', { duration: 2500 })
  }
  const t = activeTab()
  toast('Verbinde …', T('Streame auf {device}', { device: dev.name }), 'cast', { duration: 2500 })
  let res = { ok: true }
  if (c.source === 'app') res = await A.invoke('cast:start-app', deviceId, t?.wcId)
  else if (c.source === 'tab' || c.source === 'screen') res = await startMirror(c.source, dev)
  else if (c.source === 'media') {
    res = await A.invoke('cast:play', deviceId, { ...c.media, kind: 'media', wcId: t?.wcId })
    if (res.ok && t?.ready) t.webview.executeJavaScript('document.querySelectorAll("video,audio").forEach(v => v.pause())').catch(() => {})
  } else if (c.source === 'file' && c.file) {
    res = await A.invoke('cast:play', deviceId, { file: c.file, title: c.file.split(/[\\/]/).pop(), kind: 'file' })
  }
  if (!res.ok) toast('Streamen fehlgeschlagen', res.error, 'warning', { duration: 7000 })
}

function castStop (deviceId) {
  A.send('cast:stop', deviceId)
  if (S.cast.mirror?.deviceId === deviceId) stopMirror()
}

// Spiegelung: Tab bzw. Bildschirm aufnehmen, als WebM codieren und an den Hauptprozess schicken,
// der den Stream im Heimnetz für das Gerät bereitstellt.
async function startMirror (kind, dev) {
  const c = S.cast
  const t = activeTab()
  if (kind === 'tab' && !t?.wcId) return { ok: false, error: T('Kein Tab zum Streamen geöffnet.') }
  const audioOnly = dev.kind !== 'tv'
  stopMirror()
  const { token } = await A.invoke('cast:mirror-prepare', kind, t?.wcId, audioOnly)
  let stream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } },
      audio: kind === 'tab' ? { suppressLocalAudioPlayback: true } : true
    })
  } catch (err) {
    A.send('cast:mirror-end', token)
    return { ok: false, error: T('Aufnahme nicht möglich ({error})', { error: err.message }) }
  }
  if (audioOnly) for (const tr of stream.getVideoTracks()) { tr.stop(); stream.removeTrack(tr) }
  const hasAudio = stream.getAudioTracks().length > 0
  if (audioOnly && !hasAudio) {
    A.send('cast:mirror-end', token)
    return { ok: false, error: T('Es wurde kein Ton zum Streamen gefunden.') }
  }
  const mimeType = audioOnly ? 'audio/webm;codecs=opus' : hasAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8'
  // Regelmäßige Schlüsselbilder: ein später verbundenes Gerät kann so nach spätestens 2 s einsteigen
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 160_000, videoKeyFrameIntervalDuration: 2000 })
  rec.ondataavailable = async e => { if (e.data.size) A.send('cast:mirror-data', token, await e.data.arrayBuffer()) }
  rec.start(200)
  const m = { rec, stream, token, deviceId: dev.id, kind, tab: kind === 'tab' ? t : null }
  c.mirror = m
  m.tab?.webview?.classList.add('casting')
  for (const tr of stream.getTracks()) {
    tr.addEventListener('ended', () => { if (c.mirror === m) castStop(dev.id) })
  }
  const title = kind === 'tab' ? (t.title || t.url) : T('Bildschirm')
  const res = await A.invoke('cast:mirror-start', dev.id, { token, kind, title, audioOnly, wcId: t?.wcId })
  if (!res.ok && c.mirror === m) stopMirror()
  return res
}

function stopMirror () {
  const m = S.cast.mirror
  if (!m) return
  S.cast.mirror = null
  m.tab?.webview?.classList.remove('casting')
  try { if (m.rec.state !== 'inactive') m.rec.stop() } catch {}
  for (const tr of m.stream.getTracks()) tr.stop()
  A.send('cast:mirror-end', m.token)
}


/* ---------------------------------------------------------------------
   Einstellungen
   --------------------------------------------------------------------- */

async function openSettings (section = 'general') {
  closeFloating()
  const info = await A.invoke('app:info')
  const cs = section === 'claude' ? await claudeStatus() : {}
  const st = settings()
  const nav = [
    ['general', 'settings', T('Allgemein')],
    ['appearance', 'sparkles', T('Darstellung')],
    ['claude', 'chat', T('KI-Assistent')],
    ['adblock', 'shieldCheck', T('Werbeblocker')],
    ['vpn', 'vpn', 'VPN'],
    ['privacy', 'lock', T('Privatsphäre')],
    ['passwords', 'key', T('Passwörter')],
    ['downloads', 'download', T('Downloads')],
    ['performance', 'bolt', T('Leistung')],
    ['focus', 'focus', T('Fokus-Modus')],
    ['about', 'info', T('Über Caravel')]
  ]
  const perms = Object.entries(S.data.permissions || {})
  const PERM_NAMES = { media: 'Kamera/Mikrofon', 'media-video': 'Kamera', 'media-audio': 'Mikrofon', geolocation: 'Standort', notifications: 'Benachrichtigungen', 'clipboard-read': 'Zwischenablage', midi: 'MIDI', midiSysex: 'MIDI', 'display-capture': 'Bildschirmaufnahme', openExternal: 'Externe Apps', 'idle-detection': 'Inaktivität', hid: 'HID-Geräte', serial: 'Serielle Geräte', usb: 'USB-Geräte' }
  const ai = ASSISTANTS[st.assistant]
  const mcpClient = st.assistant === 'chatgpt' ? 'Codex' : 'Claude Code'
  const row = (title, desc, control) => `<div class="set-row"><div><div class="t">${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div>${control}</div>`
  const toggle = (key, on) => `<label class="switch"><input type="checkbox" data-s="${key}" ${on ? 'checked' : ''}><span></span></label>`
  const sections = {
    general: `<h3>${T('Allgemein')}</h3>
      ${row(T('Sprache'), T('Sprache der Oberfläche und der internen Seiten. „Automatisch“ folgt der Windows-Sprache.'),
        `<div class="seg" data-seg="language">${[['auto', T('Automatisch')], ['de', 'Deutsch'], ['en', 'English']].map(([k, l]) => `<button data-v="${k}" class="${(st.language || 'auto') === k ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
      ${row(T('Dein Name'), T('Für die persönliche Begrüßung auf der Startseite.'), `<input class="input" data-s="userName" value="${esc(st.userName)}" placeholder="${T('Name')}" style="width:200px">`)}
      ${row(T('Suchmaschine'), T('Wird in der Adressleiste und auf der Startseite verwendet.'), `<select class="input" data-s="searchEngine">${Object.entries(SEARCH_ENGINES).map(([k, v]) => `<option value="${k}" ${k === st.searchEngine ? 'selected' : ''}>${v.name}</option>`).join('')}</select>`)}
      ${row(T('Sitzung wiederherstellen'), T('Beim Start alle Spaces und Tabs wieder öffnen (schlafend, bis sie gebraucht werden).'), toggle('restoreSession', st.restoreSession))}
      ${row(T('Standardbrowser'), T('Caravel als Standard für Links und HTML-Dateien festlegen.'), `<button class="btn ghost" id="set-default">${T('Windows-Einstellungen öffnen')}</button>`)}
      ${row(T('Favoriten und Verlauf importieren'), T('Aus Google Chrome, Microsoft Edge oder Brave übernehmen. Passwörter lassen sich unter „Passwörter“ per CSV importieren.'), `<button class="btn ghost" id="set-import">${icon('importIcon')} ${T('Importieren …')}</button>`)}`,
    downloads: `<h3>${T('Downloads')}</h3>
      ${row(T('Speicherort'), esc(st.downloadDir || info.downloads), `<button class="btn ghost" id="set-dldir">${T('Ändern …')}</button>`)}
      ${st.downloadDir ? row(T('Standardordner verwenden'), esc(info.downloads), `<button class="btn ghost" id="set-dlreset">${T('Zurücksetzen')}</button>`) : ''}
      ${row(T('Vor dem Download nach dem Speicherort fragen'), T('Bei jedem Download den Dialog „Speichern unter“ zeigen.'), toggle('downloadAsk', st.downloadAsk))}`,
    passwords: `<h3>${T('Passwörter')}</h3>
      ${row(T('Passwörter speichern anbieten'), T('Nach einer Anmeldung fragt Caravel, ob die Zugangsdaten gespeichert werden sollen. Sie werden mit deinem Windows-Konto verschlüsselt und nur nach einem Klick im Auswahlmenü am Eingabefeld ausgefüllt.'), toggle('passwordsEnabled', st.passwordsEnabled !== false))}
      <div id="pw-box"><div class="muted" style="padding:14px 0">${T('Wird geladen …')}</div></div>`,
    appearance: `<h3>${T('Darstellung')}</h3>
      ${row(T('Design'), '', `<div class="seg" data-seg="theme">${[['dark', T('Dunkel')], ['light', T('Hell')], ['system', T('System')]].map(([k, l]) => `<button data-v="${k}" class="${st.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
      ${row(T('Websites abdunkeln'), T('Im dunklen Design werden Seiten ohne eigenen Dunkelmodus (z. B. die Google-Suche) automatisch dunkel dargestellt – wie Chromes „Automatischer dunkler Modus für Webinhalte“. Seiten mit eigenem Dunkelmodus bleiben unverändert.'), toggle('autoDarkPages', st.autoDarkPages !== false))}
      ${row(T('Ambient-Farben'), T('Die Oberfläche übernimmt dezent die Markenfarbe der aktuellen Website.'), toggle('ambient', st.ambient))}
      <div class="set-row" style="display:block"><div class="t">${T('Tab-Leiste')}</div><div class="d">${T('Wo und wie die Tabs angezeigt werden.')}</div>
        <div class="layout-pick" data-seg="tabLayout">${[
          ['sidebar', 'Caravel', T('Seitenleiste links'), '<rect x="1" y="1" width="62" height="42" rx="5" class="lp-frame"/><rect x="4" y="4" width="15" height="36" rx="3" class="lp-bar"/><rect x="6" y="9" width="11" height="3" rx="1.5" class="lp-acc"/><rect x="6" y="14" width="11" height="3" rx="1.5" class="lp-dim"/><rect x="6" y="19" width="11" height="3" rx="1.5" class="lp-dim"/><rect x="22" y="4" width="38" height="5" rx="2.5" class="lp-dim"/><rect x="22" y="12" width="38" height="28" rx="3" class="lp-page"/>'],
          ['chrome', 'Chrome', T('Tabs oben'), '<rect x="1" y="1" width="62" height="42" rx="5" class="lp-frame"/><rect x="5" y="4" width="16" height="6" rx="2" class="lp-acc"/><rect x="23" y="5" width="13" height="4" rx="2" class="lp-dim"/><rect x="38" y="5" width="13" height="4" rx="2" class="lp-dim"/><rect x="4" y="10" width="56" height="7" rx="2" class="lp-bar"/><rect x="4" y="19" width="56" height="21" rx="3" class="lp-page"/>'],
          ['safari', 'Safari', T('Tabs unter der Adressleiste'), '<rect x="1" y="1" width="62" height="42" rx="5" class="lp-frame"/><rect x="14" y="4" width="36" height="5" rx="2.5" class="lp-dim"/><rect x="4" y="11" width="18" height="5" rx="2" class="lp-acc"/><rect x="23" y="11" width="18" height="5" rx="2" class="lp-bar"/><rect x="42" y="11" width="18" height="5" rx="2" class="lp-bar"/><rect x="4" y="19" width="56" height="21" rx="3" class="lp-page"/>']
        ].map(([k, l, d, svg]) => `<button data-v="${k}" class="${tabLayout() === k ? 'on' : ''}"><svg viewBox="0 0 64 44">${svg}</svg><b>${l}</b><span>${d}</span></button>`).join('')}</div></div>
      ${tabLayout() === 'sidebar'
        ? row(T('Kompakte Seitenleiste'), T('Nur Symbole anzeigen (Strg+B).'), toggle('sidebarCollapsed', st.sidebarCollapsed))
        : row(T('Favoritenleiste'), T('Deine Favoriten als Leiste unter der Adressleiste (Strg+B).'), toggle('showFavbar', st.showFavbar !== false))}
      ${row(T('Kompakte Darstellung'), T('Niedrigere Leisten und Tabs – mehr Platz für Webseiten.'), toggle('compactUi', st.compactUi))}
      ${row(T('Space-Farbe'), T('Jeder Space hat seine eigene Akzentfarbe – per Rechtsklick auf das Space-Symbol änderbar.'), `<button class="btn ghost" id="set-space">${T('Aktuellen Space bearbeiten')}</button>`)}`,
    claude: `<h3>${T('KI-Assistent')}</h3>
      ${row(T('Assistent'), T('Welcher KI-Dienst in Caravel eingebunden wird. Bei „Keiner“ verschwinden Seitenleiste, Kontextmenü-Einträge und Agenten-Schnittstelle vollständig.'),
        `<div class="seg" data-seg="assistant">${[['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['none', T('Keiner')]].map(([k, l]) => `<button data-v="${k}" class="${(st.assistant || 'claude') === k ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
      ${ai ? row(T('{ai}-Seitenleiste', { ai: ai.name }), T('Blendet {site} neben jeder Seite ein (Strg+E) und ergänzt Kontextmenüs wie „Seite zusammenfassen“, „Mit {ai} erklären“ oder „Seite übergeben“ (Strg+Umschalt+L).', { site: st.assistant === 'chatgpt' ? 'chatgpt.com' : 'claude.ai', ai: ai.name }), toggle('claudeSidebar', st.claudeSidebar)) : ''}
      ${st.assistant === 'claude' ? `<div class="set-row" style="display:block">
        <div class="flex"><div class="grow"><div class="t"><span class="status-dot ${cs.extensionInstalled ? 'ok' : ''}"></span>Claude in Chrome</div>
          <div class="d">${T('Die offizielle Erweiterung von Anthropic: Claude liest, klickt und füllt Formulare direkt im Tab. Caravel stellt die dafür nötigen Chrome-Schnittstellen (Seitenleiste, Tab-Gruppen, Debugger) über eine eigene Kompatibilitätsschicht bereit. Offiziell unterstützt Anthropic nur Chrome, Edge und Brave.')}</div></div>
          ${cs.extensionInstalled ? `<button class="btn" id="cl-open">${T('Öffnen')}</button>` : `<button class="btn" id="cl-install">${T('Installieren')}</button>`}</div>
      </div>
      <div class="set-row" style="display:block">
        <div class="t"><span class="status-dot ${cs.nativeHost ? 'ok' : ''}"></span>${T('Claude Code über Claude in Chrome')}</div>
        <div class="d">${cs.nativeHost ? T('Claude Code ist auf diesem PC eingerichtet. Ist Claude in Chrome installiert und angemeldet, kann Claude Code darüber diesen Browser steuern (Start mit <code>claude --chrome</code>). Experimentell – zuverlässiger ist der MCP-Server unten.') : T('Nicht gefunden. Sobald Claude Code installiert und die Chrome-Integration eingerichtet ist, verbindet es sich über Claude in Chrome auch mit Caravel.')}</div>
      </div>` : ''}
      ${ai ? `<div class="set-row" style="display:block">
        <div class="flex"><div class="grow"><div class="t"><span class="status-dot ${cs.mcpRunning ? 'ok' : cs.mcpEnabled ? 'warn' : ''}"></span>${T('Caravel als MCP-Server für {client}', { client: mcpClient })}</div>
          <div class="d">${T('Ein in Caravel eingebauter MCP-Server. {client} kann damit Tabs auflisten und öffnen, Seiten als Markdown lesen, Elemente anklicken, Formulare ausfüllen und Screenshots machen – z. B. zum Recherchieren oder zum Testen deiner eigenen Web-Projekte. Er lauscht nur lokal (127.0.0.1) und verlangt ein geheimes Zugangstoken. Gesteuerte Tabs erhalten ein Roboter-Symbol.', { client: mcpClient })}</div></div>
          ${toggle('claudeMcp', st.claudeMcp)}</div>
        ${cs.mcpError ? `<div class="d" style="color:#f87171;margin-top:8px">${esc(cs.mcpError)}</div>` : ''}
        ${st.claudeMcp ? `<div class="flex" style="margin-top:10px"><span class="muted" style="font-size:12px">Port</span><input class="input" data-s="claudeMcpPort" data-num value="${+st.claudeMcpPort || 47823}" style="width:100px"><span class="grow"></span><button class="btn ghost sm" id="cl-token">${icon('refresh')} ${T('Neues Token')}</button></div>
        ${st.assistant === 'chatgpt' ? `<div class="muted" style="font-size:12px;margin:10px 0 6px"><span class="status-dot ${cs.codexConfigured ? 'ok' : cs.codexHasEntry ? 'warn' : ''}"></span>${T(cs.codexConfigured ? 'In Codex eingetragen – Codex neu starten, falls es gerade läuft.' : cs.codexHasEntry ? 'Codex kennt Caravel, aber mit altem Token oder Port – bitte neu eintragen.' : 'Caravel kann sich selbst in die Codex-Konfiguration eintragen')} (<code>${esc(cs.codexConfigPath || '~/.codex/config.toml')}</code>):</div>
        <div class="code-box" id="cl-cmd">[mcp_servers.caravel]
url = "http://127.0.0.1:${+st.claudeMcpPort || 47823}/mcp"
http_headers = { "Authorization" = "Bearer ${esc(cs.mcpToken || '')}" }</div>
        <div class="flex" style="margin-top:8px"><button class="btn sm" id="cx-install">${icon('check')} ${T('In Codex eintragen')}</button><button class="btn ghost sm" id="cl-copy">${icon('copy')} ${T('Kopieren')}</button></div>` : `<div class="muted" style="font-size:12px;margin:10px 0 6px">${T('Einmalig in einem Terminal ausführen (danach steht Caravel in Claude Code als Werkzeug bereit):')}</div>
        <div class="code-box" id="cl-cmd">claude mcp add --transport http --scope user caravel http://127.0.0.1:${+st.claudeMcpPort || 47823}/mcp --header "Authorization: Bearer ${esc(cs.mcpToken || '')}"</div>
        <button class="btn ghost sm" id="cl-copy" style="margin-top:8px">${icon('copy')} ${T('Befehl kopieren')}</button>`}` : ''}
      </div>` : ''}`,
    adblock: `<h3>${T('Werbeblocker')}</h3>
      ${row(T('Werbung & Tracker blockieren'), T('Nutzt die Filterlisten von uBlock Origin (uBlock filters, Quick fixes, EasyList, EasyPrivacy, EasyList Germany u. a.) inklusive der Skriptfilter gegen YouTube-Werbung. Die Listen werden täglich aktualisiert.'), toggle('adblock', st.adblock !== false))}
      ${row(T('Cookie-Banner ausblenden'), T('Blendet Einwilligungs-Dialoge aus (uBlock-Liste „Cookie Notices“). Einzelne Seiten können dadurch anders aussehen.'), toggle('adblockCookies', st.adblockCookies))}
      <div class="set-row" style="display:block"><div class="t">${T('Pausiert auf')}</div>
        ${(st.adblockAllowlist || []).length ? st.adblockAllowlist.map(h => `<div class="flex" style="margin-top:8px"><span class="grow">${esc(h)}</span><button class="btn ghost sm" data-allow="${esc(h)}">${T('Entfernen')}</button></div>`).join('') : `<div class="d" style="margin-top:6px">${T('Keine Ausnahmen. Über das Schild-Symbol in der Adressleiste lässt sich der Blocker pro Website pausieren.')}</div>`}
      </div>`,
    vpn: `<h3>VPN</h3>
      ${row(T('Beim Start automatisch verbinden'), T('Verbindet mit dem zuletzt gewählten Tor-Land bzw. Server.'), toggle('vpnAutoConnect', st.vpnAutoConnect))}
      <div class="set-row" style="display:block"><div class="t">${T('So funktioniert das VPN in Caravel')}</div>
        <div class="d" style="max-width:none;margin-top:6px;line-height:1.6">
          <b>${T('Tor (kostenlos):')}</b> ${T('Caravel bringt Tor mit. Du wählst das Ausgangsland, Caravel baut die Verbindung auf und leitet alle Tabs hindurch. Langsamer als ein kommerzielles VPN, dafür ohne Konto und ohne Kosten.')}<br>
          <b>${T('Eigene Server:')}</b> ${T('WireGuard-Konfigurationen (z. B. kostenlos bei Proton VPN oder von Mullvad, IVPN, Windscribe) sowie SOCKS5- und HTTP(S)-Zugänge deines Anbieters. WireGuard läuft direkt in Caravel, ohne Treiber und ohne Administratorrechte.')}<br>
          ${T('Das VPN gilt für den Browser, nicht für andere Programme auf dem PC. WebRTC wird bei aktivem VPN so eingeschränkt, dass deine echte IP nicht durchsickert.')}</div>
      </div>
      <div class="flex"><button class="btn" id="vpn-open">${icon('vpn')} ${T('VPN-Menü öffnen')}</button></div>`,
    privacy: `<h3>${T('Privatsphäre & Sicherheit')}</h3>
      ${row(T('Browserdaten löschen'), T('Entfernt die gewählten Daten aller Websites.'), `<div class="flex"><button class="btn ghost sm" data-clear="cache">${T('Cache')}</button><button class="btn ghost sm" data-clear="cookies">${T('Cookies')}</button><button class="btn ghost sm" data-clear="storage">${T('Website-Daten')}</button><button class="btn ghost sm" data-clear="history">${T('Verlauf')}</button></div>`)}
      <div class="set-row" style="display:block"><div class="t">${T('Gespeicherte Website-Berechtigungen')}</div>
        ${perms.length ? perms.map(([origin, p]) => `<div class="flex" style="margin-top:8px"><span class="grow" style="word-break:break-all">${esc(origin)}<br><span class="muted" style="font-size:12px">${Object.entries(p).map(([k, v]) => `${esc(T(PERM_NAMES[k] || k))}: ${v ? T('erlaubt') : T('blockiert')}`).join(' · ')}</span></span><button class="btn ghost sm" data-perm="${esc(origin)}">${T('Zurücksetzen')}</button></div>`).join('') : `<div class="d" style="margin-top:6px">${T('Keine gespeicherten Berechtigungen.')}</div>`}
      </div>
      <div class="set-row" style="display:block"><div class="t">${T('Einstellungen pro Website')}</div><div class="d">${T('Zoom, Ton und Pop-ups – änderbar über das Schloss-Symbol in der Adressleiste.')}</div>
        ${Object.keys(S.data.sites || {}).length ? Object.entries(S.data.sites).map(([host, c]) => `<div class="flex" style="margin-top:8px"><span class="grow" style="word-break:break-all">${esc(host)}<br><span class="muted" style="font-size:12px">${[
          c.zoom ? T('Zoom: {pct} %', { pct: Math.round(Math.pow(1.2, c.zoom) * 100) }) : '',
          c.popups === 'allow' ? T('Pop-ups erlaubt') : c.popups === 'block' ? T('Pop-ups blockiert') : '',
          c.sound === 'mute' ? T('Stumm') : ''].filter(Boolean).join(' · ')}</span></span><button class="btn ghost sm" data-site="${esc(host)}">${T('Zurücksetzen')}</button></div>`).join('') : `<div class="d" style="margin-top:6px">${T('Keine besonderen Einstellungen.')}</div>`}
      </div>`,
    performance: `<h3>${T('Leistung')}</h3>
      ${row(T('Tab-Schlaf'), T('Inaktive Tabs werden nach dieser Zeit schlafen gelegt und geben ihren Arbeitsspeicher frei. Sie wachen beim Anklicken sofort wieder auf. Tabs mit Ton schlafen nie.'),
        `<select class="input" data-s="sleepMinutes" data-num>${[[0, T('Nie')], [5, T('{n} Minuten', { n: 5 })], [15, T('{n} Minuten', { n: 15 })], [30, T('{n} Minuten', { n: 30 })], [60, T('1 Stunde')], [180, T('{n} Stunden', { n: 3 })]].map(([v, l]) => `<option value="${v}" ${+st.sleepMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${row(T('Jetzt aufräumen'), T('Alle Hintergrund-Tabs sofort schlafen legen.'), `<button class="btn ghost" id="set-sleep">${icon('zzz')} ${T('Tabs schlafen legen')}</button>`)}`,
    focus: `<h3>${T('Fokus-Modus')}</h3>
      ${row(T('Standarddauer'), '', `<select class="input" data-s="focusMinutes" data-num>${[15, 25, 45, 60, 90].map(v => `<option value="${v}" ${+st.focusMinutes === v ? 'selected' : ''}>${T('{n} Minuten', { n: v })}</option>`).join('')}</select>`)}
      <div class="field" style="margin-top:14px"><label>${T('Gesperrte Websites (eine Domain pro Zeile)')}</label><textarea class="input" rows="9" id="set-blocklist">${esc(st.focusBlocklist.join('\n'))}</textarea><span class="hint">${T('Subdomains werden automatisch mitgesperrt (z. B. m.youtube.com).')}</span></div>
      <div class="card"><div class="flex"><span style="color:var(--accent)">${icon('sparkles')}</span><div>${T('Bisher <b>{s}</b> abgeschlossene Sessions · <b>{m}</b> fokussierte Minuten', { s: S.data.focusStats.sessions, m: S.data.focusStats.minutes })}</div></div></div>`,
    about: `<div class="about-hero">${$('.logo').outerHTML.replace('class="logo"', 'style="width:64px;height:64px"').replace('id="lg"', 'id="lg2"').replace('url(#lg)', 'url(#lg2)')}<div><h4>Caravel</h4><div class="muted">${T('Version')} ${esc(info.version)} · Chromium ${esc(info.chrome)}</div></div></div>
      <div class="card" id="upd-box"></div>
      ${row(T('Updates automatisch herunterladen'), T('Caravel sucht beim Start und alle vier Stunden nach einer neuen Version und installiert sie beim nächsten Beenden.'), toggle('autoUpdate', st.autoUpdate !== false))}
      <p style="line-height:1.6">${T('Caravel ist ein Browser für Menschen, die im Web arbeiten, lernen und entdecken. Er verbindet die Chromium-Engine mit Ideen, die andere Browser nicht haben: <b>Spaces</b>, <b>Split View</b>, <b>Peek</b>, <b>Fokus-Modus</b>, <b>Seiten-Notizen</b>, <b>Zeitkapseln</b>, <b>Tab-Schlaf</b>, <b>Ambient-Farben</b>, einen <b>Leser-Modus mit Vorlesefunktion</b> und <b>Chromecast</b>.')}</p>
      <div class="card"><div class="kbd-list"><div>Electron</div><div>${esc(info.electron)}</div><div>Chromium</div><div>${esc(info.chrome)}</div><div>Node.js</div><div>${esc(info.node)}</div><div>${T('Download-Ordner')}</div><div>${esc(info.downloads)}</div></div></div>
      <p class="muted" style="font-size:12px;line-height:1.6">${T('Chrome-Erweiterungen: electron-chrome-extensions (GPL-3.0), electron-chrome-web-store (MIT). Werbeblocker: @ghostery/adblocker (MPL-2.0) mit den Filterlisten von uBlock Origin (GPL-3.0) und EasyList (GPL-3.0/CC BY-SA 3.0). VPN: Tor (BSD-3-Clause), wireproxy (ISC). Leser-Modus: Mozilla Readability (Apache-2.0), Turndown (MIT). Chromecast: castv2 (MIT), multicast-dns (MIT).')}<br>${T('„Claude“ ist eine Marke von Anthropic, „ChatGPT“ und „Codex“ sind Marken von OpenAI. Caravel ist ein unabhängiges Projekt und steht in keiner Verbindung zu Anthropic, OpenAI, Google oder dem Tor Project.')}</p>`
  }
  showModal(`<div class="settings"><nav><h2>${T('Einstellungen')}</h2>${nav.map(([k, ic, l]) => `<button data-sec="${k}" class="${k === section ? 'on' : ''}">${icon(ic)} ${l}</button>`).join('')}</nav><section><button class="icon-btn sm close-x" data-close>${icon('x')}</button>${sections[section]}</section></div>`, { wide: true })
  S.modalSection = section
  const card = $('#modal-card')
  card.querySelectorAll('[data-sec]').forEach(b => { b.onclick = () => openSettings(b.dataset.sec) })
  const apply = () => { save('settings'); applySettings() }
  if (section === 'about') renderUpdateBox()
  if (section === 'passwords') renderPasswords()
  const imp = $('#set-import')
  if (imp) imp.onclick = openImportDialog
  const dlDir = $('#set-dldir')
  if (dlDir) {
    dlDir.onclick = async () => {
      const dir = await A.invoke('app:pick-folder', st.downloadDir || '')
      if (dir) { st.downloadDir = dir; saveSettingsNow(); openSettings('downloads') }
    }
  }
  const dlReset = $('#set-dlreset')
  if (dlReset) dlReset.onclick = () => { st.downloadDir = ''; saveSettingsNow(); openSettings('downloads') }
  card.querySelectorAll('[data-site]').forEach(b => {
    b.onclick = () => {
      delete S.data.sites[b.dataset.site]
      save('sites')
      for (const t of S.tabs.values()) if (hostOf(t.url) === b.dataset.site) applySiteSettings(t)
      openSettings('privacy')
    }
  })
  card.querySelectorAll('[data-s]').forEach(el => {
    el.onchange = () => {
      const k = el.dataset.s
      st[k] = el.type === 'checkbox' ? el.checked : el.dataset.num !== undefined ? +el.value : el.value
      apply()
    }
  })
  card.querySelectorAll('[data-seg]').forEach(seg => {
    seg.onclick = e => {
      const b = e.target.closest('[data-v]'); if (!b) return
      st[seg.dataset.seg] = b.dataset.v
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b))
      apply()
    }
  })
  const bl = $('#set-blocklist')
  if (bl) bl.onchange = () => { st.focusBlocklist = bl.value.split(/\s+/).map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean); apply() }
  const dflt = $('#set-default')
  if (dflt) dflt.onclick = () => A.send('app:default-browser')
  const spb = $('#set-space')
  if (spb) spb.onclick = () => editSpaceDialog(curSpace())
  const sl = $('#set-sleep')
  if (sl) sl.onclick = () => { sleepAll(); toast('Aufgeräumt', 'Alle Hintergrund-Tabs schlafen jetzt.', 'zzz') }
  card.querySelectorAll('[data-clear]').forEach(b => {
    b.onclick = async () => {
      const what = b.dataset.clear
      if (what === 'history') { S.data.history = []; save('history') } else await A.invoke('data:clear', [what])
      toast('Gelöscht', { cache: 'Cache geleert', cookies: 'Alle Cookies entfernt', storage: 'Website-Daten entfernt', history: 'Verlauf gelöscht' }[what], 'trash')
    }
  })
  card.querySelectorAll('[data-perm]').forEach(b => {
    b.onclick = () => { delete S.data.permissions[b.dataset.perm]; save('permissions'); openSettings('privacy') }
  })
  card.querySelectorAll('[data-allow]').forEach(b => {
    b.onclick = () => { st.adblockAllowlist = st.adblockAllowlist.filter(h => h !== b.dataset.allow); apply(); openSettings('adblock') }
  })
  // Abschnitt „KI-Assistent“
  if (section === 'claude') {
    card.querySelectorAll('[data-s="claudeMcp"], [data-s="claudeMcpPort"]').forEach(el => {
      const prev = el.onchange
      el.onchange = () => { prev(); saveSettingsNow(); setTimeout(() => openSettings('claude'), 300) }
    })
    const seg = card.querySelector('[data-seg="assistant"]')
    const prevSeg = seg.onclick
    seg.onclick = e => { prevSeg(e); saveSettingsNow(); setTimeout(() => openSettings('claude'), 300) }
    if (cs.mcpToken) st.claudeMcpToken = cs.mcpToken
  }
  // Sprache gewechselt: wirkt nach einem Neustart (Oberfläche, Menüs und interne Seiten)
  const langSeg = card.querySelector('[data-seg="language"]')
  if (langSeg) {
    const prevLang = langSeg.onclick
    langSeg.onclick = e => {
      prevLang(e)
      if (!e.target.closest('[data-v]')) return
      saveSettingsNow()
      const next = I18N.resolve(st.language, navigator.language)
      $$('.toast[data-lang]').forEach(x => x.remove())
      // zweisprachig, weil die neue Sprache erst nach dem Neustart gilt
      toast(next === 'en' ? 'Restart required · Neustart nötig' : 'Neustart nötig · Restart required',
        next === 'en' ? 'Caravel will switch to English after a restart.' : 'Caravel wechselt nach einem Neustart auf Deutsch.', 'refresh', {
          duration: 12000,
          actions: [{ label: next === 'en' ? 'Restart now' : 'Jetzt neu starten', run: () => { flushPending(); A.send('app:relaunch') } }]
        })
      $('#toasts').lastChild.dataset.lang = '1'
    }
  }
  // Tab-Leiste gewechselt: Abschnitt neu zeichnen (Seitenleisten- bzw. Favoritenleisten-Schalter)
  const layoutSeg = card.querySelector('[data-seg="tabLayout"]')
  if (layoutSeg) {
    const prevLayout = layoutSeg.onclick
    layoutSeg.onclick = e => { prevLayout(e); if (e.target.closest('[data-v]')) openSettings('appearance') }
  }
  const cxInstall = $('#cx-install')
  if (cxInstall) {
    cxInstall.onclick = async () => {
      try {
        const file = await A.invoke('codex:install-mcp')
        toast('In Codex eingetragen', T('{file} – Codex ggf. neu starten. Caravel erscheint dort als MCP-Server „caravel“.', { file }), 'check', { duration: 7000 })
      } catch (err) {
        toast('Eintragen fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: /, ''), 'warning', { duration: 7000 })
      }
      openSettings('claude')
    }
  }
  const clToken = $('#cl-token')
  if (clToken) {
    clToken.onclick = async () => {
      settings().claudeMcpToken = await A.invoke('claude:mcp-new-token')
      toast('Neues Token erstellt', settings().assistant === 'chatgpt'
        ? 'Caravel erneut in Codex eintragen.'
        : 'Den Befehl in Claude Code erneut ausführen (vorher: claude mcp remove caravel).', 'refresh', { duration: 6000 })
      openSettings('claude')
    }
  }
  const clInstall = $('#cl-install')
  if (clInstall) {
    clInstall.onclick = async () => {
      clInstall.disabled = true
      clInstall.textContent = T('Wird installiert …')
      try {
        await A.invoke('claude:install-extension')
        toast('Claude in Chrome installiert', 'Öffne es über das Symbol in der Werkzeugleiste oder hier.', 'chat')
      } catch (err) {
        toast('Installation fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: /, ''), 'warning', { duration: 7000 })
      }
      openSettings('claude')
    }
  }
  const clOpen = $('#cl-open')
  if (clOpen) clOpen.onclick = () => { closeModal(); openClaudeExtension() }
  const clCopy = $('#cl-copy')
  if (clCopy) clCopy.onclick = () => { A.send('clipboard:write', $('#cl-cmd').textContent); toast('Kopiert', 'In einem Terminal einfügen und ausführen.', 'copy') }
  const vpnOpen = $('#vpn-open')
  if (vpnOpen) vpnOpen.onclick = () => { closeModal(); openVpnPopover() }
}

// Einstellungen › Über Caravel: Update-Status
async function renderUpdateBox () {
  const box = $('#upd-box')
  if (!box) return
  if (!S.update) { try { S.update = await A.invoke('update:state') } catch { return } }
  const u = S.update
  const text = {
    idle: T('Noch nicht nach Updates gesucht.'),
    checking: T('Suche nach Updates …'),
    current: T('Caravel ist auf dem neuesten Stand.'),
    downloading: T('Lade Version {v} herunter … {p} %', { v: u.version, p: u.progress || 0 }),
    ready: T('Version {v} ist bereit und wird beim nächsten Beenden installiert.', { v: u.version }),
    error: T('Update-Prüfung fehlgeschlagen: {e}', { e: u.error || '' })
  }[u.status] || ''
  const sub = !u.supported ? T('Updates gibt es nur in der installierten Version (nicht beim Start mit „npm start“).') : u.checked ? T('Zuletzt geprüft: {t}', { t: new Date(u.checked).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' }) }) : ''
  box.innerHTML = `<div class="flex"><span style="color:var(--accent)">${icon('refresh')}</span><div class="grow"><div>${esc(text)}</div>${sub ? `<div class="muted" style="font-size:12px">${esc(sub)}</div>` : ''}</div>
    ${u.status === 'ready' ? `<button class="btn sm" id="upd-install">${T('Jetzt neu starten')}</button>` : `<button class="btn ghost sm" id="upd-check" ${u.status === 'checking' || u.status === 'downloading' ? 'disabled' : ''}>${T('Nach Updates suchen')}</button>`}</div>`
  const chk = $('#upd-check', box)
  if (chk) chk.onclick = async () => { S.update = { ...u, status: 'checking' }; renderUpdateBox(); S.update = await A.invoke('update:check'); renderUpdateBox() }
  const ins = $('#upd-install', box)
  if (ins) ins.onclick = () => { flushPending(); A.send('update:install') }
}

// Einstellungen › Passwörter: Liste mit Suche, Anzeigen, Kopieren, Bearbeiten, Löschen, CSV-Import/-Export
async function renderPasswords (filter = '') {
  const box = $('#pw-box')
  if (!box) return
  let data
  try { data = await A.invoke('pw:list') } catch { return }
  if (!$('#pw-box')) return
  const q = filter.toLowerCase()
  const items = data.items.filter(i => !q || (i.origin + ' ' + i.username).toLowerCase().includes(q))
  box.innerHTML = `
    ${data.available ? '' : `<div class="card" style="color:#f87171">${T('Die Windows-Verschlüsselung ist nicht verfügbar – Passwörter können nicht gespeichert werden.')}</div>`}
    <div class="flex" style="margin:14px 0 8px;gap:8px"><input class="input grow" id="pw-search" placeholder="${T('Passwörter durchsuchen …')}" value="${esc(filter)}"><button class="btn ghost sm" id="pw-import">${icon('importIcon')} ${T('CSV importieren')}</button><button class="btn ghost sm" id="pw-export">${T('Exportieren')}</button></div>
    <div class="muted" style="font-size:12px;margin-bottom:6px">${T('{n} gespeicherte Passwörter', { n: data.items.length })} · ${T('Aus Chrome: chrome://password-manager/settings → „Passwörter exportieren“, dann hier importieren.')}</div>
    <div id="pw-list">${items.map(i => `<div class="row pw-row" data-id="${esc(i.id)}"><span class="r-ico"></span><div class="r-main"><div class="r-title">${esc(new URL(i.origin).hostname)}</div><div class="r-sub">${esc(i.username || '—')} · <span class="pw-val">••••••••</span></div></div>
      <div class="r-act" style="opacity:1"><button class="icon-btn sm" data-a="show" title="${T('Anzeigen')}">${icon('eye')}</button><button class="icon-btn sm" data-a="copy" title="${T('Passwort kopieren')}">${icon('copy')}</button><button class="icon-btn sm" data-a="edit" title="${T('Bearbeiten')}">${icon('type')}</button><button class="icon-btn sm" data-a="del" title="${T('Löschen')}">${icon('trash')}</button></div></div>`).join('') || `<div class="empty">${icon('key')}<div>${q ? T('Keine Treffer') : T('Noch keine Passwörter gespeichert')}</div></div>`}</div>
    ${data.never.length ? `<div class="group-title">${T('Nie speichern für')}</div>${data.never.map(o => `<div class="flex" style="margin-top:6px"><span class="grow">${esc(o)}</span><button class="btn ghost sm" data-never="${esc(o)}">${T('Entfernen')}</button></div>`).join('')}` : ''}`
  for (const row of box.querySelectorAll('.pw-row')) {
    const item = data.items.find(i => i.id === row.dataset.id)
    row.querySelector('.r-ico').append(faviconEl(null, item.origin))
    row.querySelector('.r-act').onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a
      if (!a) return
      if (a === 'show') {
        const val = row.querySelector('.pw-val')
        val.textContent = val.dataset.shown ? '••••••••' : await A.invoke('pw:reveal', item.id)
        val.dataset.shown = val.dataset.shown ? '' : '1'
      }
      if (a === 'copy') { A.send('clipboard:write', await A.invoke('pw:reveal', item.id)); toast('Passwort kopiert', new URL(item.origin).hostname, 'copy', { duration: 2000 }) }
      if (a === 'del') confirmDialog(T('Passwort für {host} löschen?', { host: new URL(item.origin).hostname }), 'Das gespeicherte Passwort wird entfernt.', 'Löschen', async () => { await A.invoke('pw:delete', item.id); openSettings('passwords') })
      if (a === 'edit') editPasswordDialog(item)
    }
  }
  const search = $('#pw-search', box)
  search.oninput = () => { const v = search.value; renderPasswords(v).then(() => { const s = $('#pw-search'); if (s) { s.focus(); s.setSelectionRange(v.length, v.length) } }) }
  $('#pw-import', box).onclick = async () => {
    try {
      const n = await A.invoke('pw:import')
      if (n !== null) { toast('Passwörter importiert', T('{n} Einträge übernommen.', { n }), 'key'); openSettings('passwords') }
    } catch (err) { toast('Import fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: (Error: )?/, ''), 'warning', { duration: 7000 }) }
  }
  $('#pw-export', box).onclick = () => confirmDialog('Passwörter exportieren?', 'Die Datei enthält alle Passwörter unverschlüsselt. Bewahre sie sicher auf und lösche sie nach dem Import.', 'Exportieren', async () => {
    const file = await A.invoke('pw:export')
    if (file) toast('Passwörter exportiert', file.split(/[\\/]/).pop(), 'key', { actions: [{ label: 'Ordner', run: () => A.send('dl:show', file) }] })
  })
  box.querySelectorAll('[data-never]').forEach(b => { b.onclick = async () => { await A.invoke('pw:never-remove', b.dataset.never); renderPasswords(filter) } })
}

async function editPasswordDialog (item) {
  const password = await A.invoke('pw:reveal', item.id)
  showModal(`
    <div class="modal-head"><h2>${esc(new URL(item.origin).hostname)}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <div class="field"><label>${T('Benutzername')}</label><input class="input" id="pe-user" value="${esc(item.username)}"></div>
      <div class="field"><label>${T('Passwort')}</label><input class="input" id="pe-pass" type="password" value="${esc(password || '')}"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>${T('Abbrechen')}</button><button class="btn" id="pe-save">${T('Speichern')}</button></div>`)
  $('#pe-save').onclick = async () => {
    await A.invoke('pw:update', item.id, { username: $('#pe-user').value, password: $('#pe-pass').value })
    openSettings('passwords')
  }
}

// Favoriten und Verlauf aus Chrome, Edge oder Brave übernehmen
async function openImportDialog () {
  closeFloating()
  const sources = await A.invoke('import:sources').catch(() => [])
  if (!sources.length) return toast('Nichts zu importieren', 'Es wurde kein Chrome, Edge oder Brave gefunden.', 'importIcon')
  showModal(`
    <div class="modal-head"><h2>${T('Favoriten und Verlauf importieren')}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <div class="field"><label>${T('Aus')}</label><select class="input" id="im-src">${sources.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>
      <label class="flex" style="gap:8px;margin:8px 0"><input type="checkbox" id="im-bm" checked> ${T('Favoriten')}</label>
      <label class="flex" style="gap:8px;margin:8px 0"><input type="checkbox" id="im-hist" checked> ${T('Verlauf')}</label>
      <p class="muted" style="font-size:12px;line-height:1.5">${T('Bereits vorhandene Favoriten werden nicht doppelt angelegt. Passwörter: in Chrome als CSV exportieren und unter Einstellungen › Passwörter importieren.')}</p>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>${T('Abbrechen')}</button><button class="btn" id="im-go">${T('Importieren')}</button></div>`)
  $('#im-go').onclick = async () => {
    const src = sources.find(s => s.id === $('#im-src').value)
    const what = { bookmarks: $('#im-bm').checked && src.bookmarks, history: $('#im-hist').checked && src.history }
    $('#im-go').disabled = true
    let res
    try { res = await A.invoke('import:run', src.id, what) } catch (err) {
      $('#im-go').disabled = false
      return toast('Import fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: (Error: )?/, ''), 'warning', { duration: 8000 })
    }
    closeModal()
    let nb = 0
    let nh = 0
    if (res.bookmarks) {
      const known = new Set(bmFlat().map(b => b.url))
      const fresh = items => items.filter(b => !known.has(b.url) && known.add(b.url))
      for (const b of res.bookmarks.bar) {
        if (b.folder) { b.children = fresh(b.children); if (b.children.length) { S.data.bookmarks.push(b); nb += b.children.length } } else if (fresh([b]).length) { S.data.bookmarks.push(b); nb++ }
      }
      const other = fresh(res.bookmarks.other)
      if (other.length) {
        S.data.bookmarks.push({ id: bmNewId(), folder: true, title: T('Importiert aus {name}', { name: src.name }), children: other })
        nb += other.length
      }
      saveBookmarks()
    }
    if (res.history) {
      const seen = new Set(S.data.history.map(h => h.url + '|' + h.time))
      const add = res.history.filter(h => !seen.has(h.url + '|' + h.time))
      nh = add.length
      S.data.history = [...S.data.history, ...add].sort((a, b) => b.time - a.time).slice(0, 3000)
      save('history')
    }
    toast('Import abgeschlossen', T('{b} Favoriten und {h} Verlaufseinträge übernommen.', { b: nb, h: nh }), 'check', { duration: 6000 })
  }
}

async function openClaudeExtension () {
  const t = activeTab()
  if (!t?.wcId || !/^https?:/.test(t.url)) {
    return toast('Claude in Chrome', 'Öffne zuerst eine Website – Claude arbeitet immer im aktuellen Tab.', 'chat')
  }
  const res = await A.invoke('claude:open-extension', t.wcId)
  if (res?.error) toast('Claude in Chrome', res.error, 'warning')
}

function applySettings () {
  applyTheme()
  applyTabLayout()
  updateAdblockChip()
  applyAssistant()
  if (DOCK.open) renderDock()
  if (S.focus.active) A.send('focus:set', true, settings().focusBlocklist)
}

function applyTheme () {
  const dark = isDark()
  document.body.classList.toggle('theme-dark', dark)
  document.body.classList.toggle('theme-light', !dark)
  updateAmbient()
}

function showShortcuts () {
  const list = [
    ['Befehlspalette', 'Strg K'], ['Neuer Tab', 'Strg T'], ['Tab schließen', 'Strg W'], ['Geschlossenen Tab öffnen', 'Strg Umschalt T'],
    ['Nächster / vorheriger Tab', 'Strg Tab / Strg Umschalt Tab'], ['Tab 1–9', 'Strg 1–9'], ['Space 1–9', 'Alt 1–9'],
    ['Adressleiste', 'Strg L'], ['Split View', 'Strg Umschalt S'], ['Peek-Vorschau', 'Umschalt + Klick auf Link'],
    ['Privater Space', 'Strg Umschalt N'], ['Tab suchen', 'Strg Umschalt A'], ['Tab schließen', 'Strg F4'], ['Nächster / vorheriger Tab', 'Strg Bild↓ / Strg Bild↑'],
    ['Leser-Modus', 'F9'], ['Fokus-Modus', 'Strg Umschalt F'], ['Screenshot', 'Strg Umschalt X'], ['Seiten-Notizen', 'Strg Umschalt U'],
    ['Lesezeichen', 'Strg D'], ['Auf Seite suchen', 'Strg F'], ['Nächster Treffer', 'F3 / Strg G'], ['Verlauf', 'Strg H'], ['Downloads', 'Strg J'], ['Erweiterungen', 'Strg Umschalt E'],
    ['Seite speichern', 'Strg S'], ['Datei öffnen', 'Strg O'], ['Seitenquelltext', 'Strg U'], ['Browserdaten löschen', 'Strg Umschalt Entf'], ['Startseite', 'Alt Pos1'],
    ...(dockEnabled() ? [[T('{ai}-Seitenleiste', { ai: assistant().name }), 'Strg E'], [T('Seite an {ai} übergeben', { ai: assistant().name }), 'Strg Umschalt L']] : []),
    ['Seitenleiste', 'Strg B'], ['Zoom', 'Strg + / Strg − / Strg 0'], ['Vollbild', 'F11'], ['Entwicklertools', 'F12'], ['Einstellungen', 'Strg ,']
  ]
  showModal(`<div class="modal-head"><h2>${T('Tastenkürzel')}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div><div class="modal-body"><div class="kbd-list">${list.map(([a, b]) => `<div>${esc(T(a))}</div><div>${T(b).split(' / ').map(x => `<kbd>${esc(x)}</kbd>`).join(' ')}</div>`).join('')}</div></div><div class="modal-foot"><button class="btn" data-close>${T('Alles klar')}</button></div>`)
}

/* ---------------------------------------------------------------------
   Aktionen
   --------------------------------------------------------------------- */

async function screenshot () {
  const t = activeTab()
  if (!t?.wcId) return
  const r = await A.invoke('tab:screenshot', t.wcId)
  if (!r) return
  toast('Screenshot gespeichert', 'In die Zwischenablage kopiert und unter Bilder › Caravel abgelegt.', 'camera', {
    image: r.dataUrl,
    actions: [{ label: 'Ordner', run: () => A.send('dl:show', r.file) }],
    duration: 5000
  })
}

function openFind () {
  const bar = $('#findbar')
  bar.hidden = false
  const input = $('#find-input')
  input.focus()
  input.select()
}

function initFind () {
  const input = $('#find-input')
  $('#find-prev').innerHTML = icon('up')
  $('#find-next').innerHTML = icon('down')
  $('#find-close').innerHTML = icon('x')
  const find = (forward = true, findNext = true) => {
    const t = activeTab()
    if (!t?.ready) return
    if (!input.value) { t.webview.stopFindInPage('clearSelection'); $('#find-count').textContent = '0/0'; return }
    t.webview.findInPage(input.value, { forward, findNext })
  }
  const close = () => { $('#findbar').hidden = true; activeTab()?.ready && activeTab().webview.stopFindInPage('clearSelection') }
  input.oninput = () => find(true, false)
  input.onkeydown = e => {
    if (e.key === 'Enter') find(!e.shiftKey, true)
    if (e.key === 'Escape') close()
  }
  $('#find-prev').onclick = () => find(false, true)
  $('#find-next').onclick = () => find(true, true)
  $('#find-close').onclick = close
}

// Strg+S: Seite speichern (vollständig, nur HTML oder als MHTML)
async function savePage () {
  const t = activeTab()
  if (!t?.wcId || isNewtab(t.url)) return
  try {
    const file = await A.invoke('tab:save-page', t.wcId)
    if (file) toast('Seite gespeichert', file.split(/[\\/]/).pop(), 'download', { actions: [{ label: 'Ordner', run: () => A.send('dl:show', file) }] })
  } catch (err) { toast('Speichern fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: /, ''), 'warning') }
}

// Strg+O: lokale Datei(en) öffnen
async function openFile () {
  const urls = await A.invoke('app:open-file').catch(() => [])
  for (const url of urls) createTab({ url })
}

// F3 / Strg+G: nächster Treffer der Seitensuche
function findAgain (forward) {
  const t = activeTab()
  const q = $('#find-input').value
  if (!t?.ready || !q) return openFind()
  $('#findbar').hidden = false
  t.webview.findInPage(q, { forward, findNext: true })
}

// Bild-im-Bild für das größte Video der Seite (Befehlspalette)
function togglePip () {
  const t = activeTab()
  if (!t?.ready) return
  t.webview.executeJavaScript(`(() => {
    const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!v) return false;
    if (document.pictureInPictureElement) { document.exitPictureInPicture(); return true }
    return v.requestPictureInPicture().then(() => true, () => false);
  })()`, true).then(ok => { if (!ok) toast('Bild-im-Bild', 'Auf dieser Seite wurde kein Video gefunden.', 'pip') }).catch(() => {})
}

function zoom (dir) {
  const t = activeTab()
  if (!t?.ready) return
  t.zoom = dir === 0 ? 0 : Math.max(-5, Math.min(6, t.zoom + dir * 0.5))
  t.webview.setZoomLevel(t.zoom)
  // wie in Chrome pro Website merken (im privaten Space nur vorübergehend)
  if (!isPrivateTab(t) && /^(https?|file):/.test(t.url)) setSiteCfg(t.url, 'zoom', t.zoom)
  const pct = Math.round(Math.pow(1.2, t.zoom) * 100)
  $$('.toast[data-zoom]').forEach(x => x.remove())
  toast(`${T('Zoom')} ${pct} %`, 'Strg+0 setzt zurück', 'zoomIn', { duration: 1400 })
  $('#toasts').lastChild.dataset.zoom = '1'
}

function devtools () {
  const t = activeTab()
  if (!t?.ready) return
  if (t.webview.isDevToolsOpened()) t.webview.closeDevTools()
  else t.webview.openDevTools()
}

function toggleFullscreen () {
  A.send('ui:fullscreen', !S.windowFull)
}

function sleepAll () {
  for (const t of S.tabs.values()) if (!isVisible(t) && !t.audible && !S.agentTabs.has(t.wcId)) sleepTab(t)
}

function cycleTab (dir) {
  const sp = curSpace()
  const ids = sp.tabIds
  if (ids.length < 2) return
  const i = ids.indexOf(sp.activeId)
  activate(ids[(i + dir + ids.length) % ids.length])
}

// Über den Hauptprozess, damit Fehlerseiten die fehlgeschlagene Adresse überspringen
function goBack () { const t = activeTab(); if (t?.ready && t.webview.canGoBack()) A.send('tab:back', t.wcId) }
function goForward () { const t = activeTab(); if (t?.ready && t.webview.canGoForward()) t.webview.goForward() }
function reload (hard) {
  const t = activeTab()
  if (!t) return
  if (!t.ready) return
  if (t.loading && !hard) return t.webview.stop()
  hard ? t.webview.reloadIgnoringCache() : t.webview.reload()
}

const SHORTCUT_ACTIONS = {
  'Ctrl+T': () => { createTab(); setTimeout(focusOmnibox, 50) },
  'Ctrl+W': () => { const t = activeTab(); if (t) closeTab(t.id) },
  'Ctrl+Shift+T': reopenClosed,
  'Ctrl+L': focusOmnibox,
  'Ctrl+K': () => $('#palette').hidden ? openPalette() : closePalette(),
  'Ctrl+Tab': () => cycleTab(1),
  'Ctrl+Shift+Tab': () => cycleTab(-1),
  'Ctrl+R': () => reload(false),
  F5: () => reload(false),
  'Ctrl+Shift+R': () => reload(true),
  'Ctrl+F': openFind,
  F12: devtools,
  'Ctrl+Shift+I': devtools,
  'Ctrl+Shift+S': toggleSplit,
  'Ctrl+D': toggleBookmark,
  'Ctrl++': () => zoom(1),
  'Ctrl+=': () => zoom(1),
  'Ctrl+-': () => zoom(-1),
  'Ctrl+0': () => zoom(0),
  'Alt+ArrowLeft': goBack,
  'Alt+ArrowRight': goForward,
  F11: toggleFullscreen,
  'Ctrl+H': () => togglePanel('history'),
  'Ctrl+J': () => togglePanel('downloads'),
  'Ctrl+B': toggleSidebar,
  F9: toggleReader,
  'Ctrl+Shift+F': () => S.focus.active ? openFocusPopover() : startFocus(settings().focusMinutes),
  'Ctrl+Shift+X': screenshot,
  'Ctrl+Shift+N': () => openPrivate(),
  'Ctrl+Shift+U': () => togglePanel('notes'),
  'Ctrl+S': savePage,
  'Ctrl+O': openFile,
  'Ctrl+U': () => { const t = activeTab(); if (t && /^(https?|file):/.test(t.url)) createTab({ url: sourceUrl(t.url), spaceId: t.spaceId, afterId: t.id }) },
  'Ctrl+G': () => findAgain(true),
  F3: () => findAgain(true),
  'Ctrl+Shift+G': () => findAgain(false),
  'Shift+F3': () => findAgain(false),
  'Ctrl+Shift+Delete': () => openSettings('privacy'),
  'Ctrl+PageDown': () => cycleTab(1),
  'Ctrl+PageUp': () => cycleTab(-1),
  'Ctrl+F4': () => { const t = activeTab(); if (t) closeTab(t.id) },
  'Ctrl+Shift+B': toggleSidebar,
  'Alt+Home': () => { const t = activeTab(); if (t) loadInTab(t, NEWTAB) },
  F6: focusOmnibox,
  'Ctrl+Shift+A': () => $('#palette').hidden ? openPalette() : closePalette(),
  'Ctrl+Shift+E': () => togglePanel('extensions'),
  'Ctrl+P': () => activeTab()?.ready && activeTab().webview.print(),
  'Ctrl+,': () => openSettings(),
  'Ctrl+E': () => toggleDock(),
  'Ctrl+Shift+L': () => sendPageToClaude('context'),
  Escape: () => closeTopLayer()
}

function handleShortcut (combo) {
  const m = /^(Ctrl|Alt)\+([1-9])$/.exec(combo)
  if (m) {
    const n = +m[2]
    if (m[1] === 'Ctrl') {
      const ids = curSpace().tabIds
      const id = n === 9 ? ids[ids.length - 1] : ids[n - 1]
      if (id) activate(id)
    } else if (S.spaces[n - 1]) switchSpace(S.spaces[n - 1].id)
    return
  }
  SHORTCUT_ACTIONS[combo]?.()
}

function closeTopLayer () {
  if (!$('#menu').hidden) return hideMenu()
  if (!$('#popover').hidden) return hidePopover()
  if (!$('#palette').hidden) return closePalette()
  if (!$('#modal').hidden) return closeModal()
  if (S.peek) return closePeek()
  if (!$('#findbar').hidden) return $('#find-close').click()
  if (S.reader) return closeReader()
  if (S.panel) return closePanel()
}

/* ---------------------------------------------------------------------
   Berechtigungen & Downloads
   --------------------------------------------------------------------- */

function showNextPermission () {
  const box = $('#perm')
  const p = S.perms[0]
  if (!p) { box.hidden = true; return }
  const what = {
    media: p.mediaTypes.includes('video') && p.mediaTypes.includes('audio') ? 'möchte deine Kamera und dein Mikrofon verwenden.' : p.mediaTypes.includes('video') ? 'möchte deine Kamera verwenden.' : 'möchte dein Mikrofon verwenden.',
    geolocation: 'möchte deinen Standort abrufen.',
    notifications: 'möchte dir Benachrichtigungen senden.',
    'clipboard-read': 'möchte deine Zwischenablage lesen.',
    'display-capture': 'möchte deinen Bildschirm aufnehmen.',
    openExternal: 'möchte eine externe Anwendung öffnen.',
    midi: 'möchte MIDI-Geräte verwenden.',
    midiSysex: 'möchte MIDI-Geräte steuern.',
    'idle-detection': 'möchte erkennen, ob du aktiv bist.',
    'storage-access': 'möchte auf gespeicherte Daten zugreifen.',
    'top-level-storage-access': 'möchte auf gespeicherte Daten zugreifen.'
  }[p.permission] || 'möchte die Berechtigung „{name}“ nutzen.'
  const ic = { media: 'camera', geolocation: 'globe', notifications: 'info', openExternal: 'external' }[p.permission] || 'shield'
  box.innerHTML = `<div class="p-head"><div class="t-ico">${icon(ic)}</div><div><div class="p-origin">${esc(p.origin.replace(/^https?:\/\//, ''))}</div><div class="muted">${esc(T(what, { name: p.permission }))}</div></div></div>
    <div class="p-foot"><label><input type="checkbox" id="perm-remember" checked> ${T('Entscheidung merken')}</label><button class="btn ghost sm" data-p="0">${T('Blockieren')}</button><button class="btn sm" data-p="1">${T('Zulassen')}</button></div>`
  box.hidden = false
  box.onclick = e => {
    const b = e.target.closest('[data-p]'); if (!b) return
    const allow = b.dataset.p === '1'
    const remember = $('#perm-remember').checked
    A.send('perm:respond', p.id, allow, remember) // gespeicherte Liste kommt per „perm:saved“ zurück
    S.perms.shift()
    showNextPermission()
  }
}

/* ---------------------------------------------------------------------
   Initialisierung
   --------------------------------------------------------------------- */

function initToolbar () {
  $('#btn-sidebar').innerHTML = icon('sidebar')
  $('#btn-sidebar').onclick = toggleSidebar
  $('#brand').onclick = () => { if (settings().sidebarCollapsed) toggleSidebar() }
  initTabStrip()
  initFavorites()
  $('#btn-back').innerHTML = icon('back')
  $('#btn-forward').innerHTML = icon('forward')
  $('#btn-back').onclick = goBack
  $('#btn-forward').onclick = goForward
  $('#btn-reload').onclick = () => reload(false)
  $('#btn-reader').innerHTML = icon('reader')
  $('#btn-reader').onclick = toggleReader
  $('#btn-star').onclick = toggleBookmark
  $('#btn-adblock').onclick = () => S.popover === 'adblock' ? hidePopover() : openAdblockPopover()
  $('#btn-popup').onclick = openPopupPopover
  $('#btn-translate').onclick = openTranslatePopover
  $('#omni-site').onclick = openSitePopover
  $('#btn-vpn').onclick = () => S.popover === 'vpn' ? hidePopover() : openVpnPopover()
  $('#btn-split').innerHTML = icon('split')
  $('#btn-split').onclick = toggleSplit
  $('#btn-cast').innerHTML = icon('cast')
  $('#btn-cast').onclick = () => S.popover === 'cast' ? hidePopover() : openCast()
  $('#btn-focus').innerHTML = icon('focus')
  $('#btn-focus').onclick = () => S.popover === 'focus' ? hidePopover() : openFocusPopover()
  $('#focus-hud').onclick = openFocusPopover
  $('#btn-menu').innerHTML = icon('dots')
  $('#btn-menu').onclick = appMenu
  $('#btn-newtab .nt-plus').innerHTML = icon('plus')
  $('#btn-newtab').onclick = () => { createTab(); setTimeout(focusOmnibox, 50) }
  $('#panel-close').innerHTML = icon('x')
  $('#panel-close').onclick = closePanel
}

// Beim Schließen des Fensters alle noch ausstehenden Speichervorgänge sofort ausführen
function flushPending () {
  for (const [key, t] of Object.entries(saveTimers)) {
    clearTimeout(t)
    A.send('store:set', key, S.data[key])
  }
  if (saveSession.t) {
    clearTimeout(saveSession.t)
    writeSession({ refresh: false })
  }
}

function initGlobalEvents () {
  document.addEventListener('mousedown', e => {
    if (!$('#menu').hidden && !e.target.closest('#menu')) hideMenu()
    if (!$('#popover').hidden && !e.target.closest('#popover') && !e.target.closest('#btn-cast, #btn-focus, #btn-adblock, #btn-vpn, #focus-hud, #btn-star, #btn-popup, #btn-translate, #omni-site')) hidePopover()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeTopLayer()
  })
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal() })
  window.addEventListener('blur', closeFloating)
  window.addEventListener('beforeunload', flushPending)
  window.addEventListener('resize', closeFloating)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings().theme === 'system') applyTheme() })
  document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/uri-list')) e.preventDefault() })
  document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() })
  document.addEventListener('drop', async e => {
    // Dateien aus dem Explorer (HTML, PDF, Bilder …) in neuen Tabs öffnen
    if (e.dataTransfer.files?.length) {
      e.preventDefault()
      for (const f of e.dataTransfer.files) {
        const url = await A.invoke('app:file-url', A.pathForFile(f)).catch(() => null)
        if (url) createTab({ url })
      }
      return
    }
    const url = e.dataTransfer.getData('text/uri-list')
    if (url) { e.preventDefault(); createTab({ url }) }
  })

  A.on('shortcut', handleShortcut)
  A.on('open-tab', ({ url, background, opener }) => {
    const openerTab = opener ? tabByWc(opener) : null
    createTab({ url, background: !!background, spaceId: openerTab?.spaceId || normalSpaceId(), afterId: openerTab?.id })
  })
  A.on('ctx-action', ({ wcId, action, url, text, prompt }) => {
    const t = tabByWc(wcId)
    if (t && t.id !== curSpace().activeId && t.spaceId === S.activeSpace && action !== 'peek') activate(t.id)
    if (action === 'peek') openPeek(url)
    if (action === 'split') openInSplit(url)
    if (action === 'reader') toggleReader()
    if (action === 'screenshot') screenshot()
    if (action === 'cast') openCast(url)
    if (action === 'note') addNoteText(text)
    if (action === 'claude-selection') sendSelectionToClaude(text, prompt)
    if (action === 'claude-page') sendPageToClaude(prompt)
    if (action === 'markdown') copyPageAsMarkdown()
    if (action === 'private') openPrivate(url)
    if (action === 'translate') openTranslatePopover()
    if (action === 'save-page') savePage()
  })
  A.on('ext:create-tab', async ({ reqId, url, active }) => {
    const t = createTab({ url: url || NEWTAB, background: !active, spaceId: normalSpaceId() })
    await whenReady(t)
    A.send('ui:reply', reqId, t.wcId)
  })
  A.on('ext:select-tab', wcId => { const t = tabByWc(wcId); if (t) activate(t.id) })
  A.on('ext:remove-tab', wcId => { const t = tabByWc(wcId); if (t) closeTab(t.id) })
  A.on('ext:changed', () => { if (S.panel === 'extensions') renderPanel() })
  A.on('adblock:blocked', ({ wcId, count, total }) => {
    S.adblockTotal = S.adblockBase + total
    const t = tabByWc(wcId)
    if (!t) return
    t.blocked = count
    if (t === activeTab()) updateAdblockChip()
  })
  A.on('adblock:status', st => {
    if (st.status === 'error') toast('Werbeblocker', T('Filterlisten konnten nicht geladen werden: {error}', { error: st.error }), 'warning', { duration: 7000 })
  })
  A.on('vpn:state', st => {
    const prev = S.vpn?.status
    S.vpn = st
    updateVpnPill()
    if (S.popover === 'vpn') renderVpnPopover()
    if (prev !== 'on' && st.status === 'on') toast('VPN verbunden', st.label, 'vpn')
    if (prev === 'connecting' && st.status === 'error') toast('VPN-Verbindung fehlgeschlagen', st.error, 'warning', { duration: 8000 })
  })
  A.on('crx:tabgroups', groups => {
    S.tabGroups = groups
    for (const t of S.tabs.values()) updateTabEl(t)
  })
  A.on('crx:debugger', ({ tabId, attached }) => {
    if (attached) S.agentTabs.add(tabId); else S.agentTabs.delete(tabId)
    const t = tabByWc(tabId)
    if (t) t.lastActive = Date.now() // nach der Arbeit des Agenten volle Frist bis zum Tab-Schlaf
    if (t) updateTabEl(t)
  })
  // Anfragen des eingebauten MCP-Servers (Claude Code). Tab-IDs = Tab-Nummern der Oberfläche.
  A.on('mcp:ui', async ({ reqId, op, id, url, background }) => {
    const reply = v => A.send('ui:reply', reqId, v)
    // Tabs des privaten Spaces bleiben für Agenten unsichtbar
    const byNum = n => { const t = S.tabs.get('t' + n); return t && !isPrivateTab(t) ? t : null }
    const missing = n => ({ error: T('Tab {n} existiert nicht. Mit list_tabs die aktuellen IDs abrufen.', { n }) })
    try {
      if (op === 'tabs') {
        return reply([...S.tabs.values()].filter(t => !isPrivateTab(t)).map(t => ({
          id: +t.id.slice(1), title: t.title, url: displayUrl(t.url) || T('Neuer Tab'),
          active: t.id === curSpace().activeId, sleeping: t.sleeping, space: space(t.spaceId)?.name
        })))
      }
      if (op === 'resolve') {
        const t = id ? byNum(id) : activeTab()
        if (!t || isPrivateTab(t)) return reply(id ? missing(id) : { error: T('Kein aktiver Tab.') })
        if (!t.webview) wake(t)
        await whenReady(t)
        return reply(t.wcId)
      }
      if (op === 'open') {
        const t = createTab({ url, background: !!background, spaceId: normalSpaceId() })
        await whenReady(t)
        return reply(+t.id.slice(1))
      }
      if (op === 'select') {
        const t = byNum(id)
        if (!t) return reply(missing(id))
        activate(t.id)
        await whenReady(t)
        return reply(true)
      }
      if (op === 'close') {
        const t = byNum(id)
        if (!t) return reply(missing(id))
        closeTab(t.id)
        return reply(true)
      }
      reply({ error: T('Unbekannte Anfrage') })
    } catch (err) { reply({ error: err.message }) }
  })
  A.on('crx:sidepanel-open', info => openExtPanel(info))
  A.on('crx:sidepanel-close', ({ extId, tabId }) => closeExtPanel(extId, tabId, false))
  A.on('dl:update', d => {
    const isNew = !S.downloads.has(d.id)
    const prev = S.downloads.get(d.id)
    S.downloads.set(d.id, d)
    // Abgeschlossene Downloads merken (wie chrome://downloads), private nicht
    if (d.state !== 'progressing' && !d.private) {
      const key = `${d.started}|${d.path}`
      const hist = (S.data.downloadHistory || []).filter(h => h.key !== key)
      hist.unshift({ key, name: d.name, url: d.url, path: d.path, total: d.total || d.received, state: d.state, started: d.started })
      S.data.downloadHistory = hist.slice(0, 200)
      save('downloadHistory')
    }
    if (isNew) {
      toast('Download gestartet', d.name, 'download', { actions: [{ label: 'Anzeigen', run: () => togglePanel('downloads') }] })
      // Tab, der nur für diesen Download geöffnet wurde, wieder schließen (wie in Chrome)
      // Hatte der Tab schon eine Seite, bleibt er dort stehen – nur die Adresse wird zurückgesetzt
      const t = d.wcId && tabByWc(d.wcId)
      if (t && t.url === d.url) {
        const shown = d.pageUrl || ''
        if (!shown || shown === 'about:blank' || shown === d.url) closeTab(t.id)
        else {
          t.url = shown
          updateTabEl(t)
          if (t === activeTab()) { updateOmnibox(); updateNav() }
        }
      }
    }
    if (prev?.state === 'progressing' && d.state === 'completed') {
      toast('Download abgeschlossen', d.name, 'check', { actions: [{ label: 'Öffnen', run: () => A.send('dl:open', d.path) }], duration: 6000 })
    }
    if (S.panel === 'downloads') renderPanel()
    updateDownloadDot()
  })
  A.on('perm:request', p => { S.perms.push(p); if (S.perms.length === 1) showNextPermission() })
  A.on('perm:saved', perms => { S.data.permissions = perms })
  A.on('tab:audible', ({ wcId, audible }) => {
    const t = tabByWc(wcId)
    if (t && t.audible !== audible) { t.audible = audible; updateTabEl(t) }
  })
  A.on('popup:blocked', ({ wcId, urls }) => {
    const t = tabByWc(wcId)
    if (!t) return
    const isNew = !t.blockedPopups.length
    t.blockedPopups = urls
    if (t === activeTab()) {
      updatePopupButton()
      if (isNew) $('#btn-popup').animate([{ transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 350 })
    }
  })
  A.on('device:pick', openDevicePicker)
  A.on('device:update', ({ reqId, devices }) => {
    if (S.devicePick?.reqId !== reqId) return
    S.devicePick.devices = devices
    S.devicePick.render?.()
  })
  A.on('cert:override', host => { S.certOverrides.add(host); updateOmnibox() })
  A.on('pw:offer', offerPassword)
  A.on('update:state', st => {
    S.update = st
    if (S.modalSection === 'about') renderUpdateBox()
    if (st.status === 'ready' && S.updateNotified !== st.version) {
      S.updateNotified = st.version
      toast(T('Update auf Caravel {v} bereit', { v: st.version }), 'Wird beim nächsten Beenden installiert.', 'refresh', {
        duration: 15000,
        actions: [{ label: 'Jetzt neu starten', run: () => { flushPending(); A.send('update:install') } }]
      })
    }
  })
  A.on('cast:devices', devs => {
    S.cast.devices = devs
    if (devs.length) S.cast.scanning = false
    refreshCast()
  })
  A.on('cast:sessions', list => {
    S.cast.sessions = list
    $('#btn-cast').classList.toggle('on', list.length > 0)
    refreshCast()
  })
  A.on('cast:ended', ({ deviceId, reason }) => {
    if (S.cast.mirror?.deviceId === deviceId) stopMirror()
    if (reason === 'closed') toast('Streamen beendet', 'Die Verbindung zum Gerät wurde getrennt.', 'cast')
  })
  // Cast-Knopf einer Webseite (z. B. im YouTube-Player): Gerät auswählen
  A.on('cast:pick', req => {
    const t = tabByWc(req.wcId)
    if (t && t.spaceId === S.activeSpace && t.id !== curSpace().activeId) activate(t.id)
    openCast({ request: req })
  })
  A.on('ntp:bookmark', handleNtpBookmark)
  A.on('cast:error', msg => toast('Streamen fehlgeschlagen', msg, 'warning', { duration: 7000 }))
  A.on('window-fullscreen', on => { S.windowFull = on })
}

function startSleepTimer () {
  setInterval(() => {
    const min = +settings().sleepMinutes
    if (!min) return
    const limit = Date.now() - min * 60000
    for (const t of S.tabs.values()) {
      if (t.webview && !t.audible && !isVisible(t) && t.lastActive < limit && t !== S.cast.mirror?.tab && !S.agentTabs.has(t.wcId)) sleepTab(t)
    }
  }, 30000)
}

async function boot () {
  // Sprache zuerst festlegen, damit schon die ersten Texte stimmen
  try { I18N.setLang(await A.invoke('app:lang')) } catch {}
  I18N.translateDom(document.body)
  S.data = await A.invoke('store:all')
  S.data.focusStats = S.data.focusStats || { sessions: 0, minutes: 0 }
  S.adblockBase = S.data.stats?.blocked || 0
  S.adblockTotal = S.adblockBase
  try { S.newtabOverride = await A.invoke('ext:newtab-override') } catch {}
  try { S.vpn = await A.invoke('vpn:state'); S.vpnCountries = S.vpn.countries } catch {}

  applyTheme()
  applyTabLayout()
  initToolbar()
  initOmnibox()
  initFind()
  initPeek()
  initDivider()
  initDock()
  initGlobalEvents()
  updateVpnPill()

  for (const s of S.data.spaces) {
    const sp = { id: s.id, name: s.name, color: s.color, icon: s.icon, tabIds: [], activeId: null, split: null }
    S.spaces.push(sp)
    if (settings().restoreSession) {
      for (const t of s.tabs || []) {
        createTab({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, spaceId: sp.id, sleeping: true, silent: true, nav: t.nav || null })
      }
      sp.activeId = sp.tabIds[s.activeIndex] || sp.tabIds[0] || null
    }
  }
  if (!S.spaces.length) S.spaces.push({ id: 'space-personal', name: T('Persönlich'), color: '#f2545b', icon: '✦', tabIds: [], activeId: null, split: null })
  const start = space(S.data.activeSpace) ? S.data.activeSpace : S.spaces[0].id
  S.activeSpace = start
  renderSbTools()
  switchSpace(start, { initial: true })
  startSleepTimer()
  A.send('ui:ready')
  requestAnimationFrame(() => document.body.classList.remove('booting'))

  if (!S.data.history.length && !localStorage.getItem('caravel-welcomed')) {
    try { localStorage.setItem('caravel-welcomed', '1') } catch {}
    setTimeout(() => toast('Willkommen bei Caravel', 'Strg+K öffnet die Befehlspalette, Strg+E die KI-Seitenleiste (Claude oder ChatGPT – unter Einstellungen › KI-Assistent wählbar).', 'sparkles', { duration: 8000 }), 900)
  }
}

boot()
