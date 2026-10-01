// Fokus-Modus: sperrt ablenkende Websites, solange eine Session läuft.
// Bewusst ohne session.webRequest umgesetzt – ein solcher Listener würde die
// chrome.webRequest-Ereignisse von uBlock Origin abschalten.

class FocusGuard {
  constructor (blockedPageUrl) {
    this.blockedPageUrl = blockedPageUrl
    this.active = false
    this.domains = new Set()
  }

  set (active, domains = []) {
    this.active = !!active
    this.domains = new Set(domains.map(d => d.trim().toLowerCase()).filter(Boolean))
  }

  matches (url) {
    let host
    try { host = new URL(url).hostname.toLowerCase() } catch { return false }
    while (host) {
      if (this.domains.has(host)) return true
      const dot = host.indexOf('.')
      if (dot === -1) return false
      host = host.slice(dot + 1)
    }
    return false
  }

  attach (wc) {
    const check = details => {
      if (!this.active || !details.isMainFrame || details.isSameDocument) return
      if (!/^https?:/.test(details.url) || !this.matches(details.url)) return
      wc.stop()
      setImmediate(() => {
        if (!wc.isDestroyed()) wc.loadURL(this.blockedPageUrl(details.url)).catch(() => {})
      })
    }
    wc.on('did-start-navigation', check)
    wc.on('did-redirect-navigation', check)
  }
}

module.exports = { FocusGuard }
