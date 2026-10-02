// Caravel – Hauptprozess
const {
  app, BrowserWindow, session, ipcMain, protocol, net, Menu, clipboard, shell,
  dialog, webContents, nativeTheme, nativeImage, desktopCapturer
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const autodark = require('./autodark')
const { pathToFileURL } = require('node:url')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore, installExtension, uninstallExtension } = require('electron-chrome-web-store')
const { Store } = require('./store')
const { FocusGuard } = require('./focus')
const { AdBlock } = require('./adblock')
const { CastManager } = require('./cast')
const { VpnManager } = require('./vpn')
const { CrxCompat } = require('./crx-compat')
const { McpServer } = require('./mcp-server')
const i18n = require('../shared/i18n')
const { t } = i18n

const ROOT = path.join(__dirname, '..')
const PAGES_DIR = path.join(ROOT, 'pages')
const SHARED_DIR = path.join(ROOT, 'shared')
const PRELOAD_DIR = path.join(ROOT, 'preload')
const UI_PRELOAD = path.join(PRELOAD_DIR, 'ui-preload.js')
const TAB_PRELOAD = path.join(PRELOAD_DIR, 'tab-preload.js')
const ICON = path.join(ROOT, 'assets', 'icon.png')
// Mitgelieferte Programme (Tor, wireproxy) liegen außerhalb der asar-Datei
const VENDOR_DIR = path.join(ROOT, '..', 'vendor').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
const PARTITION = 'persist:caravel'
const CLAUDE_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn' // „Claude in Chrome“ (Anthropic)

app.setName('Caravel')
app.setAppUserModelId('app.caravel.browser')
if (process.env.CARAVEL_PROFILE) app.setPath('userData', process.env.CARAVEL_PROFILE)

protocol.registerSchemesAsPrivileged([
  { scheme: 'caravel', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win = null
let store = null
let extensions = null
let focusGuard = null
let adblock = null
let cast = null
let vpn = null
let crx = null
let mcp = null
let mcpError = null
let tabsSession = null
let uiReady = false
let peekWcId = null
let uiAccent = '#f2545b'
let uiActiveWcId = null
let suppressSelect = false
const pendingUrls = []
const pendingRequests = new Map()
const pendingPermissions = new Map()
const downloads = new Map()
let requestSeq = 0
let pendingCapture = null // Tab-/Bildschirmspiegelung: welche Quelle getDisplayMedia liefern soll

// ---------------------------------------------------------------------------
// Hilfsfunktionen

function send (channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function uiRequest (channel, payload, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++requestSeq
    pendingRequests.set(id, resolve)
    send(channel, { ...payload, reqId: id })
    setTimeout(() => {
      if (pendingRequests.delete(id)) reject(new Error('UI-Zeitüberschreitung'))
    }, timeout)
  })
}

function cleanUserAgent (ua) {
  return ua
    .replace(/\sElectron\/\S+/, '')
    .replace(/\s(caravel-browser|aether-browser|Caravel)\/\S+/i, '')
}

function urlFromArgv (argv) {
  for (const arg of argv.slice(1).reverse()) {
    if (!arg || arg.startsWith('-')) continue
    if (/^(https?|file|caravel):/i.test(arg)) return arg
    try {
      if (fs.statSync(arg).isFile() && /\.(html?|pdf|svg|txt|png|jpe?g|gif|webp)$/i.test(arg)) {
        return pathToFileURL(path.resolve(arg)).href
      }
    } catch {}
  }
  return null
}

function openUrlInUi (url, background = false) {
  if (!url) return
  if (uiReady) send('open-tab', { url, background })
  else pendingUrls.push(url)
}

function searchUrl (query) {
  const engines = {
    google: 'https://www.google.com/search?q=%s',
    duckduckgo: 'https://duckduckgo.com/?q=%s',
    bing: 'https://www.bing.com/search?q=%s',
    ecosia: 'https://www.ecosia.org/search?q=%s',
    startpage: 'https://www.startpage.com/do/search?q=%s',
    brave: 'https://search.brave.com/search?q=%s'
  }
  const tpl = engines[store.get('settings').searchEngine] || engines.google
  return tpl.replace('%s', encodeURIComponent(query))
}

function uniquePath (dir, name) {
  const ext = path.extname(name)
  const base = path.basename(name, ext) || 'download'
  let candidate = path.join(dir, base + ext)
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}

// ---------------------------------------------------------------------------
// caravel:// – interne Seiten (Neuer Tab, Fehlerseite, Fokus-Sperre)

function registerOdeProtocol (ses) {
  ses.protocol.handle('caravel', request => {
    const url = new URL(request.url)
    const rel = url.pathname === '/' || url.pathname === '' ? `${url.hostname}.html` : url.pathname.slice(1)
    // caravel://<seite>/shared/… liefert gemeinsame Dateien (Übersetzungen)
    const dir = rel.startsWith('shared/') ? SHARED_DIR : PAGES_DIR
    const file = path.normalize(path.join(dir, rel.slice(dir === SHARED_DIR ? 7 : 0)))
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      return new Response(t('Nicht gefunden'), { status: 404 })
    }
    return net.fetch(pathToFileURL(file).href)
  })
}

// ---------------------------------------------------------------------------
// Tastenkürzel (auch wenn der Fokus in einer Webseite liegt)

const SHORTCUTS = new Set([
  'Ctrl+T', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+L', 'Ctrl+K', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+R', 'F5',
  'Ctrl+Shift+R', 'Ctrl+F', 'F12', 'Ctrl+Shift+I', 'Ctrl+Shift+S', 'Ctrl+D', 'Ctrl++', 'Ctrl+=', 'Ctrl+-',
  'Ctrl+0', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'F11', 'Ctrl+H', 'Ctrl+J', 'Ctrl+B', 'F9', 'Ctrl+Shift+F',
  'Ctrl+Shift+X', 'Ctrl+Shift+N', 'Ctrl+P', 'Ctrl+,', 'Ctrl+Shift+E', 'Ctrl+E', 'Ctrl+Shift+L'
])

function comboFor (input) {
  if (input.type !== 'keyDown') return null
  let key = input.key
  if (key.length === 1) key = key.toUpperCase()
  if (key === 'Add') key = '+'
  if (key === 'Subtract') key = '-'
  const parts = []
  if (input.control) parts.push('Ctrl')
  if (input.shift && key !== '+') parts.push('Shift')
  if (input.alt) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

function handleShortcuts (wc, isUi) {
  wc.on('before-input-event', (event, input) => {
    const combo = comboFor(input)
    if (!combo) return
    const digit = /^(Ctrl|Alt)\+([1-9])$/.exec(combo)
    if (SHORTCUTS.has(combo) || digit || (combo === 'Escape' && !isUi && wc.id === peekWcId)) {
      event.preventDefault()
      send('shortcut', combo)
    }
  })
}

// ---------------------------------------------------------------------------
// Tabs (webview)

// electron-chrome-extensions markiert jeden neu registrierten Tab automatisch als aktiv
// und meldet das über selectTab() zurück. Maßgeblich ist aber der aktive Tab der
// Oberfläche – daher werden diese automatischen Wechsel unterdrückt und anschließend
// wieder synchronisiert.
function withSuppressedSelect (fn) {
  suppressSelect = true
  try { fn() } finally { suppressSelect = false }
}

function syncActiveTab () {
  const wc = uiActiveWcId && webContents.fromId(uiActiveWcId)
  if (!wc || wc.isDestroyed()) return
  try { withSuppressedSelect(() => extensions.selectTab(wc)) } catch {}
}

function setupTab (wc) {
  try { withSuppressedSelect(() => extensions.addTab(wc, win)) } catch (err) { console.warn('[ext] addTab', err) }
  syncActiveTab()
  const id = wc.id
  wc.once('destroyed', () => crx.tabRemoved(id))

  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    if (disposition === 'new-window' && features) {
      // Echte Popups (z. B. OAuth-Anmeldungen) brauchen window.opener → eigenes Fenster
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, backgroundColor: '#ffffff' }
      }
    }
    send('open-tab', { url, background: disposition === 'background-tab', opener: wc.id })
    return { action: 'deny' }
  })

  wc.on('did-create-window', child => {
    vpn.track(child.webContents)
    child.webContents.setWindowOpenHandler(({ url }) => {
      send('open-tab', { url, background: false })
      return { action: 'deny' }
    })
  })

  wc.on('context-menu', (_e, params) => showContextMenu(wc, params))
  handleShortcuts(wc, false)
  focusGuard.attach(wc)
  vpn.track(wc)
  autodark.track(wc)
}

function showContextMenu (wc, params) {
  const items = []
  const action = (name, extra = {}) => () => send('ctx-action', { wcId: wc.id, action: name, ...extra })
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }) }
  const ai = assistantName(store.get('settings'))
  const claude = ai && store.get('settings').claudeSidebar

  if (params.linkURL) {
    items.push({ label: t('Link in neuem Tab öffnen'), click: () => send('open-tab', { url: params.linkURL }) })
    items.push({ label: t('Link im Hintergrund öffnen'), click: () => send('open-tab', { url: params.linkURL, background: true }) })
    items.push({ label: t('Peek – schwebende Vorschau'), click: action('peek', { url: params.linkURL }) })
    items.push({ label: t('In Split View öffnen'), click: action('split', { url: params.linkURL }) })
    items.push({ label: t('Link-Adresse kopieren'), click: () => clipboard.writeText(params.linkURL) })
    sep()
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: t('Bild in neuem Tab öffnen'), click: () => send('open-tab', { url: params.srcURL }) })
    items.push({ label: t('Bild speichern'), click: () => wc.downloadURL(params.srcURL) })
    items.push({ label: t('Bild kopieren'), click: () => wc.copyImageAt(params.x, params.y) })
    items.push({ label: t('Bildadresse kopieren'), click: () => clipboard.writeText(params.srcURL) })
    sep()
  }
  if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL) {
    if (!params.srcURL.startsWith('blob:')) {
      items.push({ label: t('Medium streamen …'), click: action('cast', { url: params.srcURL }) })
    }
    items.push({ label: t('Medienadresse kopieren'), click: () => clipboard.writeText(params.srcURL) })
    sep()
  }
  if (params.isEditable) {
    for (const s of params.dictionarySuggestions || []) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    }
    if (params.misspelledWord) {
      items.push({ label: t('Zum Wörterbuch hinzufügen'), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) })
      sep()
    }
    items.push({ label: t('Rückgängig'), role: 'undo' }, { label: t('Wiederholen'), role: 'redo' }, { type: 'separator' })
    items.push({ label: t('Ausschneiden'), role: 'cut' }, { label: t('Kopieren'), role: 'copy' }, { label: t('Einfügen'), role: 'paste' })
    items.push({ label: t('Alles auswählen'), role: 'selectAll' })
    sep()
  } else if (params.selectionText) {
    const text = params.selectionText.trim()
    const short = text.length > 24 ? text.slice(0, 24) + '…' : text
    items.push({ label: t('Kopieren'), role: 'copy' })
    if (claude) {
      items.push({ label: t('{ai} fragen …', { ai }), click: action('claude-selection', { text }) })
      items.push({ label: t('Mit {ai} erklären', { ai }), click: action('claude-selection', { text, prompt: 'explain' }) })
      items.push({ label: t('Mit {ai} übersetzen', { ai }), click: action('claude-selection', { text, prompt: 'translate' }) })
    }
    items.push({ label: t('Im Web nach „{q}“ suchen', { q: short }), click: () => send('open-tab', { url: searchUrl(text) }) })
    items.push({ label: t('Als Notiz zu dieser Seite speichern'), click: action('note', { text }) })
    sep()
  }
  if (!params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
    items.push({ label: t('Zurück'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() })
    items.push({ label: t('Vorwärts'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() })
    items.push({ label: t('Neu laden'), click: () => wc.reload() })
    sep()
    if (claude) {
      items.push({ label: t('Seite mit {ai} zusammenfassen', { ai }), click: action('claude-page', { prompt: 'summarize' }) })
      items.push({ label: t('Seite an {ai} übergeben', { ai }), click: action('claude-page', { prompt: 'context' }) })
    }
    items.push({ label: t('Seite als Markdown kopieren'), click: action('markdown') })
    items.push({ label: t('Leser-Modus'), click: action('reader') })
    items.push({ label: t('Screenshot aufnehmen'), click: action('screenshot') })
    items.push({ label: t('Streamen …'), click: action('cast') })
    items.push({ label: t('Seitenquelltext anzeigen'), click: () => send('open-tab', { url: 'view-source:' + wc.getURL() }) })
    sep()
  }

  try {
    const extItems = extensions.getContextMenuItems(wc, params)
    if (extItems.length) { sep(); items.push(...extItems); sep() }
  } catch {}

  items.push({ label: t('Untersuchen'), click: () => { wc.inspectElement(params.x, params.y) } })
  Menu.buildFromTemplate(items).popup({ window: win })
}

// ---------------------------------------------------------------------------
// Hauptfenster

function createWindow () {
  const dark = store.get('settings').theme !== 'light'
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: 'Caravel',
    icon: ICON,
    backgroundColor: dark ? '#0a1022' : '#eef1f8',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#0a1022' : '#eef1f8', symbolColor: dark ? '#e8ecf8' : '#101a33', height: 44 },
    webPreferences: {
      preload: UI_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  })

  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    if (!String(params.partition || '').startsWith(PARTITION)) return event.preventDefault()
    prefs.preload = TAB_PRELOAD
    prefs.contextIsolation = true
    prefs.nodeIntegration = false
    prefs.sandbox = true
    prefs.plugins = true
    prefs.spellcheck = true
    prefs.scrollBounce = true
    // Wie in Chrome einen deckenden Seitenhintergrund malen (weiß bzw. dunkel bei color-scheme: dark).
    // Electron-Webviews sind sonst durchsichtig: Seiten ohne eigene Hintergrundfarbe zeigten dann
    // dunklen Browser-Hintergrund mit schwarzem Text.
    prefs.transparent = false
  })
  win.webContents.on('did-attach-webview', (_e, wc) => setupTab(wc))
  win.webContents.setWindowOpenHandler(({ url }) => {
    openUrlInUi(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', e => e.preventDefault())
  handleShortcuts(win.webContents, true)

  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') send('shortcut', 'Alt+ArrowLeft')
    if (cmd === 'browser-forward') send('shortcut', 'Alt+ArrowRight')
  })
  win.on('enter-full-screen', () => send('window-fullscreen', true))
  win.on('leave-full-screen', () => send('window-fullscreen', false))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })

  win.loadFile(path.join(ROOT, 'ui', 'index.html'))

  // Entwickler-Hilfe: CARAVEL_DEBUG=1 leitet Konsolenmeldungen der Oberfläche ins Terminal
  if (process.env.CARAVEL_DEBUG) {
    win.webContents.on('console-message', e => console.log(`[ui:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`))
  }
}

// ---------------------------------------------------------------------------
// Erweiterungen

function extensionInfo (ext) {
  const m = ext.manifest || {}
  let icon = null
  const icons = m.icons || m.action?.default_icon || m.browser_action?.default_icon
  if (icons) {
    const rel = typeof icons === 'string' ? icons : icons[Object.keys(icons).sort((a, b) => b - a)[0]]
    try {
      const buf = fs.readFileSync(path.join(ext.path, rel))
      icon = nativeImage.createFromBuffer(buf).resize({ width: 48, height: 48 }).toDataURL()
    } catch {}
  }
  const unpacked = store.get('unpackedExtensions').includes(ext.path)
  let name = ext.name
  if (name?.startsWith('__MSG_')) name = m.short_name && !m.short_name.startsWith('__MSG_') ? m.short_name : ext.id
  return {
    id: ext.id,
    name: ext.id === CLAUDE_EXTENSION_ID ? 'Claude in Chrome' : name,
    version: ext.version,
    description: (m.description || '').startsWith('__MSG_') ? '' : (m.description || ''),
    icon,
    unpacked,
    options: m.options_page || m.options_ui?.page || null
  }
}

async function setupExtensions () {
  crx = new CrxCompat({ session: tabsSession, getWindow: () => win, sendUi: send })
  crx.activeTabId = () => uiActiveWcId
  // Farbschema wie Chrome als Client Hint mitsenden – Google & Co. wählen Hell/Dunkel auf dem Server
  // Außerdem die Standard-Client-Hints, die Electron bei Seitenaufrufen weglässt (ohne sie liefert
  // z. B. Google die einfache Variante für unbekannte Browser aus – ohne Dunkelmodus)
  const major = process.versions.chrome.split('.')[0]
  const baseHints = {
    'Sec-CH-UA': `"Not?A_Brand";v="24", "Chromium";v="${major}"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"'
  }
  crx.extraHeaders = (details, headers) => {
    if (!/^https:/.test(details.url)) return false
    const has = name => Object.keys(headers).some(k => k.toLowerCase() === name.toLowerCase())
    let changed = false
    for (const [k, v] of Object.entries(baseHints)) if (!has(k)) { headers[k] = v; changed = true }
    if (!has('Sec-CH-Prefers-Color-Scheme')) {
      headers['Sec-CH-Prefers-Color-Scheme'] = nativeTheme.shouldUseDarkColors ? '"dark"' : '"light"'
      changed = true
    }
    return changed
  }
  crx.installHeaderRules()
  crx.install()

  // Reihenfolge ist wichtig: crx-early vor, crx-late nach den Preloads der Bibliothek
  tabsSession.registerPreloadScript({ id: 'caravel-crx-early-frame', type: 'frame', filePath: path.join(PRELOAD_DIR, 'crx-early.js') })
  tabsSession.registerPreloadScript({ id: 'caravel-crx-early-sw', type: 'service-worker', filePath: path.join(PRELOAD_DIR, 'crx-early.js') })

  extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: tabsSession,
    async createTab (details) {
      const wcId = await uiRequest('ext:create-tab', { url: details.url, active: details.active !== false })
      const wc = webContents.fromId(wcId)
      return [wc, win]
    },
    selectTab (wc) {
      if (suppressSelect || wc.id === uiActiveWcId) return
      send('ext:select-tab', wc.id)
    },
    removeTab (wc) { send('ext:remove-tab', wc.id) },
    async createWindow (details) {
      const urls = [].concat(details.url || [])
      if (details.type === 'popup' && urls.length) {
        const popup = new BrowserWindow({
          width: details.width || 480,
          height: details.height || 640,
          autoHideMenuBar: true,
          icon: ICON,
          webPreferences: { session: tabsSession, sandbox: true, contextIsolation: true }
        })
        popup.loadURL(urls[0])
        return popup
      }
      for (const url of urls) openUrlInUi(url)
      return win
    },
    removeWindow (w) { if (w !== win) w.destroy() },
    assignTabDetails (details, wc) { crx.assignTabDetails(details, wc) },
    async requestPermissions () { return true }
  })

  tabsSession.registerPreloadScript({ id: 'caravel-crx-late-frame', type: 'frame', filePath: path.join(PRELOAD_DIR, 'crx-late.js') })
  tabsSession.registerPreloadScript({ id: 'caravel-crx-late-sw', type: 'service-worker', filePath: path.join(PRELOAD_DIR, 'crx-late.js') })
  tabsSession.registerPreloadScript({ id: 'mv2-background-fix', type: 'frame', filePath: path.join(PRELOAD_DIR, 'mv2-background-fix.js') })

  // Klick auf ein Erweiterungssymbol: Erweiterungen mit „openPanelOnActionClick“
  // öffnen wie in Chrome direkt ihre Seitenleiste.
  const actionApi = extensions.api?.browserAction
  if (actionApi?.activateClick) {
    const original = actionApi.activateClick.bind(actionApi)
    actionApi.activateClick = details => {
      const behavior = crx.sidePanel.get(details.extensionId)?.behavior
      if (!behavior?.openPanelOnActionClick) return original(details)
      const tabId = details.tabId >= 0 ? details.tabId : uiActiveWcId
      crx.call(null, details.extensionId, 'sidePanel.open', [{ tabId }]).catch(() => original(details))
    }
  }

  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)

  await installChromeWebStore({
    session: tabsSession,
    async beforeInstall (details) {
      const res = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [t('Hinzufügen'), t('Abbrechen')],
        defaultId: 0,
        cancelId: 1,
        title: t('Erweiterung hinzufügen'),
        message: t('„{name}“ zu Caravel hinzufügen?', { name: details.localizedName }),
        detail: t('Die Erweiterung wird aus dem Chrome Web Store installiert und kann auf Websites zugreifen, die du besuchst.'),
        icon: details.icon
      })
      return { action: res.response === 0 ? 'allow' : 'deny' }
    }
  }).catch(err => console.warn('[webstore]', err))

  for (const dir of store.get('unpackedExtensions')) {
    await tabsSession.extensions.loadExtension(dir, { allowFileAccess: true }).catch(err => console.warn('[ext] unpacked', dir, err.message))
  }

  tabsSession.extensions.on('extension-loaded', () => send('ext:changed'))
  tabsSession.extensions.on('extension-unloaded', () => send('ext:changed'))
}

// ---------------------------------------------------------------------------
// Downloads

function setupDownloads () {
  let seq = 0
  tabsSession.on('will-download', (_e, item, wc) => {
    const id = ++seq
    const wcId = wc && !wc.isDestroyed() ? wc.id : null
    if (!item.getSavePath()) item.setSavePath(uniquePath(app.getPath('downloads'), item.getFilename()))
    downloads.set(id, item)
    const info = () => ({
      id,
      name: path.basename(item.getSavePath()),
      url: item.getURL(),
      path: item.getSavePath(),
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      state: item.getState(),
      paused: item.isPaused(),
      started: Math.round(item.getStartTime() * 1000),
      wcId
    })
    send('dl:update', info())
    let last = 0
    item.on('updated', () => {
      const now = Date.now()
      if (now - last < 250) return
      last = now
      send('dl:update', info())
      updateTaskbarProgress()
    })
    item.once('done', () => {
      send('dl:update', info())
      updateTaskbarProgress()
    })
  })
}

function updateTaskbarProgress () {
  if (!win) return
  let received = 0; let total = 0
  for (const item of downloads.values()) {
    if (item.getState() !== 'progressing') continue
    received += item.getReceivedBytes()
    total += item.getTotalBytes()
  }
  win.setProgressBar(total > 0 ? received / total : -1)
}

// ---------------------------------------------------------------------------
// Berechtigungen

const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'window-management', 'speaker-selection'])

function setupPermissions () {
  let seq = 0
  tabsSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl).origin } catch { return '' } })()
    if (AUTO_ALLOW.has(permission) || origin.startsWith('chrome-extension://') || origin.startsWith('caravel://')) {
      return callback(true)
    }
    const saved = store.get('permissions')[origin]?.[permission]
    if (typeof saved === 'boolean') return callback(saved)
    const id = ++seq
    pendingPermissions.set(id, { callback, origin, permission })
    send('perm:request', { id, origin, permission, mediaTypes: details.mediaTypes || [], wcId: wc?.id })
  })
}

// ---------------------------------------------------------------------------
// VPN

function vpnConfigFromSettings () {
  const s = store.get('settings')
  if (s.vpnMode === 'server') {
    const server = s.vpnServers.find(x => x.id === s.vpnServerId) || s.vpnServers[0]
    return { mode: 'server', server, label: server?.name || t('Eigener Server') }
  }
  const name = Object.fromEntries(VpnManager.countries())[s.vpnCountry] || t('Automatisch')
  return { mode: 'tor', country: s.vpnCountry, label: `Tor · ${name}` }
}

// ---------------------------------------------------------------------------
// IPC

function registerIpc () {
  ipcMain.handle('store:all', () => store.data)
  ipcMain.handle('app:lang', () => i18n.lang)
  // Interne Seiten (Preload) brauchen die Sprache synchron, damit nichts erst deutsch aufblitzt
  ipcMain.on('app:lang-sync', e => { e.returnValue = i18n.lang })
  ipcMain.on('store:set', (_e, key, value) => {
    // Das MCP-Zugangstoken wird im Hauptprozess erzeugt – nicht durch einen älteren UI-Stand überschreiben
    if (key === 'settings' && value && !value.claudeMcpToken && store.get('settings').claudeMcpToken) {
      value = { ...value, claudeMcpToken: store.get('settings').claudeMcpToken }
    }
    store.set(key, value)
    if (key === 'settings') applySettings()
    if (key === 'bookmarks') notifyNewtabPages()
  })

  ipcMain.on('ui:ready', () => {
    uiReady = true
    for (const url of pendingUrls.splice(0)) send('open-tab', { url })
  })
  ipcMain.on('ui:reply', (_e, reqId, value) => {
    const resolve = pendingRequests.get(reqId)
    if (resolve) { pendingRequests.delete(reqId); resolve(value) }
  })
  ipcMain.on('ui:titlebar', (_e, color, symbolColor, height) => {
    try { win?.setTitleBarOverlay({ color, symbolColor, height: Math.round(height) || 44 }) } catch {}
  })
  ipcMain.on('ui:accent', (_e, color) => { uiAccent = color })
  ipcMain.on('ui:peek-wc', (_e, id) => { peekWcId = id })
  ipcMain.on('ui:fullscreen', (_e, on) => win?.setFullScreen(!!on))
  ipcMain.on('ui:webview', (_e, wcId) => {
    // Hilfs-Webviews (Claude-Seitenleiste, Peek) durchlaufen ebenfalls VPN und Tastenkürzel
    const wc = webContents.fromId(wcId)
    if (wc) { vpn.track(wc); autodark.track(wc) }
  })

  ipcMain.on('tab:activated', (_e, wcId) => {
    uiActiveWcId = wcId
    syncActiveTab()
  })

  ipcMain.handle('tab:screenshot', async (_e, wcId) => {
    const wc = webContents.fromId(wcId)
    if (!wc) return null
    const image = await wc.capturePage()
    clipboard.writeImage(image)
    const dir = path.join(app.getPath('pictures'), 'Caravel')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = path.join(dir, `Screenshot ${stamp}.png`)
    fs.writeFileSync(file, image.toPNG())
    return { file, dataUrl: image.resize({ width: 480 }).toDataURL() }
  })

  ipcMain.handle('suggest', async (_e, query) => {
    try {
      const res = await tabsSession.fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&kl=${i18n.lang === 'en' ? 'us-en' : 'de-de'}`)
      const json = await res.json()
      return json.map(x => x.phrase).slice(0, 5)
    } catch { return [] }
  })

  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)))

  // Werbeblocker
  ipcMain.on('adblock:scriptlets', (e, url) => {
    try { e.returnValue = adblock?.scriptletsFor(url) || [] } catch { e.returnValue = [] }
  })
  ipcMain.handle('adblock:info', () => ({
    enabled: adblock.enabled, status: adblock.status, updated: adblock.updated, total: adblock.blockedTotal
  }))
  ipcMain.handle('adblock:update', async () => {
    await adblock.load({ forceUpdate: true })
    return { updated: adblock.updated }
  })

  // Erweiterungen
  ipcMain.handle('ext:list', () => tabsSession.extensions.getAllExtensions().map(extensionInfo))
  ipcMain.handle('ext:remove', async (_e, id) => {
    const ext = tabsSession.extensions.getExtension(id)
    if (!ext) return
    const unpacked = store.get('unpackedExtensions')
    if (unpacked.includes(ext.path)) {
      tabsSession.extensions.removeExtension(id)
      store.set('unpackedExtensions', unpacked.filter(p => p !== ext.path))
    } else {
      await uninstallExtension(id, { session: tabsSession })
    }
  })
  ipcMain.handle('ext:load-unpacked', async () => {
    const res = await dialog.showOpenDialog(win, { title: t('Entpackte Erweiterung laden'), properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const dir = res.filePaths[0]
    const ext = await tabsSession.extensions.loadExtension(dir, { allowFileAccess: true })
    const list = store.get('unpackedExtensions')
    if (!list.includes(dir)) store.set('unpackedExtensions', [...list, dir])
    return extensionInfo(ext)
  })
  ipcMain.handle('ext:newtab-override', () => {
    try { return extensions.getURLOverrides().newtab || null } catch { return null }
  })
  ipcMain.on('crx:sidepanel-closed', (_e, extId, tabId) => crx.panelClosed(extId, tabId))

  // Claude
  ipcMain.handle('claude:status', () => {
    const s = store.get('settings')
    return {
      extensionInstalled: !!tabsSession.extensions.getExtension(CLAUDE_EXTENSION_ID),
      extensionId: CLAUDE_EXTENSION_ID,
      nativeHost: hasClaudeNativeHost(),
      mcpEnabled: !!s.claudeMcp,
      mcpRunning: !!mcp?.server?.listening,
      mcpPort: s.claudeMcpPort,
      mcpToken: s.claudeMcpToken,
      mcpError,
      ...codexStatus(s)
    }
  })
  ipcMain.handle('codex:install-mcp', () => {
    writeCodexConfig(store.get('settings'))
    return CODEX_CONFIG
  })
  ipcMain.handle('claude:mcp-new-token', () => {
    const s = store.get('settings')
    store.set('settings', { ...s, claudeMcpToken: require('node:crypto').randomBytes(24).toString('base64url') })
    applySettings()
    return store.get('settings').claudeMcpToken
  })
  ipcMain.handle('claude:install-extension', async () => {
    await installExtension(CLAUDE_EXTENSION_ID, { session: tabsSession })
    return true
  })
  ipcMain.handle('claude:open-extension', (_e, tabId) => {
    const id = tabId || uiActiveWcId
    try {
      extensions.api.browserAction.activateClick({ extensionId: CLAUDE_EXTENSION_ID, tabId: id })
      return true
    } catch (err) { return { error: err.message } }
  })
  ipcMain.on('app:relaunch', () => { app.relaunch(); app.quit() })

  // VPN
  ipcMain.handle('vpn:state', () => ({ ...vpn.state, countries: VpnManager.countries() }))
  ipcMain.handle('vpn:connect', () => vpn.connect(vpnConfigFromSettings()))
  ipcMain.handle('vpn:disconnect', () => vpn.disconnect())
  ipcMain.handle('vpn:new-identity', () => vpn.newIdentity())
  ipcMain.handle('vpn:set-country', async (_e, country) => {
    const s = store.get('settings')
    store.set('settings', { ...s, vpnCountry: country })
    if (vpn.state.status === 'on' && vpn.state.mode === 'tor') {
      await vpn.setTorCountry(country)
      vpn.set({ label: vpnConfigFromSettings().label })
    }
  })
  ipcMain.handle('vpn:import-wireguard', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: t('WireGuard-Konfiguration importieren'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'WireGuard', extensions: ['conf'] }]
    })
    if (res.canceled) return []
    return res.filePaths.map(f => ({ name: path.basename(f, '.conf'), config: fs.readFileSync(f, 'utf8') }))
  })

  // Downloads
  ipcMain.on('dl:open', (_e, file) => shell.openPath(file))
  ipcMain.on('dl:show', (_e, file) => shell.showItemInFolder(file))
  ipcMain.on('dl:control', (_e, id, action) => {
    const item = downloads.get(id)
    if (!item) return
    if (action === 'cancel') item.cancel()
    if (action === 'pause') item.pause()
    if (action === 'resume') item.resume()
  })

  // Berechtigungen
  ipcMain.on('perm:respond', (_e, id, allow, remember) => {
    const p = pendingPermissions.get(id)
    if (!p) return
    pendingPermissions.delete(id)
    p.callback(!!allow)
    if (remember) {
      const perms = { ...store.get('permissions') }
      perms[p.origin] = { ...(perms[p.origin] || {}), [p.permission]: !!allow }
      store.set('permissions', perms)
    }
  })

  // Chromecast
  const result = p => p.then(() => ({ ok: true }), err => ({ ok: false, error: err.message }))
  ipcMain.on('cast:scan', () => cast.scan())
  ipcMain.on('cast:idle', () => cast.idle())
  ipcMain.handle('cast:play', (_e, deviceId, media) => result(cast.play(deviceId, media)))
  ipcMain.on('cast:control', (_e, deviceId, action, value) => cast.control(deviceId, action, value))
  ipcMain.on('cast:stop', (_e, deviceId) => cast.stop(deviceId))
  ipcMain.handle('cast:availability', (_e, appIds) => cast.availability(appIds))
  ipcMain.handle('cast:page-app', (_e, wcId) => cast.pageApp(wcId))
  ipcMain.handle('cast:start-app', (_e, deviceId, wcId) => result((async () => {
    const wc = webContents.fromId(wcId)
    const page = cast.pageApp(wcId)
    if (!wc || !page) throw new Error(t('Die Seite bietet keine Cast-App an.'))
    const conn = await cast.startApp(deviceId, page.appIds, wc, page.origin)
    wc.send('castp:event', { type: 'connectionavailable', ...conn })
  })()))
  // Spiegelung: die Oberfläche nimmt Tab bzw. Bildschirm per getDisplayMedia auf (siehe setupCastCapture)
  ipcMain.handle('cast:mirror-prepare', (_e, kind, wcId, audioOnly) => {
    pendingCapture = { kind, wcId, at: Date.now() }
    return { token: cast.createLive(audioOnly) }
  })
  ipcMain.on('cast:mirror-data', (_e, token, data) => cast.pushLive(token, Buffer.from(data)))
  ipcMain.on('cast:mirror-end', (_e, token) => cast.endLive(token))
  ipcMain.handle('cast:mirror-start', (_e, deviceId, opts) => result(cast.mirror(deviceId, opts)))

  // Cast-Apps von Webseiten (Presentation API, siehe tab-preload.js)
  const originOf = wc => { try { return new URL(wc.getURL()).origin } catch { return '' } }
  ipcMain.handle('castp:start', async (e, urls) => {
    const appIds = CastManager.appIdsFromUrls(urls)
    if (!appIds.length) return { error: 'NotSupportedError', message: t('Nur Cast-Apps werden unterstützt.') }
    let deviceId = null
    try {
      deviceId = await uiRequest('cast:pick', { wcId: e.sender.id, appIds, origin: originOf(e.sender) }, 300000)
    } catch {}
    if (!deviceId) return { error: 'AbortError', message: t('Abgebrochen') }
    try {
      return await cast.startApp(deviceId, appIds, e.sender, originOf(e.sender))
    } catch (err) {
      send('cast:error', err.message)
      return { error: 'OperationError', message: err.message }
    }
  })
  ipcMain.handle('castp:reconnect', (e, urls, id) => cast.reconnectPage(e.sender, urls, id, originOf(e.sender)))
  ipcMain.handle('castp:availability', e => {
    cast.watchAvailability(e.sender)
    return cast.hasDevices()
  })
  ipcMain.on('castp:default', (e, urls) => cast.setPageApp(e.sender, urls, originOf(e.sender)))
  ipcMain.on('castp:send', (_e, connId, data) => cast.pageMessage(connId, data))
  ipcMain.on('castp:close', (_e, connId) => cast.pageClose(connId))
  ipcMain.on('castp:terminate', (_e, connId) => cast.pageTerminate(connId))
  ipcMain.handle('cast:pick-file', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: t('Datei zum Streamen auswählen'),
      properties: ['openFile'],
      filters: [{ name: t('Medien'), extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'jpg', 'jpeg', 'png', 'gif', 'webp'] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // Fokus-Modus
  ipcMain.on('focus:set', (_e, active, domains) => focusGuard.set(active, domains))

  // Browserdaten
  ipcMain.handle('data:clear', async (_e, what) => {
    if (what.includes('cache')) await tabsSession.clearCache()
    if (what.includes('cookies')) await tabsSession.clearStorageData({ storages: ['cookies'] })
    if (what.includes('storage')) {
      await tabsSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache', 'websql'] })
    }
    return true
  })
  ipcMain.on('app:default-browser', () => shell.openExternal('ms-settings:defaultapps?registeredAppUser=Caravel'))
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    downloads: app.getPath('downloads')
  }))

  // Favoriten von der Neuer-Tab-Seite aus ändern – die Oberfläche verwaltet die Liste und speichert sie
  ipcMain.handle('ntp:bookmark', (e, op, data) => {
    if (!e.senderFrame?.url?.startsWith('caravel://newtab')) return false
    if (!['add', 'update', 'remove', 'move'].includes(op)) return false
    send('ntp:bookmark', { op, data })
    return true
  })

  // Neuer-Tab-Seite (nur für caravel://-Seiten)
  ipcMain.handle('ntp:data', e => {
    if (!e.senderFrame?.url?.startsWith('caravel://')) return null
    const history = store.get('history')
    const counts = new Map()
    for (const h of history) {
      try {
        const u = new URL(h.url)
        if (!/^https?:$/.test(u.protocol)) continue
        const entry = counts.get(u.hostname) || { url: u.origin + '/', title: u.hostname.replace(/^www\./, ''), n: 0 }
        entry.n++
        counts.set(u.hostname, entry)
      } catch {}
    }
    const topSites = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8)
    const s = store.get('settings')
    return {
      lang: i18n.lang,
      userName: s.userName,
      searchEngine: s.searchEngine,
      accent: uiAccent,
      theme: s.theme,
      bookmarks: store.get('bookmarks').filter(b => !b.folder).map(({ id, url, title, favicon }) => ({ id, url, title, favicon })),
      topSites,
      stats: { blocked: store.get('stats').blocked + (adblock?.blockedTotal || 0) },
      focusStats: store.get('focusStats'),
      vpn: vpn?.state.status === 'on' ? vpn.state.label : null,
      assistant: s.claudeSidebar ? assistantName(s) : null,
      searchTemplate: searchUrl('%QUERY%')
    }
  })
}

function hasClaudeNativeHost () {
  try {
    const { execFileSync } = require('node:child_process')
    execFileSync('reg', ['query', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.anthropic.claude_code_browser_extension'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch { return false }
}

const ASSISTANT_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT' }
function assistantName (s) { return ASSISTANT_NAMES[s.assistant] || null }

// Codex liest MCP-Server aus ~/.codex/config.toml (HTTP-Server lassen sich nicht per „codex mcp add“ anlegen)
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml')
function codexSection (s) {
  return `[mcp_servers.caravel]\nurl = "http://127.0.0.1:${+s.claudeMcpPort || 47823}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${s.claudeMcpToken}" }\n`
}
function codexStatus (s) {
  let text = ''
  try { text = fs.readFileSync(CODEX_CONFIG, 'utf8') } catch {}
  return { codexConfigured: text.includes(codexSection(s).trim()), codexHasEntry: /^\[mcp_servers\.caravel\]/m.test(text), codexConfigPath: CODEX_CONFIG }
}
function writeCodexConfig (s) {
  let text = ''
  try { text = fs.readFileSync(CODEX_CONFIG, 'utf8') } catch {}
  // vorhandenen Caravel-Abschnitt (bis zum nächsten [Abschnitt]) ersetzen, sonst anhängen
  text = text.replace(/^\[mcp_servers\.caravel\][\s\S]*?(?=^\[|(?![\s\S]))/m, '')
  text = text.replace(/\s*$/, '')
  text = (text ? text + '\n\n' : '') + codexSection(s)
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true })
  fs.writeFileSync(CODEX_CONFIG, text)
}

// Offene Neuer-Tab-Seiten zeigen geänderte Favoriten sofort an
function notifyNewtabPages () {
  for (const wc of webContents.getAllWebContents()) {
    try { if (wc.getURL().startsWith('caravel://newtab')) wc.send('ntp:changed') } catch {}
  }
}

// Chromecast-Spiegelung: getDisplayMedia der Oberfläche liefert den gewählten Tab (Bild und Ton)
// oder den ganzen Bildschirm mit Systemton – ohne Auswahldialog, die Quelle wurde im Cast-Dialog gewählt.
function setupCastCapture () {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const p = pendingCapture
    pendingCapture = null
    const fromUi = request.frame && win && request.frame === win.webContents.mainFrame
    if (!p || !fromUi || Date.now() - p.at > 15000) return callback({})
    try {
      if (p.kind === 'tab') {
        const wc = webContents.fromId(p.wcId)
        if (!wc || wc.isDestroyed()) return callback({})
        return callback({ video: wc.mainFrame, audio: wc.mainFrame })
      }
      const [screen] = await desktopCapturer.getSources({ types: ['screen'] })
      callback(screen ? { video: screen, audio: 'loopback' } : {})
    } catch (err) {
      console.warn('[cast] Aufnahme', err)
      callback({})
    }
  })
}

// Claude Code / Codex: eingebauter MCP-Server
const agentTimers = new Map()
function markAgent (wcId) {
  send('crx:debugger', { tabId: wcId, attached: true })
  clearTimeout(agentTimers.get(wcId))
  agentTimers.set(wcId, setTimeout(() => { agentTimers.delete(wcId); send('crx:debugger', { tabId: wcId, attached: false }) }, 20000))
}

function setupMcp () {
  const ask = payload => uiRequest('mcp:ui', payload, 30000)
  mcp = new McpServer({
    ui: {
      tabs: () => ask({ op: 'tabs' }),
      resolve: id => ask({ op: 'resolve', id }),
      open: (url, background) => ask({ op: 'open', url, background }),
      select: id => ask({ op: 'select', id }),
      close: id => ask({ op: 'close', id })
    },
    markAgent,
    readabilitySource: () => fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8'),
    turndownSource: () => fs.readFileSync(require.resolve('turndown/dist/turndown.js'), 'utf8')
  })
}

function syncMcp (s) {
  if (!mcp) return
  if (!s.claudeMcp || !assistantName(s)) { mcp.stop(); mcpError = null; return }
  let token = s.claudeMcpToken
  if (!token) {
    token = require('node:crypto').randomBytes(24).toString('base64url')
    store.set('settings', { ...s, claudeMcpToken: token })
  }
  mcp.start(+s.claudeMcpPort || 47823, token)
    .then(() => { mcpError = null })
    .catch(err => {
      mcpError = err.code === 'EADDRINUSE' ? t('Port {port} ist bereits belegt.', { port: s.claudeMcpPort }) : err.message
      mcp.stop()
    })
}

// Websites abdunkeln, solange Caravel dunkel ist (Einstellung „Websites abdunkeln“)
function syncAutoDark () {
  const s = store.get('settings')
  autodark.setEnabled(s.autoDarkPages !== false && nativeTheme.shouldUseDarkColors)
}

function applySettings () {
  const s = store.get('settings')
  syncMcp(s)
  nativeTheme.themeSource = s.theme === 'system' ? 'system' : s.theme
  syncAutoDark()
  adblock?.setAllowlist(s.adblockAllowlist || [])
  adblock?.setEnabled(s.adblock !== false, !!s.adblockCookies)
    .then(() => send('adblock:status', { enabled: adblock.enabled, status: adblock.status }))
    .catch(err => {
      console.warn('[adblock]', err.message)
      send('adblock:status', { enabled: false, status: 'error', error: err.message })
    })
}

// ---------------------------------------------------------------------------
// Start

app.on('second-instance', (_e, argv) => {
  const url = urlFromArgv(argv)
  if (url) openUrlInUi(url)
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})

// Anmeldedaten für HTTP(S)-Proxys eigener VPN-Server
app.on('login', (event, _wc, _details, authInfo, callback) => {
  if (!authInfo.isProxy) return
  const server = store.get('settings').vpnServers.find(s => s.host === authInfo.host && s.user)
  if (!server) return
  event.preventDefault()
  callback(server.user, server.pass)
})

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'))
  i18n.setLang(i18n.resolve(store.get('settings').language, app.getPreferredSystemLanguages()[0] || app.getLocale()))
  // Neue Installation: Namen der Standard-Spaces in der Sprache der Oberfläche
  if (store.fresh) store.set('spaces', store.get('spaces').map(sp => ({ ...sp, name: t(sp.name) })))
  tabsSession = session.fromPartition(PARTITION)

  const ua = cleanUserAgent(tabsSession.getUserAgent())
  // Bevorzugte Sprachen für Websites (Accept-Language) passend zur Oberfläche
  tabsSession.setUserAgent(ua, i18n.lang === 'en' ? 'en-US,en;q=0.9' : 'de-DE,de;q=0.9,en;q=0.8')
  app.userAgentFallback = ua

  try {
    const langs = tabsSession.availableSpellCheckerLanguages
    const prefer = i18n.lang === 'en' ? ['en-US', 'de-DE', 'de'] : ['de-DE', 'de', 'en-US']
    tabsSession.setSpellCheckerLanguages(prefer.filter(l => langs.includes(l)).slice(0, 2))
  } catch {}

  registerOdeProtocol(tabsSession)
  registerOdeProtocol(session.defaultSession)

  focusGuard = new FocusGuard(url => `caravel://blocked/?url=${encodeURIComponent(url)}`)
  cast = new CastManager(send)
  cast.discovery.start() // wie Chrome: Geräte im Hintergrund suchen, damit Cast-Knöpfe sofort erscheinen
  setupCastCapture()
  vpn = new VpnManager({ session: tabsSession, dataDir: app.getPath('userData'), vendorDir: VENDOR_DIR })
  vpn.on('state', state => send('vpn:state', state))
  adblock = new AdBlock(path.join(app.getPath('userData'), 'AdBlock'), tabsSession)
  adblock.onBlocked = (wcId, count, total) => send('adblock:blocked', { wcId, count, total })
  if (process.env.CARAVEL_DEBUG) globalThis.__debug = { adblock, vpn, cast, get crx () { return crx }, get extensions () { return extensions } }

  // Seitenwechsel setzt den Zähler blockierter Anfragen zurück
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) {
        cast.setPageApp(wc, null)
        adblock.resetTab(wc.id)
        send('adblock:blocked', { wcId: wc.id, count: 0, total: adblock.blockedTotal })
      }
    })
  })

  setupMcp()
  registerIpc()
  applySettings()
  nativeTheme.on('updated', syncAutoDark) // Design „System“: Windows wechselt Hell/Dunkel
  setupDownloads()
  setupPermissions()
  await setupExtensions()

  Menu.setApplicationMenu(null)
  createWindow()

  const initial = urlFromArgv(process.argv)
  if (initial) pendingUrls.push(initial)

  if (store.get('settings').vpnAutoConnect) vpn.connect(vpnConfigFromSettings())

  if (process.env.CARAVEL_DEBUG_SHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.CARAVEL_DEBUG_SHOT, img.toPNG())
    }, +(process.env.CARAVEL_DEBUG_DELAY || 7000))
  }
})

app.on('before-quit', () => {
  if (adblock) {
    const stats = store.get('stats')
    store.set('stats', { ...stats, blocked: (stats.blocked || 0) + adblock.blockedTotal })
    adblock.blockedTotal = 0
  }
  store?.flush()
  cast?.dispose()
  vpn?.dispose()
  mcp?.stop()
})

app.on('window-all-closed', () => app.quit())
