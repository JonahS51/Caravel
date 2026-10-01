// Kompatibilitätsschicht, Teil 1 – läuft VOR dem Preload von electron-chrome-extensions
// (das chrome.* anschließend einfriert). Ergänzt Namensräume, die Electron fehlen.
// Gegenstück im Hauptprozess: src/main/crx-compat.js
const { contextBridge, ipcRenderer } = require('electron')

const isWorker = process.type === 'service-worker'
const isExtensionPage = !isWorker && typeof location !== 'undefined' && location.href.startsWith('chrome-extension://')

if (isWorker || isExtensionPage) {
  const listeners = new Map() // Eventname -> Set<callback>
  let subscribed = false
  ipcRenderer.on('caravel-crx-event', (_e, name, ...args) => {
    for (const cb of listeners.get(name) || []) {
      try { cb(...args) } catch (err) { console.error(err) }
    }
  })

  const bridge = {
    invoke: (extId, fn, args) => ipcRenderer.invoke('caravel-crx', extId, fn, args),
    subscribe (extId, name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(cb)
      if (!subscribed) { subscribed = true; ipcRenderer.send('caravel-crx-subscribe', extId) }
    }
  }

  try {
    contextBridge.exposeInMainWorld('__caravelCrx', bridge)
    contextBridge.executeInMainWorld({
      func: function installOdeCompat () {
        const chrome = globalThis.chrome
        const bridge = globalThis.__caravelCrx
        if (!chrome || !chrome.runtime || !chrome.runtime.id || !bridge) return
        const extId = chrome.runtime.id
        const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {}
        const perms = new Set(manifest.permissions || [])

        const call = fn => (...args) => {
          const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
          const p = bridge.invoke(extId, fn, args).then(res => {
            if (res && res.error) throw new Error(res.error)
            return res ? res.value : undefined
          })
          if (cb) { p.then(v => cb(v), err => { console.warn(`[Caravel] ${fn}:`, err.message); cb(undefined) }); return undefined }
          return p
        }
        class CaravelEvent {
          constructor (name) { this.name = name; this.fns = new Set() }
          addListener (fn) {
            if (!this.fns.size) bridge.subscribe(extId, this.name, (...a) => this.fns.forEach(f => { try { f(...a) } catch (e) { console.error(e) } }))
            this.fns.add(fn)
          }
          removeListener (fn) { this.fns.delete(fn) }
          hasListener (fn) { return this.fns.has(fn) }
          hasListeners () { return this.fns.size > 0 }
        }
        const define = (name, value) => {
          if (chrome[name]) return
          Object.defineProperty(chrome, name, { value, enumerable: true, configurable: true, writable: true })
        }

        if (perms.has('tabGroups')) {
          define('tabGroups', {
            TAB_GROUP_ID_NONE: -1,
            Color: { GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow', GREEN: 'green', PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange' },
            get: call('tabGroups.get'),
            query: call('tabGroups.query'),
            update: call('tabGroups.update'),
            move: call('tabGroups.move'),
            onCreated: new CaravelEvent('tabGroups.onCreated'),
            onUpdated: new CaravelEvent('tabGroups.onUpdated'),
            onRemoved: new CaravelEvent('tabGroups.onRemoved'),
            onMoved: new CaravelEvent('tabGroups.onMoved')
          })
        }
        if (perms.has('sidePanel')) {
          define('sidePanel', {
            setOptions: call('sidePanel.setOptions'),
            getOptions: call('sidePanel.getOptions'),
            setPanelBehavior: call('sidePanel.setPanelBehavior'),
            getPanelBehavior: call('sidePanel.getPanelBehavior'),
            open: call('sidePanel.open'),
            close: call('sidePanel.close')
          })
        }
        if (perms.has('debugger')) {
          define('debugger', {
            attach: call('debugger.attach'),
            detach: call('debugger.detach'),
            sendCommand: call('debugger.sendCommand'),
            getTargets: call('debugger.getTargets'),
            onEvent: new CaravelEvent('debugger.onEvent'),
            onDetach: new CaravelEvent('debugger.onDetach')
          })
        }
        if (perms.has('offscreen')) {
          define('offscreen', {
            Reason: {
              TESTING: 'TESTING', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', IFRAME_SCRIPTING: 'IFRAME_SCRIPTING', DOM_SCRAPING: 'DOM_SCRAPING',
              BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER', USER_MEDIA: 'USER_MEDIA', DISPLAY_MEDIA: 'DISPLAY_MEDIA', WEB_RTC: 'WEB_RTC',
              CLIPBOARD: 'CLIPBOARD', LOCAL_STORAGE: 'LOCAL_STORAGE', WORKERS: 'WORKERS', BATTERY_STATUS: 'BATTERY_STATUS',
              MATCH_MEDIA: 'MATCH_MEDIA', GEOLOCATION: 'GEOLOCATION'
            },
            createDocument: call('offscreen.createDocument'),
            hasDocument: call('offscreen.hasDocument'),
            closeDocument: call('offscreen.closeDocument')
          })
        }
        if (perms.has('identity')) {
          define('identity', {
            getRedirectURL: path => `https://${extId}.chromiumapp.org/${(path || '').replace(/^\//, '')}`,
            launchWebAuthFlow: call('identity.launchWebAuthFlow'),
            onSignInChanged: new CaravelEvent('identity.onSignInChanged')
          })
        }
        if (perms.has('declarativeNetRequest') || perms.has('declarativeNetRequestWithHostAccess')) {
          define('declarativeNetRequest', {
            HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' },
            RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow', UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders', ALLOW_ALL_REQUESTS: 'allowAllRequests' },
            ResourceType: {
              MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet', SCRIPT: 'script', IMAGE: 'image', FONT: 'font',
              OBJECT: 'object', XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report', MEDIA: 'media',
              WEBSOCKET: 'websocket', WEBTRANSPORT: 'webtransport', WEBBUNDLE: 'webbundle', OTHER: 'other'
            },
            updateSessionRules: call('declarativeNetRequest.updateSessionRules'),
            getSessionRules: call('declarativeNetRequest.getSessionRules'),
            updateDynamicRules: call('declarativeNetRequest.updateDynamicRules'),
            getDynamicRules: call('declarativeNetRequest.getDynamicRules')
          })
        }
      }
    })
  } catch (err) {
    console.error('[Caravel] Kompatibilitätsschicht (früh):', err)
  }
}
