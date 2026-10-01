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
    getData: () => ipcRenderer.invoke('ntp:data')
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
