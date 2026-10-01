'use strict'
/* =====================================================================
   Caravel – Browser-Oberfläche
   ===================================================================== */

const A = window.caravel
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const PARTITION = 'persist:caravel'
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
  cast: { devices: [], status: null, selected: null, preset: null, media: null },
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
  popover: null
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
  let src = favicon
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
  if (d < 60) return 'gerade eben'
  if (d < 3600) return `vor ${Math.floor(d / 60)} Min.`
  if (d < 86400) return `vor ${Math.floor(d / 3600)} Std.`
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
}

function fmtBytes (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)))
  return (n / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',') + ' ' + u[i]
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
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|view-source|data|mailto):/i.test(t)) return t
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

function displayUrl (url) {
  if (!url || isNewtab(url)) return ''
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
const tabByWc = wcId => [...S.tabs.values()].find(t => t.wcId === wcId)
const spaceTabs = sp => sp.tabIds.map(getTab).filter(Boolean)

function createTab ({ url = null, spaceId = S.activeSpace, background = false, pinned = false, sleeping = false, title, favicon, afterId, silent = false } = {}) {
  const sp = space(spaceId) || curSpace()
  const tab = {
    id: 't' + (++tabSeq),
    spaceId: sp.id,
    url: url || NEWTAB,
    title: title || (url ? hostOf(url) || url : 'Neuer Tab'),
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

function wake (tab) {
  if (tab.webview) return
  const wv = document.createElement('webview')
  wv.setAttribute('partition', PARTITION)
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('src', resolveLoadUrl(tab.url))
  wv.dataset.tab = tab.id
  tab.webview = wv
  tab.sleeping = false
  tab.ready = false
  bindWebview(tab, wv)
  $('#views').append(wv)
  updateTabEl(tab)
}

function sleepTab (tab) {
  if (!tab.webview || isVisible(tab)) return
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
      if (tab.zoom) wv.setZoomLevel(tab.zoom)
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
    if (isNewtab(url)) { tab.title = 'Neuer Tab'; tab.favicon = null; tab.themeColor = null }
    recordHistory(tab)
    updateTabEl(tab)
    if (isActive()) { updateNav(); updateOmnibox(); updateAmbient() }
    if (S.panel === 'notes' && isActive()) renderPanel()
    saveSession()
  }
  wv.addEventListener('did-navigate', e => {
    tab.blocked = 0
    tab.themeColor = null
    onNav(e.url)
  })
  wv.addEventListener('did-navigate-in-page', e => { if (e.isMainFrame) onNav(e.url) })
  wv.addEventListener('page-title-updated', e => {
    tab.title = e.title
    const h = S.data.history[0]
    if (h && h.url === tab.url) { h.title = e.title; save('history') }
    updateTabEl(tab)
    if (isActive()) document.title = `${e.title} – Caravel`
    saveSession()
  })
  wv.addEventListener('page-favicon-updated', e => {
    tab.favicon = e.favicons?.[0] || null
    updateTabEl(tab)
    saveSession()
  })
  wv.addEventListener('did-fail-load', e => {
    if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === -20) return
    const target = `caravel://error/?code=${e.errorCode}&desc=${encodeURIComponent(e.errorDescription)}&url=${encodeURIComponent(e.validatedURL)}`
    setTimeout(() => wv.loadURL(target).catch(() => {}), 0)
  })
  wv.addEventListener('render-process-gone', () => {
    tab.loading = false
    const target = `caravel://error/?code=crash&desc=${encodeURIComponent('Die Seite ist abgestürzt')}&url=${encodeURIComponent(tab.url)}`
    setTimeout(() => wv.loadURL(target).catch(() => {}), 50)
  })
  wv.addEventListener('media-started-playing', () => { tab.audible = true; updateTabEl(tab) })
  wv.addEventListener('media-paused', () => { tab.audible = false; updateTabEl(tab) })
  wv.addEventListener('ipc-message', e => {
    if (e.channel === 'peek') openPeek(e.args[0])
    if (e.channel === 'theme-color') {
      tab.themeColor = e.args[0]
      if (isActive()) updateAmbient()
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
  if (!isNewtab(tab.url)) {
    S.closed.push({ url: tab.url, title: tab.title, favicon: tab.favicon, spaceId: sp.id })
    if (S.closed.length > 25) S.closed.shift()
  }
  sp.tabIds.splice(idx, 1)
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
  createTab({ url: t.url, title: t.title, favicon: t.favicon, spaceId: space(t.spaceId) ? t.spaceId : S.activeSpace })
}

function duplicateTab (tab) {
  createTab({ url: tab.url, title: tab.title, favicon: tab.favicon, spaceId: tab.spaceId, afterId: tab.id })
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
  toast(`In „${to.name}“ verschoben`, tab.title, 'layers')
}

function saveSession () {
  clearTimeout(saveSession.t)
  saveSession.t = setTimeout(writeSession, 600)
}

function writeSession () {
  saveSession.t = null
  S.data.spaces = S.spaces.map(sp => ({
    id: sp.id,
    name: sp.name,
    color: sp.color,
    icon: sp.icon,
    activeIndex: Math.max(0, sp.tabIds.indexOf(sp.activeId)),
    tabs: spaceTabs(sp).map(t => ({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned }))
  }))
  S.data.activeSpace = S.activeSpace
  A.send('store:set', 'spaces', S.data.spaces)
  A.send('store:set', 'activeSpace', S.activeSpace)
}

function recordHistory (tab) {
  const url = tab.url
  if (!/^(https?|file):/.test(url)) return
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
  if (S.spaces.length <= 1) return toast('Nicht möglich', 'Mindestens ein Space wird benötigt.', 'info')
  for (const t of spaceTabs(sp)) { t.webview?.remove(); S.tabs.delete(t.id) }
  S.spaces = S.spaces.filter(s => s !== sp)
  if (S.activeSpace === sp.id) switchSpace(S.spaces[0].id)
  renderSpaces()
  saveSession()
}

function editSpaceDialog (sp) {
  const isNew = !sp
  let color = sp?.color || SPACE_COLORS[S.spaces.length % SPACE_COLORS.length]
  let ic = sp?.icon || SPACE_ICONS[S.spaces.length % SPACE_ICONS.length]
  showModal(`
    <div class="modal-head"><h2>${isNew ? 'Neuer Space' : 'Space bearbeiten'}</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">Spaces sind getrennte Arbeitsbereiche mit eigenen Tabs, eigener Farbe und eigener Zeitkapsel.</p>
      <div class="field"><label>Name</label><input class="input" id="sp-name" value="${esc(sp?.name || '')}" placeholder="z. B. Uni, Projekt, Freizeit"></div>
      <div class="field"><label>Symbol</label><div class="swatches" id="sp-icons">${SPACE_ICONS.map(i => `<button class="space-btn ${i === ic ? 'active' : ''}" style="--sc:${color}" data-i="${i}">${i}</button>`).join('')}</div></div>
      <div class="field"><label>Farbe</label><div class="swatches" id="sp-colors">${SPACE_COLORS.map(c => `<button class="swatch ${c === color ? 'on' : ''}" style="--c:${c}" data-c="${c}"></button>`).join('')}</div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>Abbrechen</button><button class="btn" id="sp-save">${isNew ? 'Space erstellen' : 'Speichern'}</button></div>`)
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
  const submit = () => {
    const name = $('#sp-name').value.trim() || 'Space'
    closeModal()
    if (isNew) addSpace({ name, color, icon: ic })
    else { Object.assign(sp, { name, color, icon: ic }); applyAccent(); renderSpaces(); saveSession() }
  }
  $('#sp-save').onclick = submit
  card.addEventListener('keydown', e => { if (e.key === 'Enter') submit() })
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
    L.webview.classList.add('visible', 'split-left')
    L.webview.style.width = `calc(${r * 100}% - 4px)`
    R.webview.classList.add('visible', 'split-right')
    R.webview.style.width = `calc(${(1 - r) * 100}% - 4px)`
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

function renderFavorites () {
  const box = $('#favorites')
  box.innerHTML = ''
  const cur = activeTab()
  for (const bm of S.data.bookmarks.slice(0, 8)) {
    const el = document.createElement('div')
    el.className = 'fav'
    el.title = bm.title
    if (cur && hostOf(cur.url) === hostOf(bm.url)) el.classList.add('active')
    el.append(faviconEl(bm.favicon, bm.url, 20))
    const label = document.createElement('span')
    label.className = 'fav-label' // nur in der Favoritenleiste (Chrome/Safari) sichtbar
    label.textContent = bm.title || hostOf(bm.url)
    el.append(label)
    el.onclick = () => openBookmark(bm)
    el.oncontextmenu = e => showMenu(e.clientX, e.clientY, [
      { label: 'In neuem Tab öffnen', icon: 'plus', run: () => createTab({ url: bm.url }) },
      { label: 'Peek-Vorschau', icon: 'eye', run: () => openPeek(bm.url) },
      { label: 'In Split View öffnen', icon: 'split', run: () => openInSplit(bm.url) },
      '-',
      { label: 'Aus Favoriten entfernen', icon: 'trash', danger: true, run: () => removeBookmark(bm.url) }
    ])
    box.append(el)
  }
  box.hidden = S.data.bookmarks.length === 0
}

function openBookmark (bm) {
  const sp = curSpace()
  const existing = spaceTabs(sp).find(t => hostOf(t.url) === hostOf(bm.url))
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
    list.insertAdjacentHTML('beforeend', '<div class="tab-section">Angeheftet</div>')
    pinned.forEach(t => list.append(tabEl(t)))
    list.insertAdjacentHTML('beforeend', '<div class="tab-section">Tabs</div>')
  }
  normal.forEach(t => list.append(tabEl(t)))
  renderFavorites()
}

function tabEl (tab) {
  const el = document.createElement('div')
  el.className = 'tab'
  el.draggable = true
  el.dataset.id = tab.id
  el.innerHTML = `<span class="fav-ico"></span><span class="title"></span><span class="badge audio"></span><span class="badge state"></span><button class="close" title="Tab schließen (Strg+W)">${icon('x')}</button>`
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
  else fav.append(faviconEl(tab.favicon, tab.url))
  $('.title', el).textContent = tab.title || prettyUrl(tab.url) || 'Neuer Tab'
  el.title = `${tab.title}\n${displayUrl(tab.url) || 'Neuer Tab'}${tab.sleeping ? '\n💤 Schläft – spart Arbeitsspeicher' : ''}`
  $('.audio', el).innerHTML = tab.audible || tab.muted ? icon(tab.muted ? 'mute' : 'volume') : ''
  $('.audio', el).title = tab.muted ? 'Ton an' : 'Stummschalten'
  const agent = tab.wcId && S.agentTabs.has(tab.wcId)
  const state = $('.state', el)
  state.classList.toggle('agent', !!agent)
  state.title = agent ? 'Ein KI-Agent steuert diesen Tab' : ''
  state.innerHTML = agent ? icon('agent') : tab.sleeping ? icon('zzz') : tab.pinned ? `<span class="pin-dot">${icon('pin')}</span>` : ''
  const group = tab.wcId && S.tabGroups[tab.wcId]
  let bar = $('.group-bar', el)
  if (group) {
    if (!bar) { bar = document.createElement('span'); el.prepend(bar) }
    bar.className = `group-bar tg-${group.color}`
    bar.title = group.title ? `Gruppe „${group.title}“` : 'Tab-Gruppe'
  } else if (bar) bar.remove()
}

function tabMenu (e, tab) {
  const sp = space(tab.spaceId)
  const others = S.spaces.filter(s => s !== sp)
  const items = [
    { label: 'Neu laden', icon: 'reload', run: () => { if (tab.ready) tab.webview.reload(); else activate(tab.id) } },
    { label: 'Duplizieren', icon: 'copy', run: () => duplicateTab(tab) },
    { label: tab.pinned ? 'Loslösen' : 'Anheften', icon: 'pin', run: () => togglePin(tab) },
    { label: tab.muted ? 'Ton einschalten' : 'Stummschalten', icon: tab.muted ? 'volume' : 'mute', run: () => toggleMute(tab) },
    { label: 'Neben aktivem Tab (Split View)', icon: 'split', hint: 'Umschalt+Klick', run: () => splitWith(tab.id), hidden: tab.id === sp.activeId },
    { label: 'Schlafen legen', icon: 'zzz', run: () => sleepTab(tab), hidden: tab.sleeping || isVisible(tab) },
    ...(others.length ? ['-', ...others.map(o => ({ label: `Nach „${o.name}“ verschieben`, icon: 'layers', run: () => moveTabToSpace(tab, o.id) }))] : []),
    '-',
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
    b.className = 'space-btn' + (sp.id === S.activeSpace ? ' active' : '')
    b.style.setProperty('--sc', sp.color)
    b.textContent = sp.icon
    b.title = `${sp.name} (Alt+${i + 1})`
    b.onclick = () => switchSpace(sp.id)
    b.oncontextmenu = e => showMenu(e.clientX, e.clientY, [
      { label: 'Bearbeiten …', icon: 'settings', run: () => editSpaceDialog(sp) },
      { label: 'Zeitkapsel speichern', icon: 'archive', run: () => saveSnapshot(sp) },
      { label: 'Alle Tabs schlafen legen', icon: 'zzz', run: () => spaceTabs(sp).forEach(sleepTab) },
      '-',
      { label: 'Space löschen', icon: 'trash', danger: true, run: () => confirmDialog(`„${sp.name}“ löschen?`, 'Alle Tabs dieses Spaces werden geschlossen. Tipp: Speichere vorher eine Zeitkapsel.', 'Löschen', () => deleteSpace(sp)) }
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
  add.title = 'Neuer Space'
  add.onclick = () => editSpaceDialog(null)
  box.append(add)
}

function renderSbTools () {
  const tools = [
    ['history', 'history', 'Verlauf (Strg+H)'],
    ['downloads', 'download', 'Downloads (Strg+J)'],
    ['notes', 'note', 'Seiten-Notizen (Strg+Umschalt+N)'],
    ['snapshots', 'archive', 'Zeitkapseln'],
    ['extensions', 'puzzle', 'Erweiterungen (Strg+Umschalt+E)']
  ]
  const box = $('#sb-tools')
  box.innerHTML = ''
  for (const [panel, ic, title] of tools) {
    const b = document.createElement('button')
    b.className = 'icon-btn' + (S.panel === panel ? ' on' : '')
    b.dataset.panel = panel
    b.title = title
    b.innerHTML = icon(ic)
    b.onclick = () => togglePanel(panel)
    box.append(b)
  }
  const s = document.createElement('button')
  s.className = 'icon-btn'
  s.title = 'Einstellungen (Strg+,)'
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
    favbar.append(favs)
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
  $('#btn-reload').title = t?.loading ? 'Laden abbrechen' : 'Neu laden (F5)'
  updateAdblockChip()
  const bm = t && S.data.bookmarks.some(b => b.url === t.url)
  $('#btn-star').classList.toggle('on', !!bm)
  $('#btn-star').innerHTML = icon('star')
  $('#btn-reader').classList.toggle('on', !!S.reader)
  $('#btn-reader').hidden = !t || isNewtab(t.url) || !/^https?:/.test(t.url)
  $('#btn-star').hidden = !t || isNewtab(t.url)
  $('#btn-adblock').hidden = !t || !/^https?:/.test(t.url)
}

function updateOmnibox () {
  const t = activeTab()
  const input = $('#omni-input')
  if (document.activeElement !== input) input.value = t ? prettyUrl(t.url) : ''
  const site = $('#omni-site')
  const url = t?.url || ''
  site.className = 'omni-site'
  if (isNewtab(url) || url.startsWith('caravel:')) site.innerHTML = icon('search')
  else if (url.startsWith('https:')) { site.classList.add('secure'); site.innerHTML = icon('lock') }
  else if (url.startsWith('http:')) site.innerHTML = `${icon('warning')}<span class="host-pill">Nicht sicher</span>`
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
  b.title = on ? `Werbeblocker: ${t?.blocked || 0} Anfragen auf dieser Seite blockiert` : 'Werbeblocker ist hier pausiert'
}

function updateAmbient () {
  const t = activeTab()
  const accent = curSpace()?.color || '#f2545b'
  let amb = accent
  if (settings().ambient && t?.themeColor && !isNewtab(t.url) && !t.url.startsWith('caravel:')) amb = t.themeColor
  const dark = isDark()
  const base = toRgb(dark ? '#0a1022' : '#eef1f8')
  const ambRgb = toRgb(amb)
  const toolbar = toHex(mixRgb(base, ambRgb, settings().ambient ? (dark ? 0.13 : 0.12) : 0))
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
      ? { title: q, html: `${esc(q)}`, icon: 'globe', fav: false, tag: 'Öffnen', target }
      : { title: q, html: `${esc(q)}`, icon: 'search', fav: false, tag: `${SEARCH_ENGINES[settings().searchEngine]?.name || 'Google'}-Suche`, target: searchUrl(q) }]
    const ql = q.toLowerCase()
    const seen = new Set()
    for (const t of S.tabs.values()) {
      if (items.length > 3) break
      if (isNewtab(t.url) || t.id === curSpace().activeId) continue
      if ((t.title + ' ' + t.url).toLowerCase().includes(ql)) {
        items.push({ title: t.title, html: hl(t.title, q), url: t.url, favicon: t.favicon, tag: 'Zu Tab wechseln', tabId: t.id })
        seen.add(t.url)
      }
    }
    for (const b of S.data.bookmarks) {
      if (items.length > 5) break
      if (seen.has(b.url)) continue
      if ((b.title + ' ' + b.url).toLowerCase().includes(ql)) {
        items.push({ title: b.title, html: hl(b.title, q), sub: hostOf(b.url), url: b.url, favicon: b.favicon, tag: 'Lesezeichen', target: b.url })
        seen.add(b.url)
      }
    }
    for (const h of S.data.history) {
      if (items.length > 8) break
      if (seen.has(h.url)) continue
      if ((h.title + ' ' + h.url).toLowerCase().includes(ql)) {
        items.push({ title: h.title, html: hl(h.title || h.url, q), sub: hostOf(h.url), url: h.url, tag: 'Verlauf', target: h.url })
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
  input.addEventListener('input', update)
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

function toggleBookmark () {
  const t = activeTab()
  if (!t || isNewtab(t.url)) return
  const i = S.data.bookmarks.findIndex(b => b.url === t.url)
  if (i >= 0) {
    S.data.bookmarks.splice(i, 1)
    toast('Lesezeichen entfernt', t.title, 'star')
  } else {
    S.data.bookmarks.unshift({ id: 'bm-' + Date.now(), url: t.url, title: t.title, favicon: t.favicon })
    toast('Zu Favoriten hinzugefügt', 'Erscheint oben in der Seitenleiste und auf der Startseite.', 'star')
  }
  save('bookmarks')
  renderFavorites()
  updateNav()
}

function removeBookmark (url) {
  S.data.bookmarks = S.data.bookmarks.filter(b => b.url !== url)
  save('bookmarks')
  renderFavorites()
  updateNav()
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
    el.innerHTML = `${icon(it.icon || 'dots')}<span class="m-label">${esc(it.label)}</span>${it.hint ? `<span class="m-hint">${esc(it.hint)}</span>` : ''}`
    el.onclick = () => { hideMenu(); it.run() }
    m.append(el)
  }
  m.hidden = false
  const r = m.getBoundingClientRect()
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px'
}
function hideMenu () { $('#menu').hidden = true }

function showPopover (anchor, html, name) {
  const p = $('#popover')
  p.innerHTML = html
  p.hidden = false
  S.popover = name
  const r = anchor.getBoundingClientRect()
  const w = p.offsetWidth
  p.style.top = (r.bottom + 8) + 'px'
  p.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'
  return p
}
function hidePopover () { $('#popover').hidden = true; S.popover = null }

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
function closeModal () { $('#modal').hidden = true; $('#modal-card').innerHTML = '' }

function confirmDialog (title, text, okLabel, onOk) {
  showModal(`<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-body"><p class="muted" style="margin:0">${esc(text)}</p></div><div class="modal-foot"><button class="btn ghost" data-close>Abbrechen</button><button class="btn danger" id="cf-ok">${esc(okLabel)}</button></div>`)
  $('#cf-ok').onclick = () => { closeModal(); onOk() }
}

function toast (title, text = '', ic = 'info', { actions = [], image = null, duration = 3600 } = {}) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = `${image ? `<img class="shot" src="${esc(image)}">` : `<div class="t-ico">${icon(ic)}</div>`}<div class="t-body"><div class="t-title">${esc(title)}</div>${text ? `<div class="t-text">${esc(text)}</div>` : ''}</div>`
  for (const a of actions) {
    const b = document.createElement('button')
    b.className = 'btn ghost sm'
    b.textContent = a.label
    b.onclick = () => { a.run(); dismiss() }
    el.append(b)
  }
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250) }
  $('#toasts').append(el)
  setTimeout(dismiss, duration)
  el.addEventListener('mouseenter', () => clearTimeout(el._t))
}

function appMenu () {
  const t = activeTab()
  const zoomRow = document.createElement('div')
  zoomRow.className = 'm-row'
  const pct = Math.round(Math.pow(1.2, t?.zoom || 0) * 100)
  zoomRow.innerHTML = `${icon('zoomIn')}<span class="m-label" style="margin-left:10px">Zoom</span><button class="icon-btn sm" data-z="-1">${icon('minus')}</button><span class="zoom-val">${pct} %</span><button class="icon-btn sm" data-z="1">${icon('plus')}</button><button class="icon-btn sm" data-z="full" title="Vollbild (F11)">${icon('expand')}</button>`
  zoomRow.addEventListener('click', e => {
    const b = e.target.closest('[data-z]'); if (!b) return
    if (b.dataset.z === 'full') { hideMenu(); return toggleFullscreen() }
    zoom(+b.dataset.z)
    $('.zoom-val', zoomRow).textContent = Math.round(Math.pow(1.2, activeTab()?.zoom || 0) * 100) + ' %'
  })
  const r = $('#btn-menu').getBoundingClientRect()
  showMenu(r.right - 260, r.bottom + 6, [
    { label: 'Neuer Tab', icon: 'plus', hint: 'Strg+T', run: () => createTab() },
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
    '-',
    { label: 'Screenshot', icon: 'camera', hint: 'Strg+Umschalt+X', run: screenshot },
    { label: 'Auf Seite suchen', icon: 'search', hint: 'Strg+F', run: openFind },
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
  $('#panel-title').textContent = PANEL_TITLES[name]
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
      b.title = a.title
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
  search.placeholder = 'Verlauf durchsuchen …'
  search.value = q
  search.oninput = () => { renderHistory(body); const s = body.querySelector('.panel-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length) }
  body.append(search)
  const ql = q.toLowerCase()
  const list = S.data.history.filter(h => !ql || (h.title + ' ' + h.url).toLowerCase().includes(ql)).slice(0, 300)
  if (!list.length) { body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('history')}<div>${q ? 'Keine Treffer' : 'Noch kein Verlauf'}</div></div>`); return }
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86400000).toDateString()
  let last = ''
  for (const h of list) {
    const d = new Date(h.time)
    const ds = d.toDateString()
    const label = ds === today ? 'Heute' : ds === yesterday ? 'Gestern' : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
    if (label !== last) { body.insertAdjacentHTML('beforeend', `<div class="group-title">${esc(label)}</div>`); last = label }
    body.append(rowEl({
      url: h.url,
      title: h.title || h.url,
      sub: hostOf(h.url),
      time: d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
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
  clear.innerHTML = `${icon('trash')} Gesamten Verlauf löschen`
  clear.onclick = () => confirmDialog('Verlauf löschen?', 'Der gesamte Browserverlauf wird unwiderruflich entfernt.', 'Löschen', () => { S.data.history = []; save('history'); renderPanel() })
  body.append(clear)
}

function renderDownloads (body) {
  body.innerHTML = ''
  const list = [...S.downloads.values()].sort((a, b) => b.started - a.started)
  if (!list.length) { body.innerHTML = `<div class="empty">${icon('download')}<div>Keine Downloads in dieser Sitzung</div></div>`; return }
  for (const d of list) {
    const card = document.createElement('div')
    card.className = 'card'
    const pct = d.total ? Math.round(d.received / d.total * 100) : 0
    const state = d.state === 'completed' ? `Fertig · ${fmtBytes(d.total || d.received)}`
      : d.state === 'cancelled' ? 'Abgebrochen'
        : d.state === 'interrupted' ? 'Unterbrochen'
          : d.paused ? `Pausiert · ${pct} %` : `${fmtBytes(d.received)} von ${d.total ? fmtBytes(d.total) : '?'}`
    card.innerHTML = `<div class="flex"><span class="r-ico">${icon('file')}</span><div class="grow" style="min-width:0"><div class="r-title" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</div><div class="muted" style="font-size:12px">${esc(state)}</div></div></div>${d.state === 'progressing' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}<div class="ext-actions"></div>`
    const act = $('.ext-actions', card)
    const btn = (label, fn, ghost = true) => { const b = document.createElement('button'); b.className = 'btn sm' + (ghost ? ' ghost' : ''); b.textContent = label; b.onclick = fn; act.append(b) }
    if (d.state === 'completed') { btn('Öffnen', () => A.send('dl:open', d.path), false); btn('Im Ordner zeigen', () => A.send('dl:show', d.path)) }
    if (d.state === 'progressing') { btn(d.paused ? 'Fortsetzen' : 'Pausieren', () => A.send('dl:control', d.id, d.paused ? 'resume' : 'pause')); btn('Abbrechen', () => A.send('dl:control', d.id, 'cancel')) }
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
  body.insertAdjacentHTML('beforeend', '<p class="panel-note">Notizen werden pro Website gespeichert und erscheinen automatisch wieder, wenn du die Seite erneut besuchst. Markierter Text lässt sich per Rechtsklick direkt übernehmen.</p>')
  if (host) {
    const head = document.createElement('div')
    head.className = 'note-host'
    head.append(faviconEl(t.favicon, t.url))
    head.insertAdjacentHTML('beforeend', `<span>${esc(host)}</span>`)
    body.append(head)
    const ta = document.createElement('textarea')
    ta.className = 'note-area'
    ta.placeholder = `Gedanken, To-dos oder Zitate zu ${host} …`
    ta.value = S.data.notes[host]?.text || ''
    ta.oninput = () => {
      if (ta.value.trim()) S.data.notes[host] = { text: ta.value, updated: Date.now(), url: t.url }
      else delete S.data.notes[host]
      save('notes')
    }
    body.append(ta)
  } else {
    body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('note')}<div>Öffne eine Website, um Notizen dazu anzulegen.</div></div>`)
  }
  const others = Object.entries(S.data.notes).filter(([h]) => h !== host).sort((a, b) => b[1].updated - a[1].updated)
  if (others.length) {
    body.insertAdjacentHTML('beforeend', '<div class="group-title">Alle Notizen</div>')
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
  toast('Zeitkapsel gespeichert', `${tabs.length} Tabs aus „${sp.name}“ gesichert.`, 'archive')
  if (S.panel === 'snapshots') renderPanel()
}

function restoreSnapshot (snap) {
  const sp = addSpace({ name: `${snap.name} · ${new Date(snap.created).toLocaleDateString('de-DE')}`, color: snap.color, icon: snap.icon })
  const first = sp.tabIds[0]
  snap.tabs.forEach(t => createTab({ url: t.url, title: t.title, favicon: t.favicon, spaceId: sp.id, sleeping: true, background: true }))
  if (first) closeTab(first)
  activate(sp.tabIds[0])
  toast('Zeitkapsel geöffnet', `${snap.tabs.length} Tabs wiederhergestellt – schlafend, bis du sie brauchst.`, 'archive')
}

function renderSnapshots (body) {
  body.innerHTML = ''
  body.insertAdjacentHTML('beforeend', '<p class="panel-note">Zeitkapseln frieren einen ganzen Space ein – alle Tabs, sortiert und benannt. Später öffnest du ihn als neuen Space und machst genau dort weiter.</p>')
  const btn = document.createElement('button')
  btn.className = 'btn block'
  btn.innerHTML = `${icon('archive')} „${esc(curSpace().name)}“ jetzt sichern`
  btn.onclick = () => saveSnapshot()
  body.append(btn)
  if (!S.data.snapshots.length) { body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('archive')}<div>Noch keine Zeitkapseln</div></div>`); return }
  body.insertAdjacentHTML('beforeend', '<div class="group-title">Gespeichert</div>')
  for (const snap of S.data.snapshots) {
    const card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = `<div class="flex"><span class="space-btn active" style="--sc:${esc(snap.color)};cursor:default">${esc(snap.icon)}</span><div class="grow"><h3>${esc(snap.name)}</h3><div class="muted" style="font-size:12px">${snap.tabs.length} Tabs · ${new Date(snap.created).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</div></div></div><div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">${snap.tabs.slice(0, 4).map(t => esc(t.title || hostOf(t.url))).join(' · ')}${snap.tabs.length > 4 ? ' …' : ''}</div><div class="ext-actions"><button class="btn sm" data-a="open">Öffnen</button><button class="btn ghost sm" data-a="del">Löschen</button></div>`
    card.querySelector('[data-a=open]').onclick = () => restoreSnapshot(snap)
    card.querySelector('[data-a=del]').onclick = () => { S.data.snapshots = S.data.snapshots.filter(s => s !== snap); save('snapshots'); renderPanel() }
    body.append(card)
  }
}

async function renderExtensions (body) {
  const list = await A.invoke('ext:list')
  body.innerHTML = ''
  body.insertAdjacentHTML('beforeend', '<p class="panel-note">Caravel unterstützt Chrome-Erweiterungen direkt aus dem Chrome Web Store. Öffne den Store und klicke bei einer Erweiterung auf „Hinzufügen“. Aktionssymbole erscheinen rechts in der Werkzeugleiste.</p>')
  const actions = document.createElement('div')
  actions.className = 'flex'
  actions.style.marginBottom = '12px'
  actions.innerHTML = `<button class="btn" id="ext-store">${icon('external')} Chrome Web Store</button><button class="btn ghost" id="ext-unpacked">${icon('folder')} Entpackt laden</button>`
  body.append(actions)
  $('#ext-store', body).onclick = () => createTab({ url: 'https://chromewebstore.google.com/' })
  $('#ext-unpacked', body).onclick = async () => {
    try {
      const ext = await A.invoke('ext:load-unpacked')
      if (ext) { toast('Erweiterung geladen', ext.name, 'puzzle'); renderPanel() }
    } catch (err) { toast('Laden fehlgeschlagen', String(err.message || err).replace(/^Error invoking remote method[^:]*: /, ''), 'warning') }
  }
  if (!list.length) {
    body.insertAdjacentHTML('beforeend', `<div class="empty">${icon('puzzle')}<div>Noch keine Erweiterungen installiert.<br><span style="font-size:12px">Beliebt: uBlock Origin Lite, Dark Reader, Bitwarden, Grammarly</span></div></div>`)
    return
  }
  body.insertAdjacentHTML('beforeend', `<div class="group-title">Installiert (${list.length})</div>`)
  for (const ext of list) {
    const card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = `<div class="ext-row">${ext.icon ? `<img src="${ext.icon}">` : `<div class="ext-ph">${icon('puzzle')}</div>`}<div class="grow" style="min-width:0"><h3>${esc(ext.name)}</h3><div class="muted" style="font-size:12px">Version ${esc(ext.version)}${ext.unpacked ? ' · entpackt' : ' · Chrome Web Store'}</div>${ext.description ? `<div class="muted" style="font-size:12px;margin-top:6px;line-height:1.45">${esc(ext.description)}</div>` : ''}</div></div><div class="ext-actions"></div>`
    const act = $('.ext-actions', card)
    if (ext.options) {
      const o = document.createElement('button')
      o.className = 'btn ghost sm'
      o.textContent = 'Optionen'
      o.onclick = () => createTab({ url: `chrome-extension://${ext.id}/${ext.options}` })
      act.append(o)
    }
    const r = document.createElement('button')
    r.className = 'btn ghost sm'
    r.textContent = 'Entfernen'
    r.onclick = () => confirmDialog(`„${ext.name}“ entfernen?`, 'Die Erweiterung und ihre Daten werden aus Caravel entfernt.', 'Entfernen', async () => {
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
    { title: 'Auf Chromecast streamen', icon: 'cast', run: () => openCast() },
    ...(dockEnabled() ? [
      { title: `${assistant().name}-Seitenleiste`, icon: 'chat', hint: 'Strg+E', run: () => toggleDock() },
      { title: `Seite an ${assistant().name} übergeben`, icon: 'send', hint: 'Strg+Umschalt+L', run: () => sendPageToClaude('context') },
      { title: `Seite mit ${assistant().name} zusammenfassen`, icon: 'chat', run: () => sendPageToClaude('summarize') }
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
    ...S.spaces.map((sp, i) => ({ title: `Space: ${sp.name}`, icon: 'layers', hint: `Alt+${i + 1}`, run: () => switchSpace(sp.id) })),
    { title: 'Zeitkapsel dieses Spaces speichern', icon: 'archive', run: () => saveSnapshot() },
    { title: 'Verlauf anzeigen', icon: 'history', hint: 'Strg+H', run: () => togglePanel('history') },
    { title: 'Downloads anzeigen', icon: 'download', hint: 'Strg+J', run: () => togglePanel('downloads') },
    { title: 'Seiten-Notizen', icon: 'note', hint: 'Strg+Umschalt+N', run: () => togglePanel('notes') },
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
  return list.map(c => ({ ...c, kind: 'Befehle' }))
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
      title: t.title || 'Neuer Tab', sub: (space(t.spaceId)?.name || '') + ' · ' + (prettyUrl(t.url) || 'Neuer Tab'), url: t.url, favicon: t.favicon, kind: 'Offene Tabs', run: () => activate(t.id)
    }))
    if (!q) {
      items = [...tabs.filter(t => space(S.activeSpace)).slice(0, 6), ...commands().slice(0, 10)]
    } else {
      const score = arr => arr.map(x => ({ x, s: fuzzy(q, x.title + ' ' + (x.sub || '')) })).filter(o => o.s >= 0).sort((a, b) => b.s - a.s).map(o => o.x)
      const bms = S.data.bookmarks.map(b => ({ title: b.title, sub: hostOf(b.url), url: b.url, favicon: b.favicon, kind: 'Lesezeichen', run: () => createTab({ url: b.url }) }))
      const hist = []
      const seen = new Set()
      for (const h of S.data.history) {
        if (hist.length >= 6) break
        if (seen.has(h.url)) continue
        if ((h.title + ' ' + h.url).toLowerCase().includes(q)) { seen.add(h.url); hist.push({ title: h.title || h.url, sub: hostOf(h.url), url: h.url, kind: 'Verlauf', run: () => createTab({ url: h.url }) }) }
      }
      items = [...score(commands()).slice(0, 6), ...score(tabs).slice(0, 5), ...score(bms).slice(0, 4), ...hist,
        { title: `Im Web suchen: „${input.value.trim()}“`, icon: 'search', kind: 'Web', run: () => createTab({ url: searchUrl(input.value.trim()) }) }]
    }
    sel = 0
    render()
  }
  const render = () => {
    list.innerHTML = ''
    if (!items.length) { list.innerHTML = '<div class="p-empty">Keine Treffer</div>'; return }
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
  wv.setAttribute('partition', PARTITION)
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
  </style></head><body><main><div class="site">${esc(r.art.siteName || hostOf(activeTab()?.url))}</div><h1>${esc(r.art.title)}</h1><div class="meta">${r.art.byline ? esc(r.art.byline) + ' · ' : ''}${minutes} Min. Lesezeit</div>${r.art.content}</main></body></html>`

  box.innerHTML = `<div class="reader-bar">
      <button class="icon-btn sm" data-r="close" title="Leser-Modus verlassen (Esc)">${icon('x')}</button>
      <span class="rb-title">${esc(r.art.title)}</span>
      <button class="icon-btn sm ${r.speaking ? 'on' : ''}" data-r="speak" title="Vorlesen">${icon(r.speaking ? 'pause' : 'speak')}</button>
      <span class="rb-sep"></span>
      <button class="icon-btn sm" data-r="smaller" title="Kleiner">${icon('minus')}</button>
      <button class="icon-btn sm" data-r="font" title="Schriftart wechseln">${icon('type')}</button>
      <button class="icon-btn sm" data-r="bigger" title="Größer">${icon('plus')}</button>
      <span class="rb-sep"></span>
      <span class="dotc" data-r="light" style="background:#fbfaf7" title="Hell"></span>
      <span class="dotc" data-r="sepia" style="background:#f4ecd8" title="Sepia"></span>
      <span class="dotc" data-r="dark" style="background:#15151c" title="Dunkel"></span>
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
  const lang = (r.art.lang || 'de').slice(0, 2)
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
  const updated = info.updated ? new Date(info.updated).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–'
  const p = showPopover($('#btn-adblock'), `
    <h3>${icon('shieldCheck')} Werbeblocker</h3>
    <div class="sub">Mit den Filterlisten von uBlock Origin – blockiert Werbung (auch auf YouTube), Tracker und Schadseiten.</div>
    <div class="flex" style="gap:10px">
      <div class="card grow" style="margin:0;text-align:center"><div style="font:700 26px var(--font-display)">${global && !paused ? t?.blocked || 0 : '–'}</div><div class="muted" style="font-size:12px">auf dieser Seite</div></div>
      <div class="card grow" style="margin:0;text-align:center"><div style="font:700 26px var(--font-display)">${(S.adblockTotal || 0).toLocaleString('de-DE')}</div><div class="muted" style="font-size:12px">insgesamt</div></div>
    </div>
    <div class="pop-sep"></div>
    ${host ? `<div class="set-row" style="padding:0 0 10px;border:0"><div><div class="t">Auf ${esc(host)} aktiv</div><div class="d">Ausschalten, falls eine Seite nicht richtig funktioniert.</div></div><label class="switch"><input type="checkbox" id="ab-site" ${!paused ? 'checked' : ''} ${global ? '' : 'disabled'}><span></span></label></div>` : ''}
    <div class="set-row" style="padding:0 0 10px;border:0"><div><div class="t">Cookie-Banner ausblenden</div></div><label class="switch"><input type="checkbox" id="ab-cookies" ${st.adblockCookies ? 'checked' : ''}><span></span></label></div>
    <div class="set-row" style="padding:0;border:0"><div><div class="t">Werbeblocker</div><div class="d">Listen aktualisiert: ${esc(updated)}</div></div><label class="switch"><input type="checkbox" id="ab-global" ${global ? 'checked' : ''}><span></span></label></div>
    <div class="flex" style="margin-top:12px"><button class="btn ghost sm" id="ab-update">${icon('refresh')} Filterlisten aktualisieren</button></div>`, 'adblock')
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
   VPN (Tor mit Länderwahl oder eigene Server)
   --------------------------------------------------------------------- */

const VPN_TYPES = { socks5: 'SOCKS5', http: 'HTTP-Proxy', https: 'HTTPS-Proxy', wireguard: 'WireGuard' }

function updateVpnPill () {
  const v = S.vpn || { status: 'off' }
  const b = $('#btn-vpn')
  b.className = 'vpn-pill ' + ({ on: 'on', connecting: 'connecting', error: 'error' }[v.status] || '')
  const label = v.status === 'on' ? (v.country || 'VPN') : v.status === 'connecting' ? `${v.progress || 0} %` : 'VPN'
  b.innerHTML = `<span class="dotv"></span>${esc(label)}`
  b.title = v.status === 'on' ? `VPN aktiv: ${v.label}${v.ip ? ' · ' + v.ip : ''}` : v.status === 'connecting' ? 'VPN verbindet …' : v.status === 'error' ? `VPN-Fehler: ${v.error}` : 'VPN (aus)'
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
    : busy ? `Verbinde mit ${esc(v.label || '…')}` : v.status === 'error' ? esc(v.error || 'Fehler') : 'Dein Verkehr läuft direkt über deine eigene IP.'
  const countries = (S.vpnCountries || []).map(([code, name]) => `
    <div class="server ${st.vpnCountry === code ? 'sel' : ''}" data-country="${code}">
      <span class="s-flag"><span class="kbd" style="font:600 10px var(--mono);color:var(--text-2)">${code === 'auto' ? '★' : code.toUpperCase()}</span></span>
      <div class="s-main"><div>${esc(name)}</div></div>
    </div>`).join('')
  const servers = st.vpnServers.map(s => `
    <div class="server ${st.vpnServerId === s.id ? 'sel' : ''}" data-server="${esc(s.id)}">
      <span class="s-flag">${icon(s.type === 'wireguard' ? 'vpn' : 'globe')}</span>
      <div class="s-main"><div>${esc(s.name)}</div><div>${VPN_TYPES[s.type]}${s.host ? ' · ' + esc(s.host) : ''}</div></div>
      <button class="icon-btn sm" data-del="${esc(s.id)}" title="Entfernen">${icon('trash')}</button>
    </div>`).join('')
  const html = `
    <h3>${icon('vpn')} VPN</h3>
    <div class="sub">Leitet den gesamten Tab-Verkehr (inkl. DNS) durch einen verschlüsselten Tunnel und verbirgt deine IP-Adresse.</div>
    <div class="vpn-hero ${on ? 'on' : ''}">
      <div class="globe">${icon(on ? 'vpn' : 'globe')}</div>
      <div class="grow" style="min-width:0">
        <div class="v-title">${on ? 'Geschützt' : busy ? 'Verbinde …' : v.status === 'error' ? 'Nicht verbunden' : 'Ungeschützt'}</div>
        <div class="v-sub">${heroSub}</div>
        ${busy ? `<div class="vpn-progress"><i style="width:${v.progress || 5}%"></i></div>` : ''}
      </div>
    </div>
    <div class="flex" style="margin-bottom:12px">
      <button class="btn grow" id="vpn-toggle" style="justify-content:center" ${busy ? 'disabled' : ''}>${on || busy ? 'Trennen' : 'Verbinden'}</button>
      ${on && v.mode === 'tor' ? `<button class="btn ghost" id="vpn-newnym" title="Neue Route und neue IP">${icon('refresh')}</button>` : ''}
    </div>
    <div class="seg" id="vpn-mode" style="width:100%;margin-bottom:8px">
      <button data-mode="tor" class="${mode === 'tor' ? 'on' : ''}" style="flex:1">Tor · kostenlos</button>
      <button data-mode="server" class="${mode === 'server' ? 'on' : ''}" style="flex:1">Eigene Server</button>
    </div>
    ${mode === 'tor'
      ? `<div class="server-list">${countries}</div>
         <div class="muted" style="font-size:11.5px;line-height:1.5">Tor ist kostenlos und braucht kein Konto, ist aber langsamer; manche Seiten zeigen Captchas. Für echte Anonymität eignet sich weiterhin der Tor Browser.</div>`
      : `<div class="server-list">${servers || '<div class="muted" style="font-size:12px;padding:8px 2px">Noch keine Server. Füge WireGuard-Konfigurationen (z. B. kostenlos von Proton VPN) oder SOCKS5-/HTTP-Zugänge deines Anbieters hinzu.</div>'}</div>
         <div class="flex"><button class="btn ghost sm" id="vpn-import">${icon('folder')} WireGuard importieren</button><button class="btn ghost sm" id="vpn-add">${icon('plus')} Server hinzufügen</button></div>`}`
  const p = S.popover === 'vpn' ? $('#popover') : null
  const pop = p || showPopover($('#btn-vpn'), html, 'vpn')
  if (p) p.innerHTML = html
  pop.style.width = '360px'
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
        toast('WireGuard importiert', `${list.length} Server hinzugefügt.`, 'vpn')
      }
      return
    }
    if (e.target.closest('#vpn-add')) { hidePopover(); addServerDialog() }
  }
}

function addServerDialog () {
  showModal(`
    <div class="modal-head"><h2>VPN-Server hinzufügen</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0;line-height:1.5">Die Zugangsdaten findest du im Kundenbereich deines VPN-Anbieters (oft unter „Manuelle Einrichtung“, „SOCKS5“ oder „WireGuard“). Sie werden nur lokal auf diesem PC gespeichert.</p>
      <div class="field"><label>Name</label><input class="input" id="sv-name" placeholder="z. B. Mullvad Frankfurt"></div>
      <div class="field"><label>Typ</label><select class="input" id="sv-type">${Object.entries(VPN_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div id="sv-proxy">
        <div class="flex" style="align-items:flex-start"><div class="field grow"><label>Adresse</label><input class="input" id="sv-host" placeholder="de-fra.anbieter.net"></div><div class="field" style="width:110px"><label>Port</label><input class="input" id="sv-port" placeholder="1080"></div></div>
        <div class="flex" style="align-items:flex-start"><div class="field grow"><label>Benutzer (optional)</label><input class="input" id="sv-user"></div><div class="field grow"><label>Passwort (optional)</label><input class="input" id="sv-pass" type="password"></div></div>
      </div>
      <div id="sv-wg" hidden><div class="field"><label>WireGuard-Konfiguration</label><textarea class="input" id="sv-conf" rows="9" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = …&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = …"></textarea></div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>Abbrechen</button><button class="btn" id="sv-save">Speichern</button></div>`)
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
  $('#btn-claude').innerHTML = `${icon('chat')}<span>${esc(a?.name || 'KI')}</span>`
  $('#btn-claude').title = `${a?.name || 'KI'}-Seitenleiste (Strg+E)`
  $('#dock-send').title = `Aktuelle Seite an ${a?.name || 'die KI'} übergeben`
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
    return toast(assistant() ? `${assistant().name}-Seitenleiste ist aus` : 'Kein KI-Assistent gewählt',
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
    panel = { key, extId, tabId, url, wv, name: extId === CLAUDE_EXT ? 'Claude in Chrome' : (name || 'Erweiterung') }
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
  A.send('clipboard:write', `# ${page.title}\n\nQuelle: ${page.url}\n\n${page.markdown}`)
  toast('Als Markdown kopiert', `${page.markdown.length.toLocaleString('de-DE')} Zeichen – bereit zum Einfügen in einen KI-Chat.`, 'markdown')
}

async function insertIntoClaude (text) {
  const a = assistant()
  if (!dockEnabled()) {
    A.send('clipboard:write', text)
    return toast('In Zwischenablage kopiert', a ? `Die ${a.name}-Seitenleiste ist ausgeschaltet.` : 'Es ist kein KI-Assistent gewählt.', 'chat')
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
  if (ok) toast(`An ${a.name} übergeben`, 'Mit Enter absenden oder vorher ergänzen.', 'chat')
  else {
    A.send('clipboard:write', text)
    toast('In Zwischenablage kopiert', `Das Eingabefeld von ${a.name} war nicht erreichbar (z. B. Anmeldung oder Hinweisfenster offen) – einfach mit Strg+V einfügen.`, 'chat', { duration: 7000 })
  }
}

async function sendPageToClaude (prompt = 'context') {
  const page = await pageAsMarkdown()
  if (!page) return toast('Nicht möglich', 'Öffne zuerst eine Website.', 'chat')
  const content = page.markdown.length > 60000 ? page.markdown.slice(0, 60000) + '\n\n[… gekürzt]' : page.markdown
  const intro = prompt === 'summarize'
    ? 'Fasse die folgende Webseite prägnant auf Deutsch zusammen (Kernaussagen als Stichpunkte):'
    : 'Hier ist der Inhalt einer Webseite, zu der ich Fragen habe:'
  insertIntoClaude(`${intro}\n\n# ${page.title}\nQuelle: ${page.url}\n\n${content}\n\n`)
}

function sendSelectionToClaude (text, prompt) {
  const t = activeTab()
  const src = t ? `„${t.title}“ (${t.url})` : 'einer Webseite'
  const intro = prompt === 'explain'
    ? `Erkläre mir diesen Ausschnitt aus ${src} verständlich:`
    : prompt === 'translate'
      ? `Übersetze diesen Ausschnitt aus ${src} ins Deutsche (falls er schon deutsch ist, ins Englische):`
      : `Zu diesem Ausschnitt aus ${src}:`
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
      <h3>${icon('focus')} Fokus läuft</h3>
      <div class="sub">Noch ${fmtTime(rem / 1000)} – ablenkende Seiten sind gesperrt.</div>
      <button class="btn block ghost" id="focus-stop">Session beenden</button>`, 'focus')
    $('#focus-stop', p).onclick = () => { hidePopover(); endFocus(false) }
    return
  }
  let minutes = settings().focusMinutes || 25
  const list = settings().focusBlocklist
  const p = showPopover($('#btn-focus'), `
    <h3>${icon('focus')} Fokus-Modus</h3>
    <div class="sub">Ein Timer, eine ruhige Oberfläche und gesperrte Ablenkungen. Wenn die Zeit um ist, gibt Caravel alles wieder frei.</div>
    <div class="seg" id="focus-min" style="width:100%;justify-content:space-between">${[15, 25, 45, 60, 90].map(m => `<button data-m="${m}" class="${m === minutes ? 'on' : ''}">${m} Min.</button>`).join('')}</div>
    <div class="muted" style="font-size:12px;margin:12px 0 4px">Gesperrt während der Session:</div>
    <div style="font-size:12px;line-height:1.6;color:var(--text-2)">${list.map(esc).join(' · ') || '—'}</div>
    <div class="pop-sep"></div>
    <div class="flex"><button class="btn ghost sm" id="focus-edit">Liste bearbeiten</button><span class="grow"></span><button class="btn" id="focus-start">${icon('play')} Starten</button></div>`, 'focus')
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
  toast('Fokus-Modus gestartet', `${minutes} Minuten konzentriertes Arbeiten. Du schaffst das!`, 'focus')
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
    toast('Fokus-Session geschafft! 🎉', `${minutes} Minuten fokussiert · ${fs.sessions} Sessions insgesamt`, 'sparkles', { duration: 7000 })
    new Notification('Caravel – Fokus-Session beendet', { body: `Stark! ${minutes} Minuten fokussiert. Zeit für eine Pause.`, silent: false })
  } else {
    toast('Fokus-Modus beendet', `${minutes} Minuten fokussiert.`, 'focus')
  }
}

/* ---------------------------------------------------------------------
   Chromecast
   --------------------------------------------------------------------- */

async function openCast (presetUrl) {
  S.cast.preset = presetUrl || null
  S.cast.scanning = true
  A.send('cast:scan')
  setTimeout(() => { S.cast.scanning = false; if (S.popover === 'cast') renderCast() }, 6000)
  S.cast.media = await detectMedia()
  renderCast()
}

async function detectMedia () {
  const t = activeTab()
  if (!t?.ready) return null
  if (/youtube\.com\/(watch|shorts)|youtu\.be\//.test(t.url)) {
    return { kind: 'youtube', title: t.title.replace(/ - YouTube$/, ''), url: t.url }
  }
  try {
    const info = await t.webview.executeJavaScript(`(() => {
      const list = [...document.querySelectorAll('video, audio')];
      const v = list.sort((a, b) => (b.videoWidth || 0) * (b.videoHeight || 0) - (a.videoWidth || 0) * (a.videoHeight || 0))[0];
      if (!v) return null;
      return { src: v.currentSrc || v.src, time: v.currentTime || 0, poster: v.poster || '', title: document.title, video: v.tagName === 'VIDEO' };
    })()`)
    if (!info) return null
    if (/^https?:/.test(info.src)) return { kind: 'media', title: info.title, url: info.src, startTime: info.time, poster: info.poster }
    if (info.src?.startsWith('blob:')) return { kind: 'blob', title: info.title }
  } catch {}
  return null
}

function renderCast () {
  const c = S.cast
  const devs = c.devices
  if (!c.selected && devs.length) c.selected = devs[0].id
  const st = c.status
  const playing = st && !['STOPPED', 'FINISHED'].includes(st.state)
  const media = []
  if (c.preset) media.push({ kind: 'media', title: 'Ausgewähltes Medium', url: c.preset, sub: c.preset })
  if (c.media?.kind === 'youtube') media.push({ ...c.media, sub: 'Wird in der YouTube-App auf dem Fernseher geöffnet' })
  if (c.media?.kind === 'media') media.push({ ...c.media, sub: 'Video dieser Seite' + (c.media.startTime > 5 ? ` · ab ${fmtTime(c.media.startTime)}` : '') })

  const html = `
    <h3>${icon('cast')} Streamen</h3>
    <div class="sub">Sende Videos, Musik und Bilder an Chromecast & Google-TV-Geräte in deinem WLAN.</div>
    ${playing ? `<div class="now-playing">
      <div class="muted" style="font-size:11.5px">Läuft auf ${esc(st.device || 'Chromecast')}</div>
      <div style="font-weight:650;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(st.title || 'Medium')}</div>
      <div class="np-controls">
        <button class="icon-btn sm" data-c="toggle">${icon(st.state === 'PAUSED' ? 'play' : 'pause')}</button>
        <button class="icon-btn sm" data-c="back">${icon('back')}</button>
        <input type="range" id="cast-seek" min="0" max="${Math.round(st.duration || 0)}" value="${Math.round(st.time || 0)}" ${st.duration ? '' : 'disabled'}>
        <button class="icon-btn sm" data-c="fwd">${icon('forward')}</button>
        <button class="icon-btn sm" data-c="stop" title="Beenden">${icon('stop')}</button>
      </div>
      <div class="flex" style="margin-top:6px;font-size:11.5px" ><span class="muted">${fmtTime(st.time)} / ${fmtTime(st.duration)}</span><span class="grow"></span>${icon('volume')}<input type="range" id="cast-vol" min="0" max="100" value="${Math.round((st.volume ?? 1) * 100)}" style="width:90px;accent-color:var(--accent)"></div>
    </div><div class="pop-sep"></div>` : ''}
    <div class="muted" style="font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Geräte</div>
    ${devs.map(d => `<div class="device ${d.id === c.selected ? 'sel' : ''}" data-d="${esc(d.id)}"><div class="d-ico">${icon('tv')}</div><div><div class="d-name">${esc(d.name)}</div><div class="d-host">${esc(d.host)}</div></div></div>`).join('')}
    ${c.scanning || !devs.length ? `<div class="scan">${c.scanning ? '<span class="pulse"></span> Suche nach Geräten …' : `${icon('info')} Keine Geräte gefunden. PC und Chromecast müssen im selben Netzwerk sein.`}</div>` : ''}
    <div class="pop-sep"></div>
    <div class="muted" style="font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Was möchtest du streamen?</div>
    ${media.map((m, i) => `<div class="media-opt"><span>${icon(m.kind === 'youtube' ? 'play' : 'tv')}</span><div class="m-t"><div>${esc(m.title)}</div><div>${esc(m.sub || '')}</div></div><button class="btn sm" data-m="${i}">Streamen</button></div>`).join('')}
    ${c.media?.kind === 'blob' ? `<div class="media-opt"><span>${icon('info')}</span><div class="m-t" style="white-space:normal"><div>Geschützter Stream</div><div style="white-space:normal">Das Video dieser Seite wird als verschlüsselter/segmentierter Stream geladen und kann nicht direkt übertragen werden.</div></div></div>` : ''}
    <div class="media-opt"><span>${icon('folder')}</span><div class="m-t"><div>Lokale Datei</div><div>Video, Musik oder Foto vom PC</div></div><button class="btn ghost sm" id="cast-file">Auswählen</button></div>
    <div class="flex" style="margin-top:8px"><input class="input grow" id="cast-url" placeholder="Medien-URL (mp4, mp3, m3u8, YouTube …)"><button class="btn ghost sm" id="cast-url-go">Los</button></div>`
  const p = S.popover === 'cast' ? $('#popover') : null
  const pop = p || showPopover($('#btn-cast'), html, 'cast')
  if (p) p.innerHTML = html
  pop.style.width = '370px'
  pop.onclick = async e => {
    const d = e.target.closest('[data-d]')
    if (d) { c.selected = d.dataset.d; return renderCast() }
    const m = e.target.closest('[data-m]')
    if (m) return castPlay(media[+m.dataset.m])
    const ctl = e.target.closest('[data-c]')?.dataset.c
    if (ctl === 'toggle') A.send('cast:control', st.state === 'PAUSED' ? 'resume' : 'pause')
    if (ctl === 'stop') A.send('cast:control', 'stop')
    if (ctl === 'back') A.send('cast:control', 'seek', -15)
    if (ctl === 'fwd') A.send('cast:control', 'seek', 30)
    if (e.target.id === 'cast-file') {
      const file = await A.invoke('cast:pick-file')
      if (file) castPlay({ file, title: file.split(/[\\/]/).pop() })
    }
    if (e.target.id === 'cast-url-go') {
      const url = $('#cast-url', pop).value.trim()
      if (url) castPlay({ url, title: url })
    }
  }
  const seek = $('#cast-seek', pop)
  if (seek) seek.onchange = () => A.send('cast:control', 'seekTo', +seek.value)
  const vol = $('#cast-vol', pop)
  if (vol) vol.onchange = () => A.send('cast:control', 'volume', vol.value / 100)
}

async function castPlay (media) {
  const c = S.cast
  if (!c.selected) return toast('Kein Gerät ausgewählt', 'Warte, bis ein Chromecast gefunden wurde.', 'cast')
  const dev = c.devices.find(d => d.id === c.selected)
  toast('Verbinde …', `Streame auf ${dev?.name || 'Chromecast'}`, 'cast', { duration: 2500 })
  const res = await A.invoke('cast:play', c.selected, media)
  if (!res.ok) return toast('Streamen fehlgeschlagen', res.error, 'warning', { duration: 6000 })
  const t = activeTab()
  if (t?.ready && media.kind !== undefined) t.webview.executeJavaScript('document.querySelectorAll("video,audio").forEach(v => v.pause())').catch(() => {})
  $('#btn-cast').classList.add('on')
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
    ['general', 'settings', 'Allgemein'],
    ['appearance', 'sparkles', 'Darstellung'],
    ['claude', 'chat', 'KI-Assistent'],
    ['adblock', 'shieldCheck', 'Werbeblocker'],
    ['vpn', 'vpn', 'VPN'],
    ['privacy', 'lock', 'Privatsphäre'],
    ['performance', 'bolt', 'Leistung'],
    ['focus', 'focus', 'Fokus-Modus'],
    ['about', 'info', 'Über Caravel']
  ]
  const perms = Object.entries(S.data.permissions || {})
  const PERM_DE = { media: 'Kamera/Mikrofon', geolocation: 'Standort', notifications: 'Benachrichtigungen', 'clipboard-read': 'Zwischenablage', midi: 'MIDI', midiSysex: 'MIDI', 'display-capture': 'Bildschirmaufnahme', openExternal: 'Externe Apps', 'idle-detection': 'Inaktivität', hid: 'HID-Geräte', serial: 'Serielle Geräte', usb: 'USB-Geräte' }
  const sections = {
    general: `<h3>Allgemein</h3>
      <div class="set-row"><div><div class="t">Dein Name</div><div class="d">Für die persönliche Begrüßung auf der Startseite.</div></div><input class="input" data-s="userName" value="${esc(st.userName)}" placeholder="Name" style="width:200px"></div>
      <div class="set-row"><div><div class="t">Suchmaschine</div><div class="d">Wird in der Adressleiste und auf der Startseite verwendet.</div></div><select class="input" data-s="searchEngine">${Object.entries(SEARCH_ENGINES).map(([k, v]) => `<option value="${k}" ${k === st.searchEngine ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div>
      <div class="set-row"><div><div class="t">Sitzung wiederherstellen</div><div class="d">Beim Start alle Spaces und Tabs wieder öffnen (schlafend, bis sie gebraucht werden).</div></div><label class="switch"><input type="checkbox" data-s="restoreSession" ${st.restoreSession ? 'checked' : ''}><span></span></label></div>
      <div class="set-row"><div><div class="t">Standardbrowser</div><div class="d">Caravel als Standard für Links und HTML-Dateien festlegen.</div></div><button class="btn ghost" id="set-default">Windows-Einstellungen öffnen</button></div>`,
    appearance: `<h3>Darstellung</h3>
      <div class="set-row"><div><div class="t">Design</div></div><div class="seg" data-seg="theme">${[['dark', 'Dunkel'], ['light', 'Hell'], ['system', 'System']].map(([k, l]) => `<button data-v="${k}" class="${st.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="set-row"><div><div class="t">Websites abdunkeln</div><div class="d">Im dunklen Design werden Seiten ohne eigenen Dunkelmodus (z. B. die Google-Suche) automatisch dunkel dargestellt – wie Chromes „Automatischer dunkler Modus für Webinhalte“. Seiten mit eigenem Dunkelmodus bleiben unverändert.</div></div><label class="switch"><input type="checkbox" data-s="autoDarkPages" ${st.autoDarkPages !== false ? 'checked' : ''}><span></span></label></div>
      <div class="set-row"><div><div class="t">Ambient-Farben</div><div class="d">Die Oberfläche übernimmt dezent die Markenfarbe der aktuellen Website.</div></div><label class="switch"><input type="checkbox" data-s="ambient" ${st.ambient ? 'checked' : ''}><span></span></label></div>
      <div class="set-row" style="display:block"><div class="t">Tab-Leiste</div><div class="d">Wo und wie die Tabs angezeigt werden.</div>
        <div class="layout-pick" data-seg="tabLayout">${[
          ['sidebar', 'Caravel', 'Seitenleiste links', '<rect x="1" y="1" width="62" height="42" rx="5" class="lp-frame"/><rect x="4" y="4" width="15" height="36" rx="3" class="lp-bar"/><rect x="6" y="9" width="11" height="3" rx="1.5" class="lp-acc"/><rect x="6" y="14" width="11" height="3" rx="1.5" class="lp-dim"/><rect x="6" y="19" width="11" height="3" rx="1.5" class="lp-dim"/><rect x="22" y="4" width="38" height="5" rx="2.5" class="lp-dim"/><rect x="22" y="12" width="38" height="28" rx="3" class="lp-page"/>'],
          ['chrome', 'Chrome', 'Tabs oben', '<rect x="1" y="1" width="62" height="42" rx="5" class="lp-frame"/><rect x="5" y="4" width="16" height="6" rx="2" class="lp-acc"/><rect x="23" y="5" width="13" height="4" rx="2" class="lp-dim"/><rect x="38" y="5" width="13" height="4" rx="2" class="lp-dim"/><rect x="4" y="10" width="56" height="7" rx="2" class="lp-bar"/><rect x="4" y="19" width="56" height="21" rx="3" class="lp-page"/>'],
          ['safari', 'Safari', 'Tabs unter der Adressleiste', '<rect x="1" y="1" width="62" height="42" rx="5" class="lp-frame"/><rect x="14" y="4" width="36" height="5" rx="2.5" class="lp-dim"/><rect x="4" y="11" width="18" height="5" rx="2" class="lp-acc"/><rect x="23" y="11" width="18" height="5" rx="2" class="lp-bar"/><rect x="42" y="11" width="18" height="5" rx="2" class="lp-bar"/><rect x="4" y="19" width="56" height="21" rx="3" class="lp-page"/>']
        ].map(([k, l, d, svg]) => `<button data-v="${k}" class="${tabLayout() === k ? 'on' : ''}"><svg viewBox="0 0 64 44">${svg}</svg><b>${l}</b><span>${d}</span></button>`).join('')}</div></div>
      ${tabLayout() === 'sidebar'
        ? `<div class="set-row"><div><div class="t">Kompakte Seitenleiste</div><div class="d">Nur Symbole anzeigen (Strg+B).</div></div><label class="switch"><input type="checkbox" data-s="sidebarCollapsed" ${st.sidebarCollapsed ? 'checked' : ''}><span></span></label></div>`
        : `<div class="set-row"><div><div class="t">Favoritenleiste</div><div class="d">Deine Favoriten als Leiste unter der Adressleiste (Strg+B).</div></div><label class="switch"><input type="checkbox" data-s="showFavbar" ${st.showFavbar !== false ? 'checked' : ''}><span></span></label></div>`}
      <div class="set-row"><div><div class="t">Kompakte Darstellung</div><div class="d">Niedrigere Leisten und Tabs – mehr Platz für Webseiten.</div></div><label class="switch"><input type="checkbox" data-s="compactUi" ${st.compactUi ? 'checked' : ''}><span></span></label></div>
      <div class="set-row"><div><div class="t">Space-Farbe</div><div class="d">Jeder Space hat seine eigene Akzentfarbe – per Rechtsklick auf das Space-Symbol änderbar.</div></div><button class="btn ghost" id="set-space">Aktuellen Space bearbeiten</button></div>`,
    claude: `<h3>KI-Assistent</h3>
      <div class="set-row"><div><div class="t">Assistent</div><div class="d">Welcher KI-Dienst in Caravel eingebunden wird. Bei „Keiner“ verschwinden Seitenleiste, Kontextmenü-Einträge und Agenten-Schnittstelle vollständig.</div></div><div class="seg" data-seg="assistant">${[['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['none', 'Keiner']].map(([k, l]) => `<button data-v="${k}" class="${(st.assistant || 'claude') === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${ASSISTANTS[st.assistant] ? `<div class="set-row"><div><div class="t">${ASSISTANTS[st.assistant].name}-Seitenleiste</div><div class="d">Blendet ${st.assistant === 'chatgpt' ? 'chatgpt.com' : 'claude.ai'} neben jeder Seite ein (Strg+E) und ergänzt Kontextmenüs wie „Seite zusammenfassen“, „Mit ${ASSISTANTS[st.assistant].name} erklären“ oder „Seite übergeben“ (Strg+Umschalt+L).</div></div><label class="switch"><input type="checkbox" data-s="claudeSidebar" ${st.claudeSidebar ? 'checked' : ''}><span></span></label></div>` : ''}
      ${st.assistant === 'claude' ? `<div class="set-row" style="display:block">
        <div class="flex"><div class="grow"><div class="t"><span class="status-dot ${cs.extensionInstalled ? 'ok' : ''}"></span>Claude in Chrome</div>
          <div class="d">Die offizielle Erweiterung von Anthropic: Claude liest, klickt und füllt Formulare direkt im Tab. Caravel stellt die dafür nötigen Chrome-Schnittstellen (Seitenleiste, Tab-Gruppen, Debugger) über eine eigene Kompatibilitätsschicht bereit. Offiziell unterstützt Anthropic nur Chrome, Edge und Brave.</div></div>
          ${cs.extensionInstalled ? '<button class="btn" id="cl-open">Öffnen</button>' : '<button class="btn" id="cl-install">Installieren</button>'}</div>
      </div>
      <div class="set-row" style="display:block">
        <div class="t"><span class="status-dot ${cs.nativeHost ? 'ok' : ''}"></span>Claude Code über Claude in Chrome</div>
        <div class="d">${cs.nativeHost ? 'Claude Code ist auf diesem PC eingerichtet. Ist Claude in Chrome installiert und angemeldet, kann Claude Code darüber diesen Browser steuern (Start mit <code>claude --chrome</code>). Experimentell – zuverlässiger ist der MCP-Server unten.' : 'Nicht gefunden. Sobald Claude Code installiert und die Chrome-Integration eingerichtet ist, verbindet es sich über Claude in Chrome auch mit Caravel.'}</div>
      </div>` : ''}
      ${ASSISTANTS[st.assistant] ? `<div class="set-row" style="display:block">
        <div class="flex"><div class="grow"><div class="t"><span class="status-dot ${cs.mcpRunning ? 'ok' : cs.mcpEnabled ? 'warn' : ''}"></span>Caravel als MCP-Server für ${st.assistant === 'chatgpt' ? 'Codex' : 'Claude Code'}</div>
          <div class="d">Ein in Caravel eingebauter MCP-Server. ${st.assistant === 'chatgpt' ? 'Codex' : 'Claude Code'} kann damit Tabs auflisten und öffnen, Seiten als Markdown lesen, Elemente anklicken, Formulare ausfüllen und Screenshots machen – z. B. zum Recherchieren oder zum Testen deiner eigenen Web-Projekte. Er lauscht nur lokal (127.0.0.1) und verlangt ein geheimes Zugangstoken. Gesteuerte Tabs erhalten ein Roboter-Symbol.</div></div>
          <label class="switch"><input type="checkbox" data-s="claudeMcp" ${st.claudeMcp ? 'checked' : ''}><span></span></label></div>
        ${cs.mcpError ? `<div class="d" style="color:#f87171;margin-top:8px">${esc(cs.mcpError)}</div>` : ''}
        ${st.claudeMcp ? `<div class="flex" style="margin-top:10px"><span class="muted" style="font-size:12px">Port</span><input class="input" data-s="claudeMcpPort" data-num value="${+st.claudeMcpPort || 47823}" style="width:100px"><span class="grow"></span><button class="btn ghost sm" id="cl-token">${icon('refresh')} Neues Token</button></div>
        ${st.assistant === 'chatgpt' ? `<div class="muted" style="font-size:12px;margin:10px 0 6px"><span class="status-dot ${cs.codexConfigured ? 'ok' : cs.codexHasEntry ? 'warn' : ''}"></span>${cs.codexConfigured ? 'In Codex eingetragen – Codex neu starten, falls es gerade läuft.' : cs.codexHasEntry ? 'Codex kennt Caravel, aber mit altem Token oder Port – bitte neu eintragen.' : 'Caravel kann sich selbst in die Codex-Konfiguration eintragen'} (<code>${esc(cs.codexConfigPath || '~/.codex/config.toml')}</code>):</div>
        <div class="code-box" id="cl-cmd">[mcp_servers.caravel]
url = "http://127.0.0.1:${+st.claudeMcpPort || 47823}/mcp"
http_headers = { "Authorization" = "Bearer ${esc(cs.mcpToken || '')}" }</div>
        <div class="flex" style="margin-top:8px"><button class="btn sm" id="cx-install">${icon('check')} In Codex eintragen</button><button class="btn ghost sm" id="cl-copy">${icon('copy')} Kopieren</button></div>` : `<div class="muted" style="font-size:12px;margin:10px 0 6px">Einmalig in einem Terminal ausführen (danach steht Caravel in Claude Code als Werkzeug bereit):</div>
        <div class="code-box" id="cl-cmd">claude mcp add --transport http --scope user caravel http://127.0.0.1:${+st.claudeMcpPort || 47823}/mcp --header "Authorization: Bearer ${esc(cs.mcpToken || '')}"</div>
        <button class="btn ghost sm" id="cl-copy" style="margin-top:8px">${icon('copy')} Befehl kopieren</button>`}` : ''}
      </div>` : ''}`,
    adblock: `<h3>Werbeblocker</h3>
      <div class="set-row"><div><div class="t">Werbung & Tracker blockieren</div><div class="d">Nutzt die Filterlisten von uBlock Origin (uBlock filters, Quick fixes, EasyList, EasyPrivacy, EasyList Germany u. a.) inklusive der Skriptfilter gegen YouTube-Werbung. Die Listen werden täglich aktualisiert.</div></div><label class="switch"><input type="checkbox" data-s="adblock" ${st.adblock !== false ? 'checked' : ''}><span></span></label></div>
      <div class="set-row"><div><div class="t">Cookie-Banner ausblenden</div><div class="d">Blendet Einwilligungs-Dialoge aus (uBlock-Liste „Cookie Notices“). Einzelne Seiten können dadurch anders aussehen.</div></div><label class="switch"><input type="checkbox" data-s="adblockCookies" ${st.adblockCookies ? 'checked' : ''}><span></span></label></div>
      <div class="set-row" style="display:block"><div class="t">Pausiert auf</div>
        ${(st.adblockAllowlist || []).length ? st.adblockAllowlist.map(h => `<div class="flex" style="margin-top:8px"><span class="grow">${esc(h)}</span><button class="btn ghost sm" data-allow="${esc(h)}">Entfernen</button></div>`).join('') : '<div class="d" style="margin-top:6px">Keine Ausnahmen. Über das Schild-Symbol in der Adressleiste lässt sich der Blocker pro Website pausieren.</div>'}
      </div>`,
    vpn: `<h3>VPN</h3>
      <div class="set-row"><div><div class="t">Beim Start automatisch verbinden</div><div class="d">Verbindet mit dem zuletzt gewählten Tor-Land bzw. Server.</div></div><label class="switch"><input type="checkbox" data-s="vpnAutoConnect" ${st.vpnAutoConnect ? 'checked' : ''}><span></span></label></div>
      <div class="set-row" style="display:block"><div class="t">So funktioniert das VPN in Caravel</div>
        <div class="d" style="max-width:none;margin-top:6px;line-height:1.6">
          <b>Tor (kostenlos):</b> Caravel bringt Tor mit. Du wählst das Ausgangsland, Caravel baut die Verbindung auf und leitet alle Tabs hindurch. Langsamer als ein kommerzielles VPN, dafür ohne Konto und ohne Kosten.<br>
          <b>Eigene Server:</b> WireGuard-Konfigurationen (z. B. kostenlos bei Proton VPN oder von Mullvad, IVPN, Windscribe) sowie SOCKS5- und HTTP(S)-Zugänge deines Anbieters. WireGuard läuft direkt in Caravel, ohne Treiber und ohne Administratorrechte.<br>
          Das VPN gilt für den Browser, nicht für andere Programme auf dem PC. WebRTC wird bei aktivem VPN so eingeschränkt, dass deine echte IP nicht durchsickert.</div>
      </div>
      <div class="flex"><button class="btn" id="vpn-open">${icon('vpn')} VPN-Menü öffnen</button></div>`,
    privacy: `<h3>Privatsphäre & Sicherheit</h3>
      <div class="set-row"><div><div class="t">Browserdaten löschen</div><div class="d">Entfernt die gewählten Daten aller Websites.</div></div><div class="flex"><button class="btn ghost sm" data-clear="cache">Cache</button><button class="btn ghost sm" data-clear="cookies">Cookies</button><button class="btn ghost sm" data-clear="storage">Website-Daten</button><button class="btn ghost sm" data-clear="history">Verlauf</button></div></div>
      <div class="set-row" style="display:block"><div class="t">Gespeicherte Website-Berechtigungen</div>
        ${perms.length ? perms.map(([origin, p]) => `<div class="flex" style="margin-top:8px"><span class="grow" style="word-break:break-all">${esc(origin)}<br><span class="muted" style="font-size:12px">${Object.entries(p).map(([k, v]) => `${PERM_DE[k] || k}: ${v ? 'erlaubt' : 'blockiert'}`).join(' · ')}</span></span><button class="btn ghost sm" data-perm="${esc(origin)}">Zurücksetzen</button></div>`).join('') : '<div class="d" style="margin-top:6px">Keine gespeicherten Berechtigungen.</div>'}
      </div>`,
    performance: `<h3>Leistung</h3>
      <div class="set-row"><div><div class="t">Tab-Schlaf</div><div class="d">Inaktive Tabs werden nach dieser Zeit schlafen gelegt und geben ihren Arbeitsspeicher frei. Sie wachen beim Anklicken sofort wieder auf. Tabs mit Ton schlafen nie.</div></div><select class="input" data-s="sleepMinutes" data-num>${[[0, 'Nie'], [5, '5 Minuten'], [15, '15 Minuten'], [30, '30 Minuten'], [60, '1 Stunde'], [180, '3 Stunden']].map(([v, l]) => `<option value="${v}" ${+st.sleepMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set-row"><div><div class="t">Jetzt aufräumen</div><div class="d">Alle Hintergrund-Tabs sofort schlafen legen.</div></div><button class="btn ghost" id="set-sleep">${icon('zzz')} Tabs schlafen legen</button></div>`,
    focus: `<h3>Fokus-Modus</h3>
      <div class="set-row"><div><div class="t">Standarddauer</div></div><select class="input" data-s="focusMinutes" data-num>${[15, 25, 45, 60, 90].map(v => `<option value="${v}" ${+st.focusMinutes === v ? 'selected' : ''}>${v} Minuten</option>`).join('')}</select></div>
      <div class="field" style="margin-top:14px"><label>Gesperrte Websites (eine Domain pro Zeile)</label><textarea class="input" rows="9" id="set-blocklist">${esc(st.focusBlocklist.join('\n'))}</textarea><span class="hint">Subdomains werden automatisch mitgesperrt (z. B. m.youtube.com).</span></div>
      <div class="card"><div class="flex"><span style="color:var(--accent)">${icon('sparkles')}</span><div>Bisher <b>${S.data.focusStats.sessions}</b> abgeschlossene Sessions · <b>${S.data.focusStats.minutes}</b> fokussierte Minuten</div></div></div>`,
    about: `<div class="about-hero">${$('.logo').outerHTML.replace('class="logo"', 'style="width:64px;height:64px"').replace('id="lg"', 'id="lg2"').replace('url(#lg)', 'url(#lg2)')}<div><h4>Caravel</h4><div class="muted">Version ${esc(info.version)} · Chromium ${esc(info.chrome)}</div></div></div>
      <p style="line-height:1.6">Caravel ist ein Browser für Menschen, die im Web arbeiten, lernen und entdecken. Er verbindet die Chromium-Engine mit Ideen, die andere Browser nicht haben: <b>Spaces</b>, <b>Split View</b>, <b>Peek</b>, <b>Fokus-Modus</b>, <b>Seiten-Notizen</b>, <b>Zeitkapseln</b>, <b>Tab-Schlaf</b>, <b>Ambient-Farben</b>, einen <b>Leser-Modus mit Vorlesefunktion</b> und <b>Chromecast</b>.</p>
      <div class="card"><div class="kbd-list"><div>Electron</div><div>${esc(info.electron)}</div><div>Chromium</div><div>${esc(info.chrome)}</div><div>Node.js</div><div>${esc(info.node)}</div><div>Download-Ordner</div><div>${esc(info.downloads)}</div></div></div>
      <p class="muted" style="font-size:12px;line-height:1.6">Chrome-Erweiterungen: electron-chrome-extensions (GPL-3.0), electron-chrome-web-store (MIT). Werbeblocker: @ghostery/adblocker (MPL-2.0) mit den Filterlisten von uBlock Origin (GPL-3.0) und EasyList (GPL-3.0/CC BY-SA 3.0). VPN: Tor (BSD-3-Clause), wireproxy (ISC). Leser-Modus: Mozilla Readability (Apache-2.0), Turndown (MIT). Chromecast: chromecast-api (MIT).<br>„Claude“ ist eine Marke von Anthropic, „ChatGPT“ und „Codex“ sind Marken von OpenAI. Caravel ist ein unabhängiges Projekt und steht in keiner Verbindung zu Anthropic, OpenAI, Google oder dem Tor Project.</p>`
  }
  showModal(`<div class="settings"><nav><h2>Einstellungen</h2>${nav.map(([k, ic, l]) => `<button data-sec="${k}" class="${k === section ? 'on' : ''}">${icon(ic)} ${l}</button>`).join('')}</nav><section><button class="icon-btn sm close-x" data-close>${icon('x')}</button>${sections[section]}</section></div>`, { wide: true })
  const card = $('#modal-card')
  card.querySelectorAll('[data-sec]').forEach(b => { b.onclick = () => openSettings(b.dataset.sec) })
  const apply = () => { save('settings'); applySettings() }
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
        toast('In Codex eingetragen', `${file} – Codex ggf. neu starten. Caravel erscheint dort als MCP-Server „caravel“.`, 'check', { duration: 7000 })
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
      clInstall.textContent = 'Wird installiert …'
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
    ['Leser-Modus', 'F9'], ['Fokus-Modus', 'Strg Umschalt F'], ['Screenshot', 'Strg Umschalt X'], ['Seiten-Notizen', 'Strg Umschalt N'],
    ['Lesezeichen', 'Strg D'], ['Auf Seite suchen', 'Strg F'], ['Verlauf', 'Strg H'], ['Downloads', 'Strg J'], ['Erweiterungen', 'Strg Umschalt E'],
    ...(dockEnabled() ? [[`${assistant().name}-Seitenleiste`, 'Strg E'], [`Seite an ${assistant().name} übergeben`, 'Strg Umschalt L']] : []),
    ['Seitenleiste', 'Strg B'], ['Zoom', 'Strg + / Strg − / Strg 0'], ['Vollbild', 'F11'], ['Entwicklertools', 'F12'], ['Einstellungen', 'Strg ,']
  ]
  showModal(`<div class="modal-head"><h2>Tastenkürzel</h2><button class="icon-btn sm" data-close>${icon('x')}</button></div><div class="modal-body"><div class="kbd-list">${list.map(([a, b]) => `<div>${esc(a)}</div><div>${b.split(' / ').map(x => `<kbd>${esc(x)}</kbd>`).join(' ')}</div>`).join('')}</div></div><div class="modal-foot"><button class="btn" data-close>Alles klar</button></div>`)
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

function zoom (dir) {
  const t = activeTab()
  if (!t?.ready) return
  t.zoom = dir === 0 ? 0 : Math.max(-5, Math.min(6, t.zoom + dir * 0.5))
  t.webview.setZoomLevel(t.zoom)
  const pct = Math.round(Math.pow(1.2, t.zoom) * 100)
  $$('.toast[data-zoom]').forEach(x => x.remove())
  toast(`Zoom ${pct} %`, 'Strg+0 setzt zurück', 'zoomIn', { duration: 1400 })
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
  for (const t of S.tabs.values()) if (!isVisible(t) && !t.audible) sleepTab(t)
}

function cycleTab (dir) {
  const sp = curSpace()
  const ids = sp.tabIds
  if (ids.length < 2) return
  const i = ids.indexOf(sp.activeId)
  activate(ids[(i + dir + ids.length) % ids.length])
}

function goBack () { const t = activeTab(); if (t?.ready && t.webview.canGoBack()) t.webview.goBack() }
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
  'Ctrl+Shift+N': () => togglePanel('notes'),
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
    media: p.mediaTypes.includes('video') && p.mediaTypes.includes('audio') ? 'deine Kamera und dein Mikrofon verwenden' : p.mediaTypes.includes('video') ? 'deine Kamera verwenden' : 'dein Mikrofon verwenden',
    geolocation: 'deinen Standort abrufen',
    notifications: 'dir Benachrichtigungen senden',
    'clipboard-read': 'deine Zwischenablage lesen',
    'display-capture': 'deinen Bildschirm aufnehmen',
    openExternal: 'eine externe Anwendung öffnen',
    midi: 'MIDI-Geräte verwenden',
    midiSysex: 'MIDI-Geräte steuern',
    'idle-detection': 'erkennen, ob du aktiv bist',
    'storage-access': 'auf gespeicherte Daten zugreifen',
    'top-level-storage-access': 'auf gespeicherte Daten zugreifen'
  }[p.permission] || `die Berechtigung „${p.permission}“ nutzen`
  const ic = { media: 'camera', geolocation: 'globe', notifications: 'info', openExternal: 'external' }[p.permission] || 'shield'
  box.innerHTML = `<div class="p-head"><div class="t-ico">${icon(ic)}</div><div><div class="p-origin">${esc(p.origin.replace(/^https?:\/\//, ''))}</div><div class="muted">möchte ${esc(what)}.</div></div></div>
    <div class="p-foot"><label><input type="checkbox" id="perm-remember" checked> Entscheidung merken</label><button class="btn ghost sm" data-p="0">Blockieren</button><button class="btn sm" data-p="1">Zulassen</button></div>`
  box.hidden = false
  box.onclick = e => {
    const b = e.target.closest('[data-p]'); if (!b) return
    const allow = b.dataset.p === '1'
    const remember = $('#perm-remember').checked
    A.send('perm:respond', p.id, allow, remember)
    if (remember) {
      S.data.permissions[p.origin] = { ...(S.data.permissions[p.origin] || {}), [p.permission]: allow }
    }
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
  $('#btn-back').innerHTML = icon('back')
  $('#btn-forward').innerHTML = icon('forward')
  $('#btn-back').onclick = goBack
  $('#btn-forward').onclick = goForward
  $('#btn-reload').onclick = () => reload(false)
  $('#btn-reader').innerHTML = icon('reader')
  $('#btn-reader').onclick = toggleReader
  $('#btn-star').onclick = toggleBookmark
  $('#btn-adblock').onclick = () => S.popover === 'adblock' ? hidePopover() : openAdblockPopover()
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
    writeSession()
  }
}

function initGlobalEvents () {
  document.addEventListener('mousedown', e => {
    if (!$('#menu').hidden && !e.target.closest('#menu')) hideMenu()
    if (!$('#popover').hidden && !e.target.closest('#popover') && !e.target.closest('#btn-cast, #btn-focus, #btn-adblock, #btn-vpn, #focus-hud')) hidePopover()
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
  document.addEventListener('drop', e => {
    const url = e.dataTransfer.getData('text/uri-list')
    if (url) { e.preventDefault(); createTab({ url }) }
  })

  A.on('shortcut', handleShortcut)
  A.on('open-tab', ({ url, background, opener }) => {
    const openerTab = opener ? tabByWc(opener) : null
    createTab({ url, background: !!background, spaceId: openerTab?.spaceId || S.activeSpace, afterId: openerTab?.id })
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
  })
  A.on('ext:create-tab', async ({ reqId, url, active }) => {
    const t = createTab({ url: url || NEWTAB, background: !active })
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
    if (st.status === 'error') toast('Werbeblocker', `Filterlisten konnten nicht geladen werden: ${st.error}`, 'warning', { duration: 7000 })
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
    if (t) updateTabEl(t)
  })
  // Anfragen des eingebauten MCP-Servers (Claude Code). Tab-IDs = Tab-Nummern der Oberfläche.
  A.on('mcp:ui', async ({ reqId, op, id, url, background }) => {
    const reply = v => A.send('ui:reply', reqId, v)
    const byNum = n => S.tabs.get('t' + n)
    const missing = n => ({ error: `Tab ${n} existiert nicht. Mit list_tabs die aktuellen IDs abrufen.` })
    try {
      if (op === 'tabs') {
        return reply([...S.tabs.values()].map(t => ({
          id: +t.id.slice(1), title: t.title, url: displayUrl(t.url) || 'Neuer Tab',
          active: t.id === curSpace().activeId, sleeping: t.sleeping, space: space(t.spaceId)?.name
        })))
      }
      if (op === 'resolve') {
        const t = id ? byNum(id) : activeTab()
        if (!t) return reply(id ? missing(id) : { error: 'Kein aktiver Tab.' })
        if (!t.webview) wake(t)
        await whenReady(t)
        return reply(t.wcId)
      }
      if (op === 'open') {
        const t = createTab({ url, background: !!background })
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
      reply({ error: 'Unbekannte Anfrage' })
    } catch (err) { reply({ error: err.message }) }
  })
  A.on('crx:sidepanel-open', info => openExtPanel(info))
  A.on('crx:sidepanel-close', ({ extId, tabId }) => closeExtPanel(extId, tabId, false))
  A.on('dl:update', d => {
    const isNew = !S.downloads.has(d.id)
    const prev = S.downloads.get(d.id)
    S.downloads.set(d.id, d)
    if (isNew) {
      toast('Download gestartet', d.name, 'download', { actions: [{ label: 'Anzeigen', run: () => togglePanel('downloads') }] })
      // Tab, der nur für diesen Download geöffnet wurde, wieder schließen (wie in Chrome)
      const t = d.wcId && tabByWc(d.wcId)
      if (t && t.url === d.url && !S.data.history.some(h => h.url === d.url)) closeTab(t.id)
    }
    if (prev?.state === 'progressing' && d.state === 'completed') {
      toast('Download abgeschlossen', d.name, 'check', { actions: [{ label: 'Öffnen', run: () => A.send('dl:open', d.path) }], duration: 6000 })
    }
    if (S.panel === 'downloads') renderPanel()
    updateDownloadDot()
  })
  A.on('perm:request', p => { S.perms.push(p); if (S.perms.length === 1) showNextPermission() })
  A.on('cast:devices', devs => { S.cast.devices = devs; if (S.popover === 'cast') renderCast() })
  A.on('cast:status', st => {
    S.cast.status = st
    const live = st && !['STOPPED', 'FINISHED'].includes(st.state)
    $('#btn-cast').classList.toggle('on', !!live)
    if (S.popover === 'cast') renderCast()
  })
  A.on('window-fullscreen', on => { S.windowFull = on })
}

function startSleepTimer () {
  setInterval(() => {
    const min = +settings().sleepMinutes
    if (!min) return
    const limit = Date.now() - min * 60000
    for (const t of S.tabs.values()) {
      if (t.webview && !t.audible && !isVisible(t) && t.lastActive < limit) sleepTab(t)
    }
  }, 30000)
}

async function boot () {
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
        createTab({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, spaceId: sp.id, sleeping: true, silent: true })
      }
      sp.activeId = sp.tabIds[s.activeIndex] || sp.tabIds[0] || null
    }
  }
  if (!S.spaces.length) S.spaces.push({ id: 'space-personal', name: 'Persönlich', color: '#f2545b', icon: '✦', tabIds: [], activeId: null, split: null })
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
