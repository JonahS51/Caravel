// Erzeugt Programmsymbol (PNG/ICO), Installer-Grafik (BMP) und die Logo-Dateien in
// branding/ aus dem SVG-Logo. Ausführen mit: npx electron scripts/make-assets.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// Caravel-Logo: Karavelle mit Dreieckssegel und Vorsegel vor einer tiefstehenden Sonne.
// Die Formen sind für Programmsymbol und freistehendes Logo identisch, nur die Farben wechseln.
const SHAPES = c => `
  <circle cx="146" cy="112" r="62" fill="url(#sun)"/>
  <path d="M118 30v140" stroke="${c.mast}" stroke-width="7" stroke-linecap="round"/>
  <path d="M121 30l30 9-30 9z" fill="${c.flag}"/>
  <path d="M126 50c46 28 70 72 68 112h-68z" fill="${c.sail}"/>
  <path d="M110 70c-26 24-42 56-44 92h44z" fill="${c.fore}"/>
  <path d="M40 174h176c-8 26-36 42-88 42s-80-16-88-42z" fill="${c.hull}"/>
  <path d="M84 196h88" stroke="${c.stripe}" stroke-width="5" stroke-linecap="round"/>`

const SUN = `<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#f2545b"/></linearGradient>`

// Programmsymbol: abgerundete Kachel in Nachtblau, Silhouette in Cremeweiß
const ICON = size => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}">
  <defs>
    ${SUN}
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16295a"/><stop offset="1" stop-color="#0a1330"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#tile)"/>
  ${SHAPES({ mast: '#fff6ea', flag: '#ffb35c', sail: '#fff6ea', fore: '#ffe0c2', hull: '#fff6ea', stripe: '#f2545b' })}
</svg>`

// Freistehendes Logo ohne Hintergrund – für helle Untergründe (Silhouette Nachtblau)
const MARK_DARK = size => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 18 216 216" width="${size}" height="${size}">
  <defs>${SUN}</defs>
  ${SHAPES({ mast: '#13254d', flag: '#f2545b', sail: '#13254d', fore: '#2b4a8a', hull: '#13254d', stripe: '#ffb35c' })}
</svg>`

// Freistehendes Logo ohne Hintergrund – für dunkle Untergründe (Silhouette Cremeweiß)
const MARK_LIGHT = size => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 18 216 216" width="${size}" height="${size}">
  <defs>${SUN}</defs>
  ${SHAPES({ mast: '#fff6ea', flag: '#ffb35c', sail: '#fff6ea', fore: '#ffe0c2', hull: '#fff6ea', stripe: '#f2545b' })}
</svg>`

// Hauptlogo, freistehend und transparent: kräftige Mitteltöne, die auf hellem wie dunklem
// Untergrund (Taskleiste, Desktop, Browser) gut erkennbar bleiben
const COLOR_FILL = { mast: '#2a4fae', flag: '#f2545b', sail: '#3f74e0', fore: '#86a9f2', hull: '#2a4fae', stripe: '#ffb35c' }
const MARK_COLOR = size => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 18 216 216" width="${size}" height="${size}">
  <defs>${SUN}</defs>
  ${SHAPES(COLOR_FILL)}
</svg>`

const LOGO = MARK_COLOR
const page = svg => `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
const ICON_HTML = page(ICON(512))

const SIDEBAR_HTML = `<html><body style="margin:0;width:164px;height:314px;overflow:hidden;font-family:'Segoe UI Variable Display','Segoe UI',sans-serif;
  background:linear-gradient(180deg,#16295a 0%,#0a1330 70%,#0a1330 100%);position:relative;color:#fff">
  <div style="position:absolute;width:240px;height:240px;left:-40px;top:150px;border-radius:50%;background:#f2545b;filter:blur(70px);opacity:.35"></div>
  <div style="position:absolute;width:180px;height:180px;right:-70px;top:-50px;border-radius:50%;background:#ffb35c;filter:blur(60px);opacity:.22"></div>
  <div style="position:relative;padding:54px 0 0;text-align:center">
    <div style="filter:drop-shadow(0 10px 24px rgba(242,84,91,.4))">${LOGO(76)}</div>
    <div style="font-size:28px;font-weight:650;letter-spacing:.5px;margin-top:16px">Caravel</div>
    <div style="font-size:11.5px;opacity:.72;margin-top:4px;letter-spacing:.2px">Entdecke das Web</div>
  </div>
  <div style="position:absolute;left:0;right:0;bottom:22px;text-align:center;font-size:9px;opacity:.5;letter-spacing:1px;text-transform:uppercase">Claude · VPN · Adblock</div>
</body></html>`

async function render (html, width, height) {
  const win = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: true }
  })
  const tmp = path.join(app.getPath('temp'), `caravel-asset-${Date.now()}.html`)
  fs.writeFileSync(tmp, '<!doctype html><meta charset="utf-8">' + html)
  // Bild direkt aus dem Offscreen-Renderer übernehmen (capturePage scheitert bei großen Flächen)
  let frame = null
  win.webContents.on('paint', (_e, _dirty, image) => { frame = image })
  win.webContents.setFrameRate(10)
  await win.loadFile(tmp)
  await new Promise(r => setTimeout(r, 900))
  win.webContents.invalidate()
  await new Promise(r => setTimeout(r, 400))
  const img = frame || await win.webContents.capturePage()
  win.destroy()
  fs.rmSync(tmp, { force: true })
  return img.resize({ width, height, quality: 'best' })
}

// SVG in beliebiger Größe verlustfrei als PNG mit Alphakanal rastern (über ein Canvas,
// dessen Größe – anders als ein Fenster – nicht durch den Bildschirm begrenzt ist)
async function rasterSvg (svg, size) {
  const { nativeImage } = require('electron')
  const win = new BrowserWindow({ width: 200, height: 200, show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<meta charset="utf-8">')
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${size}; c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG konnte nicht geladen werden'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
  })`)
  win.destroy()
  return nativeImage.createFromDataURL(dataUrl)
}

function toIco (images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  const blobs = []
  let offset = 6 + images.length * 16
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
    blobs.push(png)
  }
  return Buffer.concat([header, ...entries, ...blobs])
}

function toBmp24 (img) {
  const { width, height } = img.getSize()
  const bgra = img.toBitmap()
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const size = 54 + rowSize * height
  const buf = Buffer.alloc(size)
  buf.write('BM', 0)
  buf.writeUInt32LE(size, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  buf.writeInt32LE(2835, 38)
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const src = height - 1 - y
    for (let x = 0; x < width; x++) {
      const i = (src * width + x) * 4
      const o = 54 + y * rowSize + x * 3
      buf[o] = bgra[i]
      buf[o + 1] = bgra[i + 1]
      buf[o + 2] = bgra[i + 2]
    }
  }
  return buf
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {}) // nicht beenden, solange noch gerendert wird
app.whenReady().then(async () => {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
  fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true })

  const big = await rasterSvg(MARK_COLOR(512), 512)
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), big.toPNG())
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'icon.png'), big.resize({ width: 256, height: 256, quality: 'best' }).toPNG())

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const ico = toIco(sizes.map(size => ({ size, png: big.resize({ width: size, height: size, quality: 'best' }).toPNG() })))
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico)

  const sidebar = await render(SIDEBAR_HTML, 164, 314)
  fs.writeFileSync(path.join(ROOT, 'build', 'installerSidebar.bmp'), toBmp24(sidebar))
  if (process.env.PREVIEW) fs.writeFileSync(process.env.PREVIEW, sidebar.toPNG())

  // Logo-Dateien mit transparentem Hintergrund (1024 × 1024 px) und als SVG
  const brand = path.join(ROOT, 'branding')
  fs.mkdirSync(brand, { recursive: true })
  const variants = {
    'caravel-logo': MARK_COLOR,
    'caravel-logo-dunkel': MARK_DARK,
    'caravel-logo-hell': MARK_LIGHT,
    'caravel-kachel': ICON
  }
  for (const [name, fn] of Object.entries(variants)) {
    const img = await rasterSvg(fn(1024), 1024)
    fs.writeFileSync(path.join(brand, `${name}.png`), img.toPNG())
    fs.writeFileSync(path.join(brand, `${name}.svg`), fn(1024).trim() + '\n')
  }

  console.log('Assets erstellt: build/icon.ico, build/icon.png, build/installerSidebar.bmp, src/assets/icon.png, branding/*.png|svg')
  app.quit()
})
