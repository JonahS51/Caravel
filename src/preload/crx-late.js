// Kompatibilitätsschicht, Teil 2 – läuft NACH dem Preload von electron-chrome-extensions.
// Ergänzt einzelne Methoden an Objekten, die die Bibliothek bereits angelegt hat.
const { contextBridge } = require('electron')

const isWorker = process.type === 'service-worker'
const isExtensionPage = !isWorker && typeof location !== 'undefined' && location.href.startsWith('chrome-extension://')

if (isWorker || isExtensionPage) {
  try {
    contextBridge.executeInMainWorld({
      func: function patchOdeCompat () {
        const chrome = globalThis.chrome
        const bridge = globalThis.__caravelCrx
        if (!chrome || !chrome.runtime || !chrome.runtime.id || !bridge) return
        const extId = chrome.runtime.id
        const call = fn => (...args) => {
          const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
          const p = bridge.invoke(extId, fn, args).then(res => {
            if (res && res.error) throw new Error(res.error)
            return res ? res.value : undefined
          })
          if (cb) { p.then(v => cb(v), () => cb(undefined)); return undefined }
          return p
        }
        const patch = (obj, name, value) => {
          if (!obj || obj[name]) return
          try { obj[name] = value } catch {}
          if (!obj[name]) { try { Object.defineProperty(obj, name, { value, configurable: true, writable: true }) } catch {} }
        }
        if (chrome.tabGroups) {
          patch(chrome.tabs, 'group', call('tabs.group'))
          patch(chrome.tabs, 'ungroup', call('tabs.ungroup'))
          patch(chrome.tabs, 'TAB_ID_NONE', -1)
        }
        // Electrons eigenes getContexts kennt keine Seitenleisten/Offscreen-Dokumente von Caravel → zusammenführen
        const nativeGetContexts = chrome.runtime.getContexts ? chrome.runtime.getContexts.bind(chrome.runtime) : null
        const caravelGetContexts = call('runtime.getContexts')
        const mergedGetContexts = async (filter = {}, cb) => {
          const [a, b] = await Promise.all([
            nativeGetContexts ? Promise.resolve(nativeGetContexts(filter)).catch(() => []) : [],
            caravelGetContexts(filter).catch(() => [])
          ])
          const all = [...(a || []), ...(b || [])]
          if (typeof cb === 'function') cb(all)
          return all
        }
        try { chrome.runtime.getContexts = mergedGetContexts } catch {}
        if (chrome.runtime.getContexts !== mergedGetContexts) {
          try { Object.defineProperty(chrome.runtime, 'getContexts', { value: mergedGetContexts, configurable: true, writable: true }) } catch {}
        }
        patch(chrome.runtime, 'ContextType', {
          TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL', DEVELOPER_TOOLS: 'DEVELOPER_TOOLS'
        })
        if (chrome.action) {
          patch(chrome.action, 'setBadgeTextColor', () => Promise.resolve())
          patch(chrome.action, 'getBadgeTextColor', () => Promise.resolve([255, 255, 255, 255]))
          if (!chrome.action.getUserSettings) patch(chrome.action, 'getUserSettings', () => Promise.resolve({ isOnToolbar: true }))
        }
        // Die Bibliothek stellt downloads.* nur als Platzhalter bereit
        if (chrome.downloads) {
          try { chrome.downloads.download = call('downloads.download') } catch {}
        }
      }
    })
  } catch (err) {
    console.error('[Caravel] Kompatibilitätsschicht (spät):', err)
  }
}
