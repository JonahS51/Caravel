// Twitch-Werbepausen überspringen.
//
// Twitch schneidet Werbung serverseitig in den Videostream (HLS) – Filterlisten können sie deshalb nicht
// abfangen. Wie „TwitchAdSolutions“ (vaft) hängt sich dieses Skript in den Web-Worker des Players und liest die
// Wiedergabelisten (.m3u8) mit. Kündigt Twitch eine Werbepause an, holt es eine werbefreie Variante desselben
// Streams (andere Player-Typen wie „embed“ bekommen oft keine Werbung) und gibt dem Player deren Liste.
// Gibt es keine, werden die Werbe-Segmente entfernt (dann kurz Standbild statt Werbung).
//
// Das Skript läuft in der Hauptwelt der Seite vor allen Twitch-Skripten (über die Skriptfilter des Werbeblockers).

// Läuft im Worker des Players (und zusätzlich im Hauptfenster) – darf nichts von außen verwenden.
function hookPlaylists () {
  if (self.__caravelTwitch) return
  self.__caravelTwitch = true
  const realFetch = self.fetch.bind(self)
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
  const BACKUP_TYPES = ['embed', 'popout', 'autoplay']
  const masters = new Map() // Media-Playlist-URL → { channel, res, masterUrl }
  const backups = new Map() // Media-Playlist-URL → { url, at }
  const QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }'

  const hasAds = text => text.includes('stitched-ad') || text.includes('X-TV-TWITCH-AD') || /#EXTINF:[\d.]+,(?!live)/.test(text)

  // Varianten einer Master-Playlist: URL → Auflösung
  function parseMaster (text, base) {
    const out = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
      const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1] || ''
      const fps = (lines[i].match(/FRAME-RATE=([\d.]+)/) || [])[1] || ''
      const uri = (lines[i + 1] || '').trim()
      if (uri && !uri.startsWith('#')) out.push({ url: new URL(uri, base).href, res: res + '@' + Math.round(+fps || 0) })
    }
    return out
  }

  // Werbung ohne Ersatz: Segmente ohne „,live“ (Werbung) und die Vorab-Segmente entfernen
  function stripAds (text) {
    const lines = text.split('\n')
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l.startsWith('#EXTINF') && !l.includes(',live')) { i++; continue }
      if (l.startsWith('#EXT-X-TWITCH-PREFETCH')) continue
      out.push(l)
    }
    return out.join('\n')
  }

  async function backupPlaylist (mediaUrl) {
    const info = masters.get(mediaUrl)
    if (!info) return null
    const cached = backups.get(mediaUrl)
    if (cached && Date.now() - cached.at < 5 * 60e3) {
      const text = await (await realFetch(cached.url)).text()
      if (!hasAds(text)) return text
      backups.delete(mediaUrl)
    }
    for (const playerType of BACKUP_TYPES) {
      try {
        const gql = await realFetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ operationName: 'PlaybackAccessToken_Template', query: QUERY, variables: { isLive: true, login: info.channel, isVod: false, vodID: '', playerType } })
        })
        const token = (await gql.json())?.data?.streamPlaybackAccessToken
        if (!token?.value) continue
        const master = new URL(info.masterUrl)
        master.searchParams.set('sig', token.signature)
        master.searchParams.set('token', token.value)
        master.searchParams.set('p', String(Math.floor(Math.random() * 1e7)))
        const variants = parseMaster(await (await realFetch(master.href)).text(), master.href)
        if (!variants.length) continue
        const pick = variants.find(v => v.res === info.res) || variants.find(v => v.res.split('@')[0] === info.res.split('@')[0]) || variants[0]
        const text = await (await realFetch(pick.url)).text()
        if (hasAds(text)) continue
        backups.set(mediaUrl, { url: pick.url, at: Date.now() })
        return text
      } catch {}
    }
    return null
  }

  const replaceBody = (res, text) => new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })

  self.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    if (!url || !/\.m3u8(\?|$)/.test(url) || !/ttvnw\.net|twitch/.test(url)) return realFetch(input, init)
    const res = await realFetch(input, init)
    if (!res.ok) return res
    try {
      const text = await res.clone().text()
      // Master-Playlist eines Live-Kanals: Varianten merken (für die passende Ersatz-Auflösung)
      const live = url.match(/\/api\/channel\/hls\/([^/.?]+)\.m3u8/)
      if (live) {
        for (const v of parseMaster(text, url)) masters.set(v.url, { channel: live[1].toLowerCase(), res: v.res, masterUrl: url })
        return res
      }
      // nur Media-Playlists von Live-Streams (VODs haben keine „,live“-Segmente und blieben sonst leer)
      if (!masters.has(url) || !hasAds(text)) return res
      const backup = await backupPlaylist(url)
      return replaceBody(res, backup || stripAds(text))
    } catch {
      return res
    }
  }
}

// Hauptwelt: Worker des Twitch-Players mit dem Playlist-Haken starten
function installTwitchAdSkip (hook, hookSource) {
  if (window.__caravelTwitchWorker) return
  window.__caravelTwitchWorker = true
  try { hook() } catch {}
  const RealWorker = window.Worker
  window.Worker = class extends RealWorker {
    constructor (url, options) {
      let wrapped = null
      try {
        const href = new URL(String(url), location.href).href
        const req = new XMLHttpRequest()
        req.open('GET', href, false)
        req.overrideMimeType('text/javascript')
        req.send()
        const src = req.status === 200 || req.status === 0 ? req.responseText : ''
        // nur der Video-Worker (Amazon IVS / Twitch-Player), keine anderen Worker der Seite
        if (/ivs|wasmworker|twitch|ttvnw/i.test(src) && !(options && options.type === 'module')) {
          wrapped = URL.createObjectURL(new Blob([hookSource + '\nhookPlaylists();\n' + src], { type: 'text/javascript' }))
          window.__caravelTwitchWorkers = (window.__caravelTwitchWorkers || 0) + 1 // zur Fehlersuche
        }
      } catch {}
      super(wrapped || url, options)
    }
  }
}

// Skripttext für das Tab-Preload (läuft dort in der Hauptwelt vor den Seitenskripten)
const SCRIPT = `(${installTwitchAdSkip})(${hookPlaylists}, ${JSON.stringify(String(hookPlaylists))});`

const isTwitch = url => {
  try { return /(^|\.)twitch\.tv$/.test(new URL(url).hostname) } catch { return false }
}

module.exports = { twitchAdScript: url => isTwitch(url) ? SCRIPT : null }
