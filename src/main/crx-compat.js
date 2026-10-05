// Kompatibilitätsschicht für Chrome-Erweiterungs-APIs, die weder Electron noch
// electron-chrome-extensions anbieten. Wird vor allem für „Claude in Chrome“ benötigt:
//   tabGroups, tabs.group/ungroup, sidePanel, debugger, offscreen, identity,
//   declarativeNetRequest (Header-Regeln), runtime.getContexts, downloads.download
//
// Die Renderer-Seite liegt in src/preload/crx-early.js und crx-late.js.
const fs = require('node:fs')
const path = require('node:path')
const { BrowserWindow, webContents, ipcMain } = require('electron')

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
const RESOURCE_TYPES = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image',
  font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media',
  webSocket: 'websocket', other: 'other'
}

// Nötige Manifest-Berechtigung je Namensraum (dieselben, unter denen crx-early.js die APIs anbietet)
const PERMISSION_FOR = {
  tabGroups: 'tabGroups',
  sidePanel: 'sidePanel',
  debugger: 'debugger',
  offscreen: 'offscreen',
  identity: 'identity',
  declarativeNetRequest: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'],
  downloads: 'downloads',
  runtime: null
}

// DNR-Regel mit vorbereitetem Suchmuster (_regex) bzw. ohne für die Rückgabe an die Erweiterung
function compileRule (rule) {
  const c = rule.condition || {}
  return { ...rule, _regex: c.regexFilter ? new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i') : urlFilterToRegex(c.urlFilter) }
}
function publicRule ({ _regex, ...rule }) { return rule }

// Erweiterungs-ID des tatsächlichen Absenders einer IPC-Nachricht
function senderExtId (event) {
  const url = event?.type === 'service-worker' ? event.serviceWorker?.scope : (event?.senderFrame?.url || '')
  return /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '')?.[1] || null
}

// DNR-urlFilter (||, |, *, ^) in einen regulären Ausdruck übersetzen
function urlFilterToRegex (filter) {
  if (!filter) return /.*/
  let src = ''
  let f = filter
  let anchoredStart = false; let anchoredEnd = false; let domainAnchor = false
  if (f.startsWith('||')) { domainAnchor = true; f = f.slice(2) } else if (f.startsWith('|')) { anchoredStart = true; f = f.slice(1) }
  if (f.endsWith('|')) { anchoredEnd = true; f = f.slice(0, -1) }
  for (const ch of f) {
    if (ch === '*') src += '.*'
    else if (ch === '^') src += '(?:[^\\w.%-]|$)'
    else src += ch.replace(/[.+?${}()|[\]\\/]/g, '\\$&')
  }
  if (domainAnchor) src = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?' + src
  else if (anchoredStart) src = '^' + src
  if (anchoredEnd) src += '$'
  return new RegExp(src, 'i')
}

class CrxCompat {
  constructor ({ session, getWindow, sendUi, dataDir = null }) {
    this.dataDir = dataDir
    this.session = session
    this.getWindow = getWindow
    this.sendUi = sendUi
    this.pageSubscribers = new Map() // extId -> Set<WebContents>
    this.workerSubscribers = new Set() // extIds mit Listener im Service Worker
    this.groups = new Map() // groupId -> group
    this.tabGroup = new Map() // tabId -> groupId
    this.nextGroupId = 1000
    this.sidePanel = new Map() // extId -> { global: {path, enabled}, tabs: Map<tabId, opts>, behavior }
    this.openPanels = new Map() // `${extId}:${tabId}` -> { extId, tabId, url }
    this.debuggees = new Map() // `${extId}:${tabId}` -> { wc, onMessage, onDetach }
    this.offscreen = new Map() // extId -> BrowserWindow
    this.dnrRules = new Map() // extId -> { session: [], dynamic: [] }
    this.loadDynamicRules()
    this.dnrInstalled = false
    this.nextDownloadId = 1
  }

  // --- Verdrahtung ----------------------------------------------------------

  install () {
    const handler = (event, extId, fn, args) => this.call(event, extId, fn, args || [])
      .then(value => ({ value }))
      .catch(err => ({ error: err?.message || String(err) }))
    ipcMain.handle('caravel-crx', handler)
    ipcMain.on('caravel-crx-subscribe', (event, extId) => {
      if (event.type === 'service-worker' || !event.sender) this.workerSubscribers.add(extId)
      else this.subscribePage(event.sender, extId)
    })
    const watchWorker = ({ runningStatus, versionId }) => {
      if (runningStatus !== 'starting') return
      const sw = this.session.serviceWorkers.getWorkerFromVersionID(versionId)
      if (!sw?.scope?.startsWith('chrome-extension://') || sw.__caravelCompat) return
      sw.__caravelCompat = true
      sw.ipc.handle('caravel-crx', handler)
      sw.ipc.on('caravel-crx-subscribe', (_e, extId) => this.workerSubscribers.add(extId))
    }
    this.session.serviceWorkers.on('running-status-changed', watchWorker)
  }

  subscribePage (wc, extId) {
    if (!this.pageSubscribers.has(extId)) this.pageSubscribers.set(extId, new Set())
    const set = this.pageSubscribers.get(extId)
    if (set.has(wc)) return
    set.add(wc)
    wc.once('destroyed', () => set.delete(wc))
  }

  emit (extId, name, ...args) {
    for (const wc of this.pageSubscribers.get(extId) || []) {
      if (!wc.isDestroyed()) wc.send('caravel-crx-event', name, ...args)
    }
    if (this.workerSubscribers.has(extId)) {
      this.session.serviceWorkers.startWorkerForScope(`chrome-extension://${extId}/`)
        .then(sw => sw.send('caravel-crx-event', name, ...args))
        .catch(() => {})
    }
  }

  emitAll (name, ...args) {
    const ids = new Set([...this.pageSubscribers.keys(), ...this.workerSubscribers])
    for (const id of ids) this.emit(id, name, ...args)
  }

  // Wird von electron-chrome-extensions für jedes Tab-Objekt aufgerufen
  assignTabDetails (details, wc) {
    details.groupId = this.tabGroup.get(wc.id) ?? -1
  }

  tabRemoved (tabId) {
    const gid = this.tabGroup.get(tabId)
    if (gid !== undefined) this.ungroup([tabId])
    for (const [key, panel] of this.openPanels) if (panel.tabId === tabId) this.openPanels.delete(key)
  }

  async call (event, extId, fn, args) {
    const impl = this.api[fn]
    if (!impl) throw new Error(`${fn} wird von Caravel nicht unterstützt`)
    // Die ID kommt vom Aufrufer – sie muss zum tatsächlichen Absender passen (Frame bzw. Service Worker),
    // sonst könnte eine Erweiterung im Namen einer anderen handeln. event = null: Aufruf aus dem Hauptprozess.
    if (event && senderExtId(event) !== extId) throw new Error('Zugriff verweigert')
    const ext = this.session.extensions.getExtension(extId)
    if (!ext) throw new Error('Unbekannte Erweiterung')
    const need = PERMISSION_FOR[fn.split('.')[0]] ?? (fn.startsWith('tabs.') ? 'tabGroups' : null)
    const perms = ext.manifest?.permissions || []
    if (need && ![].concat(need).some(p => perms.includes(p))) throw new Error(`Berechtigung „${[].concat(need)[0]}“ fehlt im Manifest`)
    return impl.call(this, { event, extId, ext }, ...args)
  }

  // --- Tab-Gruppen ----------------------------------------------------------

  notifyGroups () {
    const tabs = {}
    for (const [tabId, gid] of this.tabGroup) {
      const g = this.groups.get(gid)
      if (g) tabs[tabId] = { id: g.id, title: g.title, color: g.color }
    }
    this.sendUi('crx:tabgroups', tabs)
  }

  touchTab (tabId) {
    const wc = webContents.fromId(tabId)
    if (wc && !wc.isDestroyed()) wc.emit('tab-updated')
  }

  ungroup (tabIds) {
    for (const id of [].concat(tabIds)) {
      const gid = this.tabGroup.get(id)
      if (gid === undefined) continue
      this.tabGroup.delete(id)
      this.touchTab(id)
      if (![...this.tabGroup.values()].includes(gid)) {
        const g = this.groups.get(gid)
        this.groups.delete(gid)
        if (g) this.emitAll('tabGroups.onRemoved', g)
      }
    }
    this.notifyGroups()
  }

  groupInfo (g) { return { ...g } }

  // --- Implementierungen ----------------------------------------------------

  get api () {
    return {
      // tabs.group / ungroup
      'tabs.group' ({ ext }, options = {}) {
        const tabIds = [].concat(options.tabIds || [])
        if (!tabIds.length) throw new Error('Keine Tabs angegeben')
        let gid = options.groupId
        if (gid === undefined || !this.groups.has(gid)) {
          gid = this.nextGroupId++
          const win = this.getWindow()
          const g = { id: gid, title: '', color: GROUP_COLORS[this.groups.size % GROUP_COLORS.length], collapsed: false, windowId: win?.id ?? -1, shared: false }
          this.groups.set(gid, g)
          this.emitAll('tabGroups.onCreated', this.groupInfo(g))
        }
        for (const id of tabIds) { this.tabGroup.set(id, gid); this.touchTab(id) }
        this.notifyGroups()
        return gid
      },
      'tabs.ungroup' (_c, tabIds) { this.ungroup(tabIds) },
      'tabGroups.get' (_c, groupId) {
        const g = this.groups.get(groupId)
        if (!g) throw new Error(`No group with id: ${groupId}.`)
        return this.groupInfo(g)
      },
      'tabGroups.query' (_c, query = {}) {
        return [...this.groups.values()].filter(g =>
          (query.title === undefined || g.title === query.title) &&
          (query.color === undefined || g.color === query.color) &&
          (query.collapsed === undefined || g.collapsed === query.collapsed)
        ).map(g => this.groupInfo(g))
      },
      'tabGroups.update' (_c, groupId, props = {}) {
        const g = this.groups.get(groupId)
        if (!g) throw new Error(`No group with id: ${groupId}.`)
        for (const k of ['title', 'color', 'collapsed']) if (props[k] !== undefined) g[k] = props[k]
        this.emitAll('tabGroups.onUpdated', this.groupInfo(g))
        this.notifyGroups()
        return this.groupInfo(g)
      },
      'tabGroups.move' (_c, groupId) {
        const g = this.groups.get(groupId)
        if (!g) throw new Error(`No group with id: ${groupId}.`)
        return this.groupInfo(g)
      },

      // sidePanel
      'sidePanel.setOptions' ({ extId }, opts = {}) {
        const sp = this.panelState(extId)
        const target = opts.tabId !== undefined ? (sp.tabs.get(opts.tabId) || {}) : sp.global
        if (opts.path !== undefined) target.path = opts.path
        if (opts.enabled !== undefined) target.enabled = opts.enabled
        if (opts.tabId !== undefined) sp.tabs.set(opts.tabId, target)
        if (target.enabled === false) {
          for (const [key, p] of this.openPanels) {
            if (p.extId === extId && (opts.tabId === undefined || p.tabId === opts.tabId)) {
              this.openPanels.delete(key)
              this.sendUi('crx:sidepanel-close', { extId, tabId: p.tabId })
            }
          }
        }
      },
      'sidePanel.getOptions' ({ extId, ext }, opts = {}) {
        const sp = this.panelState(extId)
        const t = opts.tabId !== undefined ? sp.tabs.get(opts.tabId) : null
        return { path: t?.path ?? sp.global.path ?? ext.manifest.side_panel?.default_path, enabled: t?.enabled ?? sp.global.enabled ?? true }
      },
      'sidePanel.setPanelBehavior' ({ extId }, behavior = {}) { this.panelState(extId).behavior = { ...behavior } },
      'sidePanel.getPanelBehavior' ({ extId }) { return this.panelState(extId).behavior || { openPanelOnActionClick: false } },
      'sidePanel.open' ({ extId, ext }, opts = {}) {
        const sp = this.panelState(extId)
        const tabId = opts.tabId ?? this.activeTabId?.() ?? -1
        const t = sp.tabs.get(tabId)
        const pathName = t?.path ?? sp.global.path ?? ext.manifest.side_panel?.default_path
        if (!pathName) throw new Error('No active side panel for tabId: ' + tabId)
        const url = `chrome-extension://${extId}/${pathName.replace(/^\//, '')}`
        this.openPanels.set(`${extId}:${tabId}`, { extId, tabId, url })
        this.sendUi('crx:sidepanel-open', { extId, tabId, url, name: ext.name })
      },
      'sidePanel.close' ({ extId }, opts = {}) {
        for (const [key, p] of this.openPanels) {
          if (p.extId === extId && (opts.tabId === undefined || p.tabId === opts.tabId)) {
            this.openPanels.delete(key)
            this.sendUi('crx:sidepanel-close', { extId, tabId: p.tabId })
          }
        }
      },

      // runtime.getContexts (nur die Kontexte, die Caravel selbst verwaltet)
      'runtime.getContexts' ({ extId }, filter = {}) {
        const win = this.getWindow()
        const out = []
        for (const p of this.openPanels.values()) {
          if (p.extId !== extId) continue
          out.push({ contextType: 'SIDE_PANEL', contextId: `sp-${p.tabId}`, documentUrl: p.url, documentOrigin: `chrome-extension://${extId}`, tabId: p.tabId, windowId: win?.id ?? -1, frameId: 0, incognito: false })
        }
        const off = this.offscreen.get(extId)
        if (off && !off.isDestroyed()) {
          out.push({ contextType: 'OFFSCREEN_DOCUMENT', contextId: 'offscreen', documentUrl: off.webContents.getURL(), documentOrigin: `chrome-extension://${extId}`, tabId: -1, windowId: -1, frameId: 0, incognito: false })
        }
        return out.filter(c =>
          (!filter.contextTypes || filter.contextTypes.includes(c.contextType)) &&
          (!filter.tabIds || filter.tabIds.includes(c.tabId)) &&
          (!filter.documentUrls || filter.documentUrls.includes(c.documentUrl))
        )
      },

      // debugger → webContents.debugger (Chrome DevTools Protocol)
      'debugger.attach' ({ extId }, target = {}, version = '1.3') {
        const tabId = target.tabId
        const wc = tabId !== undefined && webContents.fromId(tabId)
        if (!wc || wc.isDestroyed()) throw new Error(`No tab with given id ${tabId}.`)
        const key = `${extId}:${tabId}`
        if (this.debuggees.has(key)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`)
        if (!wc.debugger.isAttached()) wc.debugger.attach(version)
        const onMessage = (_e, method, params, sessionId) => this.emit(extId, 'debugger.onEvent', sessionId ? { tabId, sessionId } : { tabId }, method, params)
        const onDetach = (_e, reason) => {
          // Electron trennt den Debugger z. B. bei einem Reload mit Prozesswechsel, Chrome nicht.
          // Solange der Tab existiert: still neu verbinden und aktivierte Domains wiederherstellen.
          const d = this.debuggees.get(key)
          if (d && !wc.isDestroyed() && !d.detaching) {
            setTimeout(async () => {
              try {
                if (!wc.debugger.isAttached()) wc.debugger.attach(version)
                for (const [method, params] of d.enabled) await wc.debugger.sendCommand(method, params).catch(() => {})
              } catch {
                this.cleanupDebuggee(key)
                this.emit(extId, 'debugger.onDetach', { tabId }, 'target_closed')
              }
            }, 30)
            return
          }
          this.cleanupDebuggee(key)
          this.emit(extId, 'debugger.onDetach', { tabId }, reason === 'target closed' ? 'target_closed' : 'canceled_by_user')
        }
        wc.debugger.on('message', onMessage)
        wc.debugger.on('detach', onDetach)
        wc.once('destroyed', () => {
          if (!this.debuggees.has(key)) return
          this.cleanupDebuggee(key)
          this.emit(extId, 'debugger.onDetach', { tabId }, 'target_closed')
        })
        this.debuggees.set(key, { wc, onMessage, onDetach, tabId, enabled: new Map() })
        this.sendUi('crx:debugger', { tabId, attached: true })
      },
      async 'debugger.sendCommand' ({ extId }, target = {}, method, params) {
        const d = this.debuggees.get(`${extId}:${target.tabId}`)
        if (!d) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`)
        // Eingaben über CDP (z. B. Claude in Chrome klickt) zählen für den Popup-Blocker als Nutzereingabe
        if (/^Input\./.test(method)) this.onAgentInput?.(target.tabId)
        if (!target.sessionId) {
          if (/\.enable$/.test(method)) d.enabled.set(method, params || {})
          if (/\.disable$/.test(method)) d.enabled.delete(method.replace(/disable$/, 'enable'))
        }
        // Page.reload über CDP ersetzt in Electron die komplette Webview-Instanz (neue Tab-ID).
        // Der normale Reload verhält sich dagegen wie in Chrome.
        if (method === 'Page.reload' && !target.sessionId) {
          params?.ignoreCache ? d.wc.reloadIgnoringCache() : d.wc.reload()
          return {}
        }
        try {
          if (!d.wc.debugger.isAttached()) {
            d.wc.debugger.attach('1.3')
            for (const [m, p] of d.enabled) await d.wc.debugger.sendCommand(m, p).catch(() => {})
          }
          return await d.wc.debugger.sendCommand(method, params || {}, target.sessionId)
        } catch (err) {
          // Navigationen, die den Renderer wechseln, beenden laufende Befehle – die Navigation selbst klappt
          if (/target closed/i.test(err.message) && /^Page\.(reload|navigate)$/.test(method)) return {}
          throw err
        }
      },
      'debugger.detach' ({ extId }, target = {}) {
        const key = `${extId}:${target.tabId}`
        const d = this.debuggees.get(key)
        if (!d) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`)
        d.detaching = true
        this.cleanupDebuggee(key)
        try { d.wc.debugger.detach() } catch {}
      },
      'debugger.getTargets' ({ extId }) {
        return webContents.getAllWebContents()
          .filter(wc => wc.session === this.session && ['webview', 'window'].includes(wc.getType()) && /^https?:/.test(wc.getURL()))
          .map(wc => ({ id: String(wc.id), tabId: wc.id, type: 'page', url: wc.getURL(), title: wc.getTitle(), attached: this.debuggees.has(`${extId}:${wc.id}`), extensionId: undefined, faviconUrl: undefined }))
      },

      // offscreen → verstecktes Fenster
      'offscreen.createDocument' ({ extId }, params = {}) {
        const existing = this.offscreen.get(extId)
        if (existing && !existing.isDestroyed()) throw new Error('Only a single offscreen document may be created.')
        const win = new BrowserWindow({ show: false, webPreferences: { session: this.session, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
        win.webContents.setAudioMuted(false)
        this.offscreen.set(extId, win)
        win.on('closed', () => this.offscreen.delete(extId))
        return win.loadURL(`chrome-extension://${extId}/${String(params.url || '').replace(/^\//, '')}`).then(() => undefined)
      },
      'offscreen.hasDocument' ({ extId }) {
        const w = this.offscreen.get(extId)
        return !!w && !w.isDestroyed()
      },
      'offscreen.closeDocument' ({ extId }) {
        const w = this.offscreen.get(extId)
        if (w && !w.isDestroyed()) w.destroy()
      },

      // identity.launchWebAuthFlow → Anmeldefenster, das die Weiterleitung abfängt
      'identity.launchWebAuthFlow' ({ extId }, details = {}) {
        return this.webAuthFlow(extId, details)
      },

      // declarativeNetRequest: Header-Regeln für Anfragen
      'declarativeNetRequest.updateSessionRules' ({ extId }, opts = {}) { this.updateRules(extId, 'session', opts) },
      'declarativeNetRequest.getSessionRules' ({ extId }) { return this.rules(extId).session.map(publicRule) },
      'declarativeNetRequest.updateDynamicRules' ({ extId }, opts = {}) { this.updateRules(extId, 'dynamic', opts) },
      'declarativeNetRequest.getDynamicRules' ({ extId }) { return this.rules(extId).dynamic.map(publicRule) },

      // downloads.download → Caravel-Downloadverwaltung
      'downloads.download' (_c, options = {}) {
        if (!options.url) throw new Error('Keine URL angegeben')
        this.session.downloadURL(options.url)
        return this.nextDownloadId++
      },
      'downloads.search' () { return [] }
    }
  }

  panelState (extId) {
    if (!this.sidePanel.has(extId)) this.sidePanel.set(extId, { global: {}, tabs: new Map(), behavior: null })
    return this.sidePanel.get(extId)
  }

  panelClosed (extId, tabId) {
    this.openPanels.delete(`${extId}:${tabId}`)
  }

  cleanupDebuggee (key) {
    const d = this.debuggees.get(key)
    if (!d) return
    this.debuggees.delete(key)
    if (!d.wc.isDestroyed()) {
      d.wc.debugger.removeListener('message', d.onMessage)
      d.wc.debugger.removeListener('detach', d.onDetach)
    }
    this.sendUi('crx:debugger', { tabId: d.tabId, attached: [...this.debuggees.values()].some(x => x.tabId === d.tabId) })
  }

  webAuthFlow (extId, details) {
    const redirectBase = `https://${extId}.chromiumapp.org/`
    const interactive = !!details.interactive
    return new Promise((resolve, reject) => {
      const parent = this.getWindow()
      const win = new BrowserWindow({
        width: 520,
        height: 720,
        show: false,
        parent: parent || undefined,
        autoHideMenuBar: true,
        title: 'Anmeldung',
        webPreferences: { session: this.session, sandbox: true, contextIsolation: true }
      })
      let done = false
      const finish = (err, url) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (!win.isDestroyed()) win.destroy()
        err ? reject(err) : resolve(url)
      }
      const check = (e, url) => {
        if (typeof url === 'string' && url.startsWith(redirectBase)) {
          e?.preventDefault?.()
          finish(null, url)
        }
      }
      win.webContents.on('will-redirect', (e) => check(e, e.url))
      win.webContents.on('will-navigate', (e) => check(e, e.url))
      win.webContents.on('did-start-navigation', (e) => check(null, e.url))
      win.webContents.on('did-finish-load', () => {
        if (done) return
        if (interactive) win.show()
        else if (details.abortOnLoadForNonInteractive !== false) finish(new Error('User interaction required.'))
      })
      win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
        if (isMain && !String(url).startsWith(redirectBase) && code !== -3) finish(new Error(`Authorization page could not be loaded. (${desc})`))
      })
      win.on('closed', () => finish(new Error('The user did not approve access.')))
      const timeout = interactive ? 10 * 60 * 1000 : (details.timeoutMsForNonInteractive || 10000)
      const timer = setTimeout(() => finish(new Error(interactive ? 'Timed out.' : 'User interaction required.')), timeout)
      win.loadURL(details.url).catch(() => {})
    })
  }

  rules (extId) {
    if (!this.dnrRules.has(extId)) this.dnrRules.set(extId, { session: [], dynamic: [] })
    return this.dnrRules.get(extId)
  }

  updateRules (extId, kind, { removeRuleIds = [], addRules = [] }) {
    const r = this.rules(extId)
    r[kind] = r[kind].filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules.map(compileRule))
    this.installHeaderRules()
    if (kind === 'dynamic') this.saveDynamicRules()
  }

  // Dynamische Regeln bleiben wie in Chrome über Neustarts erhalten (Sitzungsregeln nicht)
  get rulesFile () { return this.dataDir ? path.join(this.dataDir, 'caravel-dnr.json') : null }

  loadDynamicRules () {
    if (!this.rulesFile) return
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.rulesFile, 'utf8')) } catch { return }
    for (const [extId, list] of Object.entries(saved)) {
      try { this.rules(extId).dynamic = (list || []).map(compileRule) } catch (err) { console.warn('[dnr]', extId, err.message) }
    }
  }

  saveDynamicRules () {
    if (!this.rulesFile) return
    const out = {}
    for (const [extId, r] of this.dnrRules) {
      // Regeln entfernter Erweiterungen nicht weiter mitschleppen
      if (r.dynamic.length && this.session.extensions.getExtension(extId)) out[extId] = r.dynamic.map(publicRule)
    }
    try { fs.writeFileSync(this.rulesFile, JSON.stringify(out)) } catch (err) { console.warn('[dnr] Speichern', err.message) }
  }

  // Nur onBeforeSendHeaders – onBeforeRequest/onHeadersReceived gehören dem Werbeblocker
  installHeaderRules () {
    if (this.dnrInstalled) return
    this.dnrInstalled = true
    this.session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
      const headers = { ...details.requestHeaders }
      // Electron erlaubt nur einen Listener je Sitzung: Caravel-eigene Header (z. B. Farbschema) hier mit anwenden
      const changed = this.extraHeaders ? this.extraHeaders(details, headers) : false
      const active = []
      for (const r of this.dnrRules.values()) active.push(...r.session, ...r.dynamic)
      const mods = active.filter(rule => rule.action?.type === 'modifyHeaders' && rule.action.requestHeaders && this.matches(rule, details))
      if (!mods.length) return cb(changed ? { requestHeaders: headers } : {})
      const find = name => Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
      for (const rule of mods.sort((a, b) => (b.priority || 1) - (a.priority || 1))) {
        for (const h of rule.action.requestHeaders) {
          const key = find(h.header)
          if (h.operation === 'remove') { if (key) delete headers[key] } else if (h.operation === 'set') { if (key) delete headers[key]; headers[h.header] = h.value } else if (h.operation === 'append') { headers[key || h.header] = key ? `${headers[key]}, ${h.value}` : h.value }
        }
      }
      cb({ requestHeaders: headers })
    })
  }

  matches (rule, details) {
    const c = rule.condition || {}
    if (!rule._regex.test(details.url)) return false
    const type = RESOURCE_TYPES[details.resourceType] || 'other'
    if (c.resourceTypes && !c.resourceTypes.includes(type)) return false
    if (c.excludedResourceTypes && c.excludedResourceTypes.includes(type)) return false
    if (c.requestMethods && !c.requestMethods.includes(String(details.method).toLowerCase())) return false
    if (c.tabIds && !c.tabIds.includes(details.webContentsId)) return false
    let host = ''
    try { host = new URL(details.url).hostname } catch {}
    const inDomains = (list) => list.some(d => host === d || host.endsWith('.' + d))
    if (c.requestDomains && !inDomains(c.requestDomains)) return false
    if (c.excludedRequestDomains && inDomains(c.excludedRequestDomains)) return false
    return true
  }
}

module.exports = { CrxCompat }
