// Eingebauter Werbeblocker mit den Filterlisten von uBlock Origin.
//
// uBlock Origin selbst kann in Electron nicht sinnvoll laufen: Electron meldet
// Erweiterungen für jede Anfrage die Tab-ID -1, wodurch uBlock nichts einer Seite
// zuordnen kann und fast nichts blockiert. Deshalb nutzt Caravel die Filter-Engine
// @ghostery/adblocker-electron, die uBlocks Filtersyntax inkl. Skriptfilter
// („Scriptlets“) versteht, und lädt damit exakt uBlocks Listen direkt von dessen
// offiziellen Servern.
const fs = require('node:fs')
const path = require('node:path')
const { net } = require('electron')
const { ElectronBlocker } = require('@ghostery/adblocker-electron')
const { parse } = require('tldts-experimental')

const UBO = 'https://ublockorigin.github.io/uAssets'
const LISTS = {
  base: [
    `${UBO}/filters/filters.txt`, // uBlock filters (inkl. Jahreslisten per !#include)
    `${UBO}/filters/badware.txt`,
    `${UBO}/filters/privacy.txt`,
    `${UBO}/filters/quick-fixes.txt`, // u. a. aktuelle YouTube-Werbung
    `${UBO}/filters/unbreak.txt`,
    `${UBO}/filters/resource-abuse.txt`,
    `${UBO}/thirdparties/easylist.txt`,
    `${UBO}/thirdparties/easyprivacy.txt`,
    'https://easylist.to/easylistgermany/easylistgermany.txt'
  ],
  cookies: [
    `${UBO}/filters/annoyances-cookies.txt`
  ]
}
const RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json'
const MAX_AGE = 24 * 60 * 60 * 1000

async function fetchText (url) {
  let lastError
  for (let i = 0; i < 3; i++) {
    try {
      const res = await net.fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.text()
    } catch (err) {
      lastError = err
      await new Promise(r => setTimeout(r, 800))
    }
  }
  throw lastError
}

// Löst uBlocks `!#include datei.txt` relativ zur Liste auf
async function fetchList (url, depth = 0) {
  const text = await fetchText(url)
  if (depth > 2 || !text.includes('!#include')) return text
  const parts = await Promise.all(text.split('\n').map(async line => {
    const m = /^!#include\s+(\S+)/.exec(line.trim())
    if (!m) return line
    try { return await fetchList(new URL(m[1], url).href, depth + 1) } catch { return '' }
  }))
  return parts.join('\n')
}

class AdBlock {
  constructor (dir, session) {
    this.dir = dir
    this.session = session
    this.blocker = null
    this.enabled = false
    this.cookies = false
    this.blockedTotal = 0
    this.perTab = new Map()
    this.onBlocked = () => {}
    this.status = 'idle'
    this.updated = 0
  }

  cacheFile () { return path.join(this.dir, `adblock-${this.cookies ? 'cookies' : 'base'}.bin`) }

  async build () {
    const urls = [...LISTS.base, ...(this.cookies ? LISTS.cookies : [])]
    const [lists, resources] = await Promise.all([
      Promise.all(urls.map(u => fetchList(u).catch(err => { console.warn('[adblock] Liste fehlt:', err.message); return '' }))),
      fetchText(RESOURCES)
    ])
    const blocker = ElectronBlocker.parse(lists.join('\n'), {
      enableCompression: true,
      loadCosmeticFilters: true,
      loadNetworkFilters: true,
      loadExtendedSelectors: true,
      enableHtmlFiltering: false
    })
    blocker.updateResources(resources, String(resources.length))
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.cacheFile(), blocker.serialize())
    return blocker
  }

  async load ({ forceUpdate = false } = {}) {
    this.status = 'loading'
    let blocker = null
    const file = this.cacheFile()
    try {
      const stat = fs.statSync(file)
      if (!forceUpdate) {
        blocker = ElectronBlocker.deserialize(fs.readFileSync(file))
        this.updated = stat.mtimeMs
        if (Date.now() - stat.mtimeMs > MAX_AGE) this.refreshLater()
      }
    } catch {}
    if (!blocker) {
      blocker = await this.build()
      this.updated = Date.now()
    }
    this.swap(blocker)
    this.status = 'ready'
  }

  refreshLater () {
    setTimeout(() => this.load({ forceUpdate: true }).catch(err => console.warn('[adblock] Update fehlgeschlagen:', err.message)), 15000)
  }

  // Ausnahmeliste: Websites, auf denen der Blocker pausiert (inkl. Subdomains)
  setAllowlist (hosts = []) {
    this.allow = new Set(hosts.map(h => h.toLowerCase().replace(/^www\./, '')))
  }

  isAllowed (url) {
    if (!this.allow?.size) return false
    let host
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
    while (host) {
      if (this.allow.has(host)) return true
      const dot = host.indexOf('.')
      if (dot === -1) return false
      host = host.slice(dot + 1)
    }
    return false
  }

  pageUrlOf (details) {
    try {
      if (details.resourceType === 'mainFrame') return details.url
      const wc = details.webContents
      if (wc && !wc.isDestroyed()) return wc.getURL()
    } catch {}
    return details.referrer || ''
  }

  // Skriptfilter für eine URL – das Tab-Preload holt sie synchron beim Dokumentstart ab.
  // Nur so laufen sie (wie bei uBlock Origin) garantiert vor den Skripten der Seite,
  // was z. B. für YouTube entscheidend ist.
  scriptletsFor (url) {
    if (!this.enabled || !this.blocker || !/^https?:/.test(url) || this.isAllowed(url)) return []
    const { hostname, domain } = parse(url)
    const { active, scripts } = this.blocker.getCosmeticsFilters({
      url,
      hostname: hostname || '',
      domain: domain || '',
      getBaseRules: false,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false
    })
    return active === false ? [] : scripts
  }

  swap (blocker) {
    const wasActive = this.enabled && this.blocker
    if (wasActive) this.blocker.disableBlockingInSession(this.session)
    this.blocker = blocker
    // Die Engine würde Skriptfilter nur verzögert (asynchron) einfügen. Hier liefert sie
    // deshalb nur noch CSS; die Skriptfilter kommen über scriptletsFor() ins Preload.
    const onBeforeRequest = blocker.onBeforeRequest
    const onHeadersReceived = blocker.onHeadersReceived
    blocker.onBeforeRequest = (details, cb) => this.isAllowed(this.pageUrlOf(details)) ? cb({}) : onBeforeRequest(details, cb)
    blocker.onHeadersReceived = (details, cb) => this.isAllowed(this.pageUrlOf(details)) ? cb({ responseHeaders: details.responseHeaders }) : onHeadersReceived(details, cb)
    blocker.onInjectCosmeticFilters = async (event, url, msg) => {
      if (this.isAllowed(url)) return
      const { hostname, domain } = parse(url)
      const first = msg === undefined
      const { active, styles } = blocker.getCosmeticsFilters({
        url,
        hostname: hostname || '',
        domain: domain || '',
        classes: msg?.classes,
        hrefs: msg?.hrefs,
        ids: msg?.ids,
        getBaseRules: first,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromHostname: first,
        getRulesFromDOM: !first,
        callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: msg?.lifecycle }
      })
      if (active !== false && styles.length > 0) event.sender.insertCSS(styles, { cssOrigin: 'user' }).catch(() => {})
    }
    blocker.on('request-blocked', req => {
      this.blockedTotal++
      const id = req.tabId
      const n = (this.perTab.get(id) || 0) + 1
      this.perTab.set(id, n)
      this.onBlocked(id, n, this.blockedTotal)
    })
    if (this.enabled) blocker.enableBlockingInSession(this.session)
  }

  async setEnabled (enabled, cookies) {
    const cookiesChanged = !!cookies !== this.cookies
    this.cookies = !!cookies
    if (enabled && (!this.blocker || cookiesChanged)) {
      this.enabled = enabled
      await this.load()
      return
    }
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!this.blocker) return
    if (enabled) this.blocker.enableBlockingInSession(this.session)
    else this.blocker.disableBlockingInSession(this.session)
  }

  resetTab (tabId) { this.perTab.set(tabId, 0) }
}

module.exports = { AdBlock }
