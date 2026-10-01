// Eingebauter MCP-Server für Claude Code (Model Context Protocol, „Streamable HTTP“).
//
// Claude Code verbindet sich lokal mit
//   claude mcp add --transport http caravel http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
// und kann dann Tabs in Caravel auflisten, öffnen, lesen, anklicken, ausfüllen und fotografieren.
// Der Server lauscht nur auf 127.0.0.1 und verlangt ein zufälliges Zugangstoken.
const http = require('node:http')
const crypto = require('node:crypto')
const { webContents } = require('electron')

const PROTOCOL_VERSION = '2025-06-18'

const TOOLS = [
  {
    name: 'list_tabs',
    description: 'Listet alle Tabs in Caravel (ID, Titel, URL, aktiv, Space). Schlafende Tabs haben noch keine Seite geladen.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'open_tab',
    description: 'Öffnet eine URL in einem neuen Tab und wartet, bis die Seite geladen ist. Gibt die Tab-ID zurück.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, background: { type: 'boolean', description: 'Im Hintergrund öffnen' } }, required: ['url'] }
  },
  {
    name: 'select_tab',
    description: 'Macht einen Tab zum aktiven Tab (und weckt ihn auf, falls er schläft).',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' } }, required: ['tab_id'] }
  },
  {
    name: 'close_tab',
    description: 'Schließt einen Tab.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' } }, required: ['tab_id'] }
  },
  {
    name: 'navigate',
    description: 'Navigiert einen Tab (Standard: aktiver Tab) zu einer URL oder zurück/vorwärts/neu laden und wartet auf das Laden.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'number' },
        url: { type: 'string' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] }
      }
    }
  },
  {
    name: 'read_page',
    description: 'Liest den Inhalt einer Seite als gut lesbares Markdown (Artikel-Erkennung wie im Leser-Modus) oder als reinen Text.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, format: { type: 'string', enum: ['markdown', 'text'] }, max_chars: { type: 'number' } } }
  },
  {
    name: 'snapshot',
    description: 'Listet die sichtbaren, bedienbaren Elemente der Seite (Links, Buttons, Eingabefelder …) mit Referenzen wie "e12". Diese Referenzen nutzt du für click und fill.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, max_items: { type: 'number' } } }
  },
  {
    name: 'click',
    description: 'Klickt auf ein Element (Referenz aus snapshot oder CSS-Selektor).',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' } } }
  },
  {
    name: 'fill',
    description: 'Setzt den Wert eines Eingabefelds oder einer Auswahl (Referenz oder CSS-Selektor). Optional anschließend Enter drücken.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' }, submit: { type: 'boolean' } }, required: ['value'] }
  },
  {
    name: 'press_key',
    description: 'Drückt eine Taste im Tab, z. B. "Enter", "Escape", "Tab", "ArrowDown", "PageDown".',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, key: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'scroll',
    description: 'Scrollt die Seite nach oben/unten oder an den Anfang/das Ende.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } }, required: ['direction'] }
  },
  {
    name: 'screenshot',
    description: 'Erstellt ein Bildschirmfoto des sichtbaren Bereichs eines Tabs.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' } } }
  },
  {
    name: 'evaluate',
    description: 'Führt JavaScript in der Seite aus und gibt das Ergebnis (JSON-serialisierbar) zurück.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, script: { type: 'string', description: 'Ausdruck oder (async) Funktionskörper mit return' } }, required: ['script'] }
  },
  {
    name: 'wait_for',
    description: 'Wartet, bis ein Text oder ein CSS-Selektor auf der Seite erscheint (max. timeout_ms).',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, text: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'number' } } }
  }
]

// Im Seitenkontext: bedienbare Elemente sammeln und mit data-caravel-ref markieren
const SNAPSHOT_JS = `(function (max) {
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=true], summary';
  const out = [];
  let n = 0;
  document.querySelectorAll('[data-caravel-ref]').forEach(el => el.removeAttribute('data-caravel-ref'));
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= max) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-caravel-ref', ref);
    const tag = el.tagName.toLowerCase();
    const label = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.placeholder || el.innerText || el.value || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const inView = r.bottom > 0 && r.top < innerHeight;
    let line = ref + ' ' + (el.getAttribute('role') || tag);
    if (tag === 'input') line += '[' + (el.type || 'text') + ']';
    if (label) line += ' "' + label + '"';
    if (tag === 'a' && el.getAttribute('href')) line += ' -> ' + el.href.slice(0, 120);
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.value && el.type !== 'password') line += ' = "' + String(el.value).slice(0, 60) + '"';
    if (el.checked) line += ' (angehakt)';
    if (el.disabled) line += ' (deaktiviert)';
    if (!inView) line += ' (außerhalb des sichtbaren Bereichs)';
    out.push(line);
  }
  return { title: document.title, url: location.href, items: out };
})`

const FIND_JS = `function (ref, selector) {
  const el = ref ? document.querySelector('[data-caravel-ref="' + ref + '"]') : document.querySelector(selector);
  if (!el) throw new Error(ref ? 'Referenz ' + ref + ' nicht gefunden – bitte snapshot erneut aufrufen.' : 'Kein Element für ' + selector);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  return el;
}`

// Die Tab-IDs sind die stabilen Tab-Nummern der Oberfläche (funktionieren auch für schlafende Tabs).
// ui: { tabs() → [{id, title, url, active, sleeping, space}], resolve(id?) → webContentsId (weckt auf),
//       open(url, background) → id, select(id), close(id) }
class McpServer {
  constructor ({ ui, markAgent, readabilitySource, turndownSource }) {
    Object.assign(this, { ui, markAgent, readabilitySource, turndownSource })
    this.server = null
    this.port = null
    this.token = null
    this.sessions = new Set()
  }

  start (port, token) {
    if (this.server && this.port === port && this.token === token) return Promise.resolve()
    this.stop()
    this.port = port
    this.token = token
    this.server = http.createServer((req, res) => this.handle(req, res).catch(err => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } }))
    }))
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', resolve)
    })
  }

  stop () {
    if (this.server) { try { this.server.close() } catch {} }
    this.server = null
  }

  async handle (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/mcp') { res.writeHead(404); return res.end() }
    // Schutz vor DNS-Rebinding und fremden Webseiten
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { res.writeHead(403); return res.end() }
    const auth = req.headers.authorization || ''
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''))
    const expected = Buffer.from(this.token)
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
      return res.end(JSON.stringify({ error: 'Ungültiges oder fehlendes Zugangstoken' }))
    }
    if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE' }); return res.end() }
    if (req.method === 'DELETE') { this.sessions.delete(req.headers['mcp-session-id']); res.writeHead(200); return res.end() }
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }

    let body = ''
    for await (const chunk of req) body += chunk
    let msg
    try { msg = JSON.parse(body) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    }
    const batch = Array.isArray(msg) ? msg : [msg]
    const headers = { 'Content-Type': 'application/json' }
    const replies = []
    for (const m of batch) {
      if (m.method === 'initialize') {
        const sid = crypto.randomUUID()
        this.sessions.add(sid)
        headers['Mcp-Session-Id'] = sid
      }
      if (m.id === undefined || m.id === null) continue // Benachrichtigung
      replies.push(await this.dispatch(m))
    }
    if (!replies.length) { res.writeHead(202, headers); return res.end() }
    res.writeHead(200, headers)
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]))
  }

  async dispatch (m) {
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result })
    try {
      switch (m.method) {
        case 'initialize':
          return ok({
            protocolVersion: m.params?.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'caravel-browser', title: 'Caravel Browser', version: '2.0.0' },
            instructions: 'Steuert den Webbrowser Caravel. Typischer Ablauf: list_tabs oder open_tab → read_page bzw. snapshot → click/fill → erneut snapshot. Tab-IDs stammen aus list_tabs/open_tab; ohne tab_id wird der aktive Tab verwendet.'
          })
        case 'ping':
          return ok({})
        case 'tools/list':
          return ok({ tools: TOOLS })
        case 'tools/call': {
          const { name, arguments: args = {} } = m.params || {}
          try {
            const content = await this.callTool(name, args)
            return ok({ content, isError: false })
          } catch (err) {
            return ok({ content: [{ type: 'text', text: `Fehler: ${err.message}` }], isError: true })
          }
        }
        default:
          return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Methode nicht gefunden: ${m.method}` } }
      }
    } catch (err) {
      return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: err.message } }
    }
  }

  // --- Werkzeuge ------------------------------------------------------------

  async wc (tabId) {
    const wcId = await this.ui.resolve(tabId ?? null)
    if (wcId?.error) throw new Error(wcId.error)
    const wc = wcId && webContents.fromId(wcId)
    if (!wc || wc.isDestroyed()) throw new Error(tabId ? `Tab ${tabId} ist nicht verfügbar.` : 'Kein aktiver Tab.')
    this.markAgent(wc.id)
    return wc
  }

  waitForLoad (wc, timeout = 20000) {
    return new Promise(resolve => {
      if (!wc.isLoading()) return setTimeout(resolve, 150)
      const done = () => { clearTimeout(t); wc.removeListener('did-stop-loading', done); resolve() }
      const t = setTimeout(done, timeout)
      wc.on('did-stop-loading', done)
    })
  }

  text (t) { return [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] }

  async run (wc, fnSource, ...args) {
    return wc.executeJavaScript(`(${fnSource})(${args.map(a => JSON.stringify(a ?? null)).join(',')})`, true)
  }

  async callTool (name, a) {
    switch (name) {
      case 'list_tabs': {
        const tabs = await this.ui.tabs()
        return this.text(tabs.map(t => `${t.id}${t.active ? ' (aktiv)' : ''}${t.sleeping ? ' (schläft)' : ''} · ${t.title} · ${t.url} · Space „${t.space}“`).join('\n') || 'Keine Tabs geöffnet.')
      }
      case 'open_tab': {
        if (!/^(https?|file):/i.test(a.url || '')) throw new Error('Nur http(s)- und file-URLs sind erlaubt.')
        const id = await this.ui.open(a.url, !!a.background)
        const wc = await this.wc(id)
        await this.waitForLoad(wc)
        return this.text(`Tab ${id} geöffnet: ${wc.getTitle() || a.url}`)
      }
      case 'select_tab': {
        const res = await this.ui.select(a.tab_id)
        if (res?.error) throw new Error(res.error)
        return this.text(`Tab ${a.tab_id} ist jetzt aktiv.`)
      }
      case 'close_tab': {
        const res = await this.ui.close(a.tab_id)
        if (res?.error) throw new Error(res.error)
        return this.text(`Tab ${a.tab_id} geschlossen.`)
      }
      case 'navigate': {
        const wc = await this.wc(a.tab_id)
        if (a.action === 'back') wc.navigationHistory.goBack()
        else if (a.action === 'forward') wc.navigationHistory.goForward()
        else if (a.action === 'reload') wc.reload()
        else if (a.url) {
          if (!/^(https?|file):/i.test(a.url)) throw new Error('Nur http(s)- und file-URLs sind erlaubt.')
          await wc.loadURL(a.url).catch(() => {})
        } else throw new Error('url oder action angeben.')
        await this.waitForLoad(wc)
        return this.text(`${wc.getTitle()} – ${wc.getURL()}`)
      }
      case 'read_page': {
        const wc = await this.wc(a.tab_id)
        const max = a.max_chars || 40000
        if (a.format === 'text') {
          const t = await wc.executeJavaScript('document.body ? document.body.innerText : ""', true)
          return this.text(`# ${wc.getTitle()}\n${wc.getURL()}\n\n${t.slice(0, max)}`)
        }
        const page = await wc.executeJavaScript(`(function () {
          ${this.readabilitySource()}
          ${this.turndownSource()}
          var html = null, title = document.title;
          try { var art = new Readability(document.cloneNode(true), { charThreshold: 250 }).parse(); if (art && art.content) { html = art.content; title = art.title || title; } } catch (e) {}
          var td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
          td.remove(['script', 'style', 'noscript', 'iframe']);
          var md; try { md = td.turndown(html || document.body.innerHTML); } catch (e) { md = document.body.innerText; }
          return { title: title, url: location.href, markdown: md.replace(/\\n{3,}/g, '\\n\\n').trim() };
        })()`, true)
        const md = page.markdown.length > max ? page.markdown.slice(0, max) + '\n\n[… gekürzt]' : page.markdown
        return this.text(`# ${page.title}\n${page.url}\n\n${md}`)
      }
      case 'snapshot': {
        const wc = await this.wc(a.tab_id)
        const snap = await this.run(wc, SNAPSHOT_JS, a.max_items || 250)
        return this.text(`${snap.title}\n${snap.url}\n\n${snap.items.join('\n') || '(keine bedienbaren Elemente gefunden)'}`)
      }
      case 'click': {
        const wc = await this.wc(a.tab_id)
        if (!a.ref && !a.selector) throw new Error('ref oder selector angeben.')
        const before = wc.getURL()
        const label = await this.run(wc, `function (ref, selector) {
          const find = ${FIND_JS};
          const el = find(ref, selector);
          el.focus && el.focus();
          el.click();
          return (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 60);
        }`, a.ref, a.selector)
        await new Promise(r => setTimeout(r, 400))
        await this.waitForLoad(wc, 8000)
        const after = wc.getURL()
        return this.text(`Geklickt: „${label}“${after !== before ? ` → ${after}` : ''}`)
      }
      case 'fill': {
        const wc = await this.wc(a.tab_id)
        if (!a.ref && !a.selector) throw new Error('ref oder selector angeben.')
        await this.run(wc, `function (ref, selector, value) {
          const find = ${FIND_JS};
          const el = find(ref, selector);
          el.focus();
          if (el.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('insertText', false, value); return; }
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }`, a.ref, a.selector, a.value)
        if (a.submit) {
          await this.pressKey(wc, 'Enter')
          await new Promise(r => setTimeout(r, 400))
          await this.waitForLoad(wc, 10000)
        }
        return this.text(`Wert gesetzt${a.submit ? ' und Enter gedrückt' : ''}.`)
      }
      case 'press_key': {
        const wc = await this.wc(a.tab_id)
        await this.pressKey(wc, a.key)
        await new Promise(r => setTimeout(r, 250))
        return this.text(`Taste ${a.key} gedrückt.`)
      }
      case 'scroll': {
        const wc = await this.wc(a.tab_id)
        const js = { up: 'scrollBy(0, -innerHeight * 0.85)', down: 'scrollBy(0, innerHeight * 0.85)', top: 'scrollTo(0, 0)', bottom: 'scrollTo(0, document.body.scrollHeight)' }[a.direction]
        if (!js) throw new Error('Unbekannte Richtung.')
        const pos = await wc.executeJavaScript(`${js}; ({ y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) })`, true)
        return this.text(`Scrollposition ${pos.y} von ${pos.max}.`)
      }
      case 'screenshot': {
        const wc = await this.wc(a.tab_id)
        let img = await wc.capturePage()
        const { width } = img.getSize()
        if (width > 1280) img = img.resize({ width: 1280 })
        return [{ type: 'image', data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' }]
      }
      case 'evaluate': {
        const wc = await this.wc(a.tab_id)
        const src = String(a.script || '')
        const wrapped = /\breturn\b/.test(src) ? `(async () => { ${src} })()` : `(async () => (${src}))()`
        const result = await wc.executeJavaScript(`${wrapped}.then(v => { try { return JSON.stringify(v) } catch (e) { return String(v) } })`, true)
        return this.text(result === undefined ? 'undefined' : result)
      }
      case 'wait_for': {
        const wc = await this.wc(a.tab_id)
        const until = Date.now() + Math.min(a.timeout_ms || 10000, 60000)
        while (Date.now() < until) {
          const found = await this.run(wc, `function (text, selector) {
            if (selector && document.querySelector(selector)) return true;
            if (text && document.body && document.body.innerText.includes(text)) return true;
            return false;
          }`, a.text, a.selector).catch(() => false)
          if (found) return this.text('Gefunden.')
          await new Promise(r => setTimeout(r, 300))
        }
        throw new Error('Zeitüberschreitung – nicht gefunden.')
      }
      default:
        throw new Error(`Unbekanntes Werkzeug: ${name}`)
    }
  }

  async pressKey (wc, key) {
    const map = { Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right', PageDown: 'PageDown', PageUp: 'PageUp', Space: 'Space', Home: 'Home', End: 'End' }
    const keyCode = map[key] || key
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: key })
    if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
  }
}

module.exports = { McpServer }
