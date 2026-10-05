// Preload für die Browser-Oberfläche: stellt eine eng begrenzte API bereit.
const { contextBridge, ipcRenderer, webUtils } = require('electron')
const fs = require('node:fs')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

injectBrowserAction()

const EVENTS = new Set([
  'shortcut', 'open-tab', 'ctx-action', 'ext:create-tab', 'ext:select-tab', 'ext:remove-tab', 'ext:changed',
  'adblock:blocked', 'adblock:status', 'dl:update', 'perm:request', 'perm:saved', 'cast:devices', 'cast:sessions', 'cast:ended',
  'cast:pick', 'cast:error', 'ntp:bookmark', 'window-fullscreen',
  'vpn:state', 'crx:tabgroups', 'crx:sidepanel-open', 'crx:sidepanel-close', 'crx:debugger', 'mcp:ui',
  'popup:blocked', 'device:pick', 'device:update', 'cert:override', 'update:state', 'pw:offer', 'tab:audible'
])
const SENDS = new Set([
  'store:set', 'ui:ready', 'ui:reply', 'ui:titlebar', 'ui:accent', 'ui:peek-wc', 'ui:fullscreen', 'ui:webview',
  'tab:activated', 'tab:back', 'dl:open', 'dl:show', 'dl:control', 'dl:retry', 'perm:respond', 'cast:scan', 'cast:idle', 'cast:control', 'cast:stop',
  'cast:mirror-data', 'cast:mirror-end', 'focus:set',
  'app:default-browser', 'app:relaunch', 'clipboard:write', 'crx:sidepanel-closed',
  'popup:open', 'update:install', 'pw:offer-reply'
])
const INVOKES = new Set([
  'store:all', 'app:lang', 'tab:screenshot', 'suggest', 'ext:list', 'ext:remove', 'ext:load-unpacked', 'ext:newtab-override',
  'cast:play', 'cast:pick-file', 'cast:availability', 'cast:page-app', 'cast:start-app', 'cast:mirror-prepare',
  'cast:mirror-start', 'data:clear', 'app:info', 'adblock:info', 'adblock:update',
  'claude:status', 'claude:install-extension', 'claude:open-extension', 'claude:mcp-new-token', 'codex:install-mcp',
  'vpn:state', 'vpn:connect', 'vpn:disconnect', 'vpn:new-identity', 'vpn:set-country', 'vpn:import-wireguard',
  'tab:history', 'tab:prepare-restore', 'tab:save-page', 'app:open-file', 'app:file-url', 'app:pick-folder',
  'private:clear', 'site:clear-data', 'update:state', 'update:check',
  'pw:list', 'pw:reveal', 'pw:delete', 'pw:update', 'pw:never-remove', 'pw:import', 'pw:export',
  'import:sources', 'import:run'
])

const sources = {}
function source (id, file) {
  if (!sources[id]) sources[id] = fs.readFileSync(require.resolve(file), 'utf8')
  return sources[id]
}

contextBridge.exposeInMainWorld('caravel', {
  on (channel, cb) {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, ...args) => cb(...args))
  },
  send (channel, ...args) {
    if (SENDS.has(channel)) ipcRenderer.send(channel, ...args)
  },
  invoke (channel, ...args) {
    if (INVOKES.has(channel)) return ipcRenderer.invoke(channel, ...args)
    return Promise.reject(new Error('Kanal nicht erlaubt: ' + channel))
  },
  // Pfad einer ins Fenster gezogenen Datei (Drag & Drop)
  pathForFile: file => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  readabilitySource: () => source('readability', '@mozilla/readability/Readability.js'),
  turndownSource: () => source('turndown', 'turndown/dist/turndown.js')
})
