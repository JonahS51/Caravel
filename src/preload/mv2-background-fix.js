// Korrektur für Manifest-V2-Hintergrundseiten (z. B. uBlock Origin).
//
// electron-chrome-extensions ergänzt chrome.* per Preload um APIs wie browserAction,
// contextMenus oder webNavigation. In Hintergrundseiten ohne Kontext-Isolation ersetzt
// Chromium das chrome-Objekt danach aber wieder durch die native Variante, und
// zusätzlich existiert ein natives `browser`-Objekt, das uBlock bevorzugt.
// Dieses Preload läuft nach dem der Bibliothek und hält beide Namen fest auf dem
// ergänzten Objekt.
if (!process.contextIsolated && location.href.startsWith('chrome-extension://') && globalThis.chrome) {
  const augmented = globalThis.chrome
  for (const name of ['chrome', 'browser']) {
    Object.defineProperty(globalThis, name, { get: () => augmented, set: () => {}, configurable: false })
  }
}
