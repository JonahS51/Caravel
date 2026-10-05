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
    onChanged: cb => { ipcRenderer.on('ntp:changed', () => cb()) },
    // Fehlerseite: Zertifikatsfehler auf Wunsch übergehen (der Hauptprozess prüft, dass es die Fehlerseite ist)
    proceedUnsafe: url => ipcRenderer.invoke('cert:proceed', url),
    // Quelltext-Seite: Quelltext einer Adresse laden
    source: url => ipcRenderer.invoke('page:source', url)
  })
}

if (window.top === window) {
  // Kürzel, die Webseiten selbst belegen dürfen (Strg+S, Strg+O, Strg+U, Strg+G, F3): erst nachdem die Seite
  // das Ereignis verarbeitet hat und nur, wenn sie es nicht abgefangen hat (wie in Chrome)
  const PAGE_SHORTCUTS = new Set(['Ctrl+S', 'Ctrl+O', 'Ctrl+U', 'Ctrl+G', 'Ctrl+Shift+G', 'F3', 'Shift+F3'])
  window.addEventListener('keydown', e => {
    let key = e.key
    if (key.length === 1) key = key.toUpperCase()
    const combo = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', key].filter(Boolean).join('+')
    if (!PAGE_SHORTCUTS.has(combo)) return
    setTimeout(() => { if (!e.defaultPrevented) ipcRenderer.send('page-shortcut', combo) }, 0)
  })

  // Sprache der Seite für das Übersetzungsangebot
  window.addEventListener('DOMContentLoaded', () => {
    const lang = document.documentElement.lang || document.querySelector('meta[http-equiv="content-language" i]')?.content || ''
    ipcRenderer.sendToHost('page-lang', lang.trim().toLowerCase())
  })
}

// ---------------------------------------------------------------------------
// Passwort-Manager: gespeicherte Zugangsdaten per Auswahlmenü am Eingabefeld ausfüllen und neue
// Anmeldungen zum Speichern anbieten. Passwörter erhält die Seite nur nach einem echten Klick im Menü.

if (/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(location.href) && window.top === window) {
  const bound = new WeakSet()
  let creds = null // [{ id, username }] – null = noch nicht abgefragt
  let menu = null
  let lastSent = ''

  const visible = el => !!(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
  const passwordFields = () => [...document.querySelectorAll('input[type=password]')].filter(visible)
  const USER_SEL = 'input[autocomplete~="username"], input[type=email], input[type=text], input[type=tel], input:not([type])'

  // Benutzerfeld zu einem Passwortfeld: das letzte sichtbare Textfeld davor (im selben Formular, falls vorhanden)
  function userFieldFor (pw) {
    const scope = pw?.form || document
    const before = [...scope.querySelectorAll(USER_SEL)].filter(el => visible(el) && (!pw || (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)))
    return before.find(el => /username/.test(el.autocomplete)) || before.pop() || null
  }

  function setValue (el, value) {
    if (!el) return
    el.focus()
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    proto.set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function hideMenu () { menu?.remove(); menu = null }

  function showMenu (field) {
    hideMenu()
    if (!creds?.length) return
    const r = field.getBoundingClientRect()
    const host = document.createElement('div')
    host.style.cssText = `all:initial;position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 4)}px;z-index:2147483647`
    const root = host.attachShadow({ mode: 'closed' })
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    root.innerHTML = `<style>
      .box{font:13px/1.3 'Segoe UI',system-ui,sans-serif;min-width:${Math.max(220, Math.round(r.width))}px;max-width:360px;background:${dark ? '#1b2236' : '#fff'};color:${dark ? '#e8ecf8' : '#101a33'};border:1px solid ${dark ? '#2c3550' : '#d5dae6'};border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:4px;overflow:hidden}
      .item{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:7px;cursor:default}
      .item:hover{background:${dark ? '#2a3350' : '#eef1f8'}}
      .key{width:16px;height:16px;flex:none;opacity:.7}
      .u{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .p{opacity:.6;letter-spacing:2px}
      .head{font-size:11px;opacity:.6;padding:6px 10px 2px}
    </style><div class="box"><div class="head">Caravel</div></div>`
    const box = root.querySelector('.box')
    for (const c of creds) {
      const item = document.createElement('div')
      item.className = 'item'
      item.innerHTML = '<svg class="key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg><div style="min-width:0"><div class="u"></div><div class="p">••••••••</div></div>'
      item.querySelector('.u').textContent = c.username || '—'
      item.addEventListener('mousedown', e => e.preventDefault()) // Fokus im Feld lassen
      item.addEventListener('click', async e => {
        if (!e.isTrusted) return
        hideMenu()
        const data = await ipcRenderer.invoke('pw:fill', c.id)
        if (!data) return
        const pw = field.type === 'password' ? field : passwordFields().find(p => userFieldFor(p) === field) || passwordFields()[0]
        const user = field.type === 'password' ? userFieldFor(field) : field
        if (user && data.username) setValue(user, data.username)
        if (pw) setValue(pw, data.password)
      })
      box.append(item)
    }
    document.documentElement.append(host)
    menu = host
  }

  function bind (field) {
    if (bound.has(field)) return
    bound.add(field)
    field.addEventListener('focus', () => { if (creds?.length && !field.value) showMenu(field) })
    field.addEventListener('click', () => { if (creds?.length) showMenu(field) })
    field.addEventListener('input', hideMenu)
    field.addEventListener('blur', () => setTimeout(hideMenu, 150))
    field.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu() })
  }

  async function scan () {
    const pws = passwordFields()
    const users = pws.map(userFieldFor).filter(Boolean)
    // zweistufige Anmeldungen (erst Benutzername, dann Passwort)
    for (const el of document.querySelectorAll('input[autocomplete~="username"], input[type=email]')) if (visible(el)) users.push(el)
    if (!pws.length && !users.length) return
    if (creds === null) {
      creds = []
      try { creds = await ipcRenderer.invoke('pw:query') } catch {}
    }
    if (!creds.length) return
    for (const f of [...pws, ...users]) bind(f)
  }

  // Anmeldung abgeschickt: Zugangsdaten zum Speichern anbieten
  function captured (form) {
    const pws = (form ? [...form.querySelectorAll('input[type=password]')] : passwordFields()).filter(p => p.value)
    const pw = pws[pws.length - 1] // bei „Passwort ändern“ das neue
    if (!pw) return
    const user = userFieldFor(pws[0])
    const data = { username: user?.value || '', password: pw.value }
    const key = data.username + '\n' + data.password
    if (key === lastSent) return
    lastSent = key
    ipcRenderer.send('pw:submitted', data)
  }

  window.addEventListener('submit', e => captured(e.target instanceof HTMLFormElement ? e.target : null), true)
  // Klick auf einen Absende-Knopf (oder bei Formularen ohne <form>: einen Knopf, der nach Anmeldung klingt).
  // Andere Knöpfe wie „Passwort anzeigen“ lösen kein Angebot aus.
  const LOGIN_WORDS = /log ?in|sign ?in|anmelden|einloggen|weiter|next|continue|submit|senden|bestätigen|registrieren|sign ?up|create/i
  window.addEventListener('click', e => {
    const btn = e.target instanceof Element ? e.target.closest('button, input[type=submit], input[type=button], [role=button]') : null
    if (!btn || !e.isTrusted) return
    const form = btn.form || btn.closest('form')
    const submits = btn.matches('input[type=submit]') || (btn.tagName === 'BUTTON' && (btn.getAttribute('type') || 'submit').toLowerCase() === 'submit' && !!form)
    const label = (btn.innerText || btn.value || btn.getAttribute('aria-label') || '').trim()
    if (submits || LOGIN_WORDS.test(label)) captured(form)
  }, true)
  window.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.isTrusted && e.target instanceof HTMLInputElement && (e.target.type === 'password' || passwordFields().some(p => p.value))) captured(e.target.form)
  }, true)
  window.addEventListener('scroll', hideMenu, true)
  window.addEventListener('resize', hideMenu)

  window.addEventListener('DOMContentLoaded', () => {
    scan()
    let timer = null
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 400) }).observe(document.documentElement, { childList: true, subtree: true })
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
