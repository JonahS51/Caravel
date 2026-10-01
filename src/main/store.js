// Persistenter JSON-Speicher für Einstellungen, Spaces, Lesezeichen, Verlauf usw.
const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  settings: {
    searchEngine: 'google',
    theme: 'dark',
    ambient: true,
    adblock: true,
    adblockCookies: false,
    adblockAllowlist: [],
    sleepMinutes: 30,
    focusMinutes: 25,
    focusBlocklist: [
      'youtube.com', 'reddit.com', 'x.com', 'twitter.com', 'instagram.com',
      'tiktok.com', 'facebook.com', 'netflix.com', 'twitch.tv'
    ],
    restoreSession: true,
    userName: '',
    sidebarCollapsed: false,
    // KI-Assistent: 'claude' | 'chatgpt' | 'none' (claudeSidebar = Seitenleiste des gewählten Assistenten)
    assistant: 'claude',
    autoDarkPages: true,
    tabLayout: 'sidebar', // 'sidebar' | 'chrome' | 'safari'
    showFavbar: true,
    compactUi: false,
    claudeSidebar: true,
    claudeDockWidth: 420,
    claudeMcp: false,
    claudeMcpPort: 47823,
    claudeMcpToken: '',
    // VPN
    vpnMode: 'tor', // 'tor' | 'server'
    vpnCountry: 'auto',
    vpnServers: [], // { id, name, type: 'socks5'|'http'|'https'|'wireguard', host, port, user, pass, config }
    vpnServerId: null,
    vpnAutoConnect: false
  },
  spaces: [
    { id: 'space-personal', name: 'Persönlich', color: '#f2545b', icon: '✦', tabs: [], activeIndex: 0 },
    { id: 'space-work', name: 'Arbeit', color: '#3f74e0', icon: '◆', tabs: [], activeIndex: 0 }
  ],
  activeSpace: 'space-personal',
  bookmarks: [
    { id: 'bm-1', url: 'https://claude.ai/', title: 'Claude' },
    { id: 'bm-2', url: 'https://www.wikipedia.org/', title: 'Wikipedia' },
    { id: 'bm-3', url: 'https://www.youtube.com/', title: 'YouTube' },
    { id: 'bm-4', url: 'https://github.com/', title: 'GitHub' }
  ],
  history: [],
  notes: {},
  snapshots: [],
  permissions: {},
  unpackedExtensions: [],
  stats: { blocked: 0 },
  focusStats: { sessions: 0, minutes: 0 }
}

const MERGED = new Set(['settings', 'stats', 'focusStats'])

class Store {
  constructor (dir) {
    this.file = path.join(dir, 'caravel-data.json')
    this.data = structuredClone(DEFAULTS)
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] === undefined) continue
        this.data[key] = MERGED.has(key) ? { ...DEFAULTS[key], ...raw[key] } : raw[key]
      }
    } catch {}
    // Logo-Palette: alten Standard-Farbton des Spaces „Arbeit“ (Türkis) auf Segelblau umstellen
    for (const sp of this.data.spaces || []) {
      if (sp.id === 'space-work' && sp.color === '#2dd4bf') sp.color = '#3f74e0'
    }
    this.timer = null
  }

  get (key) { return this.data[key] }

  set (key, value) {
    if (!(key in DEFAULTS)) return
    this.data[key] = value
    this.scheduleSave()
  }

  scheduleSave () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
  }

  flush () {
    clearTimeout(this.timer)
    try {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] Speichern fehlgeschlagen:', err)
    }
  }

  // Vor app.ready lesbar (z. B. für den Remote-Debugging-Port)
  static peekSettings (dir) {
    try {
      return { ...DEFAULTS.settings, ...JSON.parse(fs.readFileSync(path.join(dir, 'caravel-data.json'), 'utf8')).settings }
    } catch { return { ...DEFAULTS.settings } }
  }
}

module.exports = { Store, DEFAULTS }
