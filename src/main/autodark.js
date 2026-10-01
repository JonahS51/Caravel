// Automatischer Dunkelmodus für Websites (wie Chromes „Auto Dark Mode for Web Contents“).
// Chromium dunkelt dabei nur Seiten ab, die keinen eigenen Dunkelmodus haben; Seiten mit
// dunklem Farbschema bleiben unverändert. Gesteuert pro Tab über das DevTools-Protokoll,
// daher ohne Neustart umschaltbar. Teilt sich den Debugger mit chrome.debugger (crx-compat).
const tracked = new Set()
let enabled = false

function apply (wc) {
  if (wc.isDestroyed()) return
  try {
    if (!wc.debugger.isAttached()) {
      if (!enabled) return
      wc.debugger.attach('1.3')
    }
    wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride', enabled ? { enabled: true } : {}).catch(() => {})
  } catch {}
}

function track (wc) {
  if (tracked.has(wc)) return
  tracked.add(wc)
  // Electron trennt den Debugger z. B. bei Prozesswechseln oder wenn eine Erweiterung ihn
  // wieder freigibt – solange der Tab lebt, die Einstellung erneut setzen
  wc.debugger.on('detach', () => {
    if (enabled) setTimeout(() => apply(wc), 50)
  })
  // Die Überschreibung gilt je Dokument – nach jeder Navigation erneut setzen
  wc.on('did-navigate', () => { if (enabled) apply(wc) })
  wc.once('destroyed', () => tracked.delete(wc))
  apply(wc)
}

function setEnabled (on) {
  if (on === enabled) return
  enabled = on
  for (const wc of tracked) apply(wc)
}

module.exports = { track, setEnabled }
