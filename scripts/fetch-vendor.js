// Lädt die mitgelieferten Hilfsprogramme für das VPN nach vendor/:
//  - Tor (Expert Bundle, BSD-Lizenz) für den kostenlosen Tor-Modus mit Länderauswahl
//  - wireproxy (ISC-Lizenz) für WireGuard-Konfigurationen eigener VPN-Anbieter
// Ausführen mit: node scripts/fetch-vendor.js
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor')

const PACKAGES = [
  {
    name: 'tor',
    version: '15.0.24',
    url: v => `https://dist.torproject.org/torbrowser/${v}/tor-expert-bundle-windows-x86_64-${v}.tar.gz`,
    check: dir => fs.existsSync(path.join(dir, 'tor', 'tor.exe'))
  },
  {
    name: 'wireproxy',
    version: 'v1.1.3',
    url: v => `https://github.com/windtf/wireproxy/releases/download/${v}/wireproxy_windows_amd64.tar.gz`,
    check: dir => fs.existsSync(path.join(dir, 'wireproxy.exe'))
  }
]

async function download (url, file) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} beim Laden von ${url}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

;(async () => {
  fs.mkdirSync(VENDOR, { recursive: true })
  for (const pkg of PACKAGES) {
    const dir = path.join(VENDOR, pkg.name)
    const marker = path.join(dir, '.version')
    if (pkg.check(dir) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === pkg.version) {
      console.log(`${pkg.name} ${pkg.version} bereits vorhanden`)
      continue
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const archive = path.join(VENDOR, `${pkg.name}.tar.gz`)
    console.log(`Lade ${pkg.name} ${pkg.version} …`)
    await download(pkg.url(pkg.version), archive)
    execFileSync('tar', ['-xzf', archive, '-C', dir])
    fs.rmSync(archive)
    if (!pkg.check(dir)) throw new Error(`${pkg.name}: erwartete Datei fehlt nach dem Entpacken`)
    fs.writeFileSync(marker, pkg.version)
    console.log(`${pkg.name} ${pkg.version} bereit`)
  }
})().catch(err => {
  console.error(err)
  process.exit(1)
})
