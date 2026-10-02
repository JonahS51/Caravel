// Preload für Webseiten-Tabs (sandboxed). Liefert Umgebungsfarbe, Peek-Klicks
// und – nur auf internen caravel://-Seiten – Daten für die Neuer-Tab-Seite.
const { ipcRenderer, contextBridge } = require('electron')

const isInternal = location.protocol === 'caravel:'

// Werbeblocker: Skriptfilter (uBlock-Scriptlets) synchron vor allen Seitenskripten
// in der Hauptwelt der Seite ausführen.
if (/^https?:/.test(location.protocol)) {
  try {
    const scripts = ipcRenderer.sendSync('adblock:scriptlets', location.href)
    if (Array.isArray(scripts) && scripts.length) {
      // eslint-disable-next-line no-new-func
      const run = new Function(scripts.map(s => `try {\n${s}\n} catch (e) {}`).join('\n'))
      contextBridge.executeInMainWorld({ func: run })
    }
  } catch {}
}

if (isInternal) {
  contextBridge.exposeInMainWorld('caravelNTP', {
    lang: (() => { try { return ipcRenderer.sendSync('app:lang-sync') } catch { return 'de' } })(),
    getData: () => ipcRenderer.invoke('ntp:data'),
    bookmark: (op, data) => ipcRenderer.invoke('ntp:bookmark', op, data),
    onChanged: cb => { ipcRenderer.on('ntp:changed', () => cb()) }
  })
}

if (window.top === window) {
  // Shift + Klick auf einen Link → Peek-Vorschau statt Navigation
  window.addEventListener('click', e => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.button !== 0) return
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!a || !/^https?:/.test(a.href)) return
    e.preventDefault()
    e.stopPropagation()
    ipcRenderer.sendToHost('peek', a.href)
  }, true)

  // Umgebungsfarbe der Website ermitteln (theme-color oder Hintergrund oben)
  let lastColor = null
  const report = () => {
    let color = null
    const metas = [...document.querySelectorAll('meta[name="theme-color"]')]
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    const meta = metas.find(m => {
      const media = m.getAttribute('media')
      return !media || matchMedia(media).matches
    }) || metas[0]
    if (meta) color = meta.getAttribute('content')
    if (!color) {
      let el = document.elementFromPoint(Math.round(innerWidth / 2), 4)
      while (el) {
        const bg = getComputedStyle(el).backgroundColor
        if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { color = bg; break }
        el = el.parentElement
      }
      if (!color) color = dark ? 'rgb(24,24,27)' : 'rgb(255,255,255)'
    }
    if (color !== lastColor) {
      lastColor = color
      ipcRenderer.sendToHost('theme-color', color)
    }
  }
  const schedule = () => setTimeout(report, 120)
  window.addEventListener('DOMContentLoaded', () => {
    report()
    const head = document.head
    if (head) new MutationObserver(schedule).observe(head, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] })
  })
  window.addEventListener('load', schedule)
}

// ---------------------------------------------------------------------------
// Chromecast für Webseiten: Chrome stellt dem Cast SDK (cast_sender.js) die Presentation API mit
// cast:-URLs bereit. Caravel bildet sie nach und leitet die Sitzung über den Hauptprozess an das Gerät.

function castPolyfill () {
  const B = window.__caravelCast
  if (!B) return
  const conns = new Map()
  const availabilities = new Set()
  let defaultRequest = null

  const fire = (target, type, props = {}) => {
    const ev = type === 'message' ? new MessageEvent('message', { data: props.data }) : new Event(type)
    for (const [k, v] of Object.entries(props)) if (k !== 'data') Object.defineProperty(ev, k, { value: v })
    target.dispatchEvent(ev)
    const handler = target['on' + type]
    if (typeof handler === 'function') { try { handler.call(target, ev) } catch (e) { setTimeout(() => { throw e }) } }
  }

  class PresentationConnection extends EventTarget {
    constructor (info) {
      super()
      this.id = info.presentationId
      this.url = info.url
      this.state = 'connected'
      this.binaryType = 'arraybuffer'
      this.onmessage = this.onclose = this.onterminate = this.onconnect = null
      Object.defineProperty(this, '_c', { value: info.connId })
      conns.set(info.connId, this)
    }

    send (data) {
      if (this.state !== 'connected') throw new DOMException('Die Verbindung ist nicht offen.', 'InvalidStateError')
      B.send(this._c, String(data))
    }

    close () {
      if (this.state !== 'connected' && this.state !== 'connecting') return
      this.state = 'closed'
      conns.delete(this._c)
      B.close(this._c)
      setTimeout(() => fire(this, 'close', { reason: 'closed', message: '' }))
    }

    terminate () {
      if (this.state !== 'connected') return
      B.terminate(this._c)
    }
  }

  class PresentationAvailability extends EventTarget {
    constructor (value) {
      super()
      this._v = value
      this.onchange = null
      availabilities.add(this)
    }

    get value () { return this._v }
  }

  const abs = u => { try { return new URL(u, location.href).href } catch { throw new DOMException('Ungültige URL', 'SyntaxError') } }

  class PresentationRequest extends EventTarget {
    constructor (urls) {
      super()
      const list = (Array.isArray(urls) ? urls : [urls]).map(u => abs(String(u)))
      if (!list.length) throw new DOMException('Keine URL', 'NotSupportedError')
      Object.defineProperty(this, '_urls', { value: list })
      this.onconnectionavailable = null
    }

    start () {
      return B.start(this._urls).then(r => {
        if (!r || r.error) throw new DOMException(r?.message || 'Abgebrochen', r?.error || 'AbortError')
        return new PresentationConnection(r)
      })
    }

    reconnect (id) {
      return B.reconnect(this._urls, String(id)).then(r => {
        if (!r || r.error) throw new DOMException('Keine passende Präsentation', 'NotFoundError')
        return new PresentationConnection(r)
      })
    }

    getAvailability () {
      return B.availability(this._urls).then(v => new PresentationAvailability(!!v))
    }
  }

  B.onEvent(ev => {
    if (ev.type === 'availability') {
      for (const a of availabilities) if (a._v !== ev.value) { a._v = ev.value; fire(a, 'change') }
      return
    }
    if (ev.type === 'connectionavailable') {
      if (defaultRequest) fire(defaultRequest, 'connectionavailable', { connection: new PresentationConnection(ev) })
      return
    }
    const c = conns.get(ev.connId)
    if (!c) return
    if (ev.type === 'message') {
      if (c.state === 'connected') fire(c, 'message', { data: ev.data })
    } else if (ev.type === 'close') {
      c.state = 'closed'
      conns.delete(ev.connId)
      fire(c, 'close', { reason: ev.reason || 'closed', message: '' })
    } else if (ev.type === 'terminate') {
      c.state = 'terminated'
      conns.delete(ev.connId)
      fire(c, 'terminate')
    }
  })

  const presentation = {
    get defaultRequest () { return defaultRequest },
    set defaultRequest (r) {
      defaultRequest = r instanceof PresentationRequest ? r : null
      B.setDefault(defaultRequest ? defaultRequest._urls : null)
    },
    receiver: null
  }
  try {
    Object.defineProperty(Navigator.prototype, 'presentation', { configurable: true, enumerable: true, get () { return presentation } })
  } catch {}
  for (const [name, value] of Object.entries({ PresentationRequest, PresentationConnection, PresentationAvailability })) {
    Object.defineProperty(window, name, { configurable: true, writable: true, value })
  }
  // Das Cast SDK lädt nur, wenn window.chrome existiert (wie in Chrome)
  if (!window.chrome) Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: {} })
}

if (/^https:/.test(location.protocol) && window.top === window) {
  const castListeners = []
  ipcRenderer.on('castp:event', (_e, ev) => { for (const cb of castListeners) { try { cb(ev) } catch {} } })
  contextBridge.exposeInMainWorld('__caravelCast', {
    start: urls => ipcRenderer.invoke('castp:start', urls),
    reconnect: (urls, id) => ipcRenderer.invoke('castp:reconnect', urls, id),
    availability: urls => ipcRenderer.invoke('castp:availability', urls),
    setDefault: urls => ipcRenderer.send('castp:default', urls),
    send: (id, data) => ipcRenderer.send('castp:send', id, data),
    close: id => ipcRenderer.send('castp:close', id),
    terminate: id => ipcRenderer.send('castp:terminate', id),
    onEvent: cb => { castListeners.push(cb) }
  })
  try { contextBridge.executeInMainWorld({ func: castPolyfill }) } catch {}
}
