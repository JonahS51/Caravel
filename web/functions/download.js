// /download → leitet auf den Installer des neuesten GitHub-Releases weiter.
// Die GitHub-API erlaubt ohne Anmeldung nur 60 Abfragen pro Stunde, deshalb wird die Antwort
// zehn Minuten im Cloudflare-Cache gehalten.

const REPO = 'JonahS51/Caravel'
const FALLBACK = `https://github.com/${REPO}/releases/latest`

export async function onRequestGet ({ request, waitUntil }) {
  const cache = caches.default
  const key = new Request(new URL('/download/latest.json', request.url))
  let res = await cache.match(key)
  if (!res) {
    const api = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'caravel-web' }
    })
    if (!api.ok) return Response.redirect(FALLBACK, 302)
    const release = await api.json()
    const asset = (release.assets || []).find(a => /^Caravel-Setup-.*\.exe$/.test(a.name))
    if (!asset) return Response.redirect(FALLBACK, 302)
    res = new Response(JSON.stringify({ url: asset.browser_download_url, version: release.tag_name }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' }
    })
    waitUntil(cache.put(key, res.clone()))
  }
  const { url } = await res.json()
  return Response.redirect(url, 302)
}
