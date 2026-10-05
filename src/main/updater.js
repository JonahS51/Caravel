// Automatische Updates über GitHub-Releases (electron-updater).
//
// Der Quellcode liegt in einem privaten Repo, die Installer in einem öffentlichen Release-Repo
// (siehe "publish" in package.json). Caravel prüft beim Start und alle 4 Stunden, lädt ein neues
// Release im Hintergrund und installiert es auf Knopfdruck oder beim nächsten Beenden.
// Nur im installierten Programm aktiv – mit „npm start“ gibt es nichts zu aktualisieren.
const { app } = require('electron')
const { t } = require('../shared/i18n')

const CHECK_EVERY = 4 * 60 * 60 * 1000

class Updater {
  constructor ({ send, getSettings }) {
    this.send = send
    this.getSettings = getSettings
    this.state = { status: 'idle', version: null, progress: 0, error: null, checked: 0, supported: app.isPackaged }
    this.timer = null
    this.au = null
    if (!app.isPackaged) return
    const { autoUpdater } = require('electron-updater')
    this.au = autoUpdater
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }))
    autoUpdater.on('update-available', info => this.set({ status: 'downloading', version: info.version, progress: 0 }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', checked: Date.now() }))
    autoUpdater.on('download-progress', p => this.set({ progress: Math.round(p.percent || 0) }))
    autoUpdater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version, progress: 100, checked: Date.now() }))
    autoUpdater.on('error', err => this.set({ status: 'error', error: this.describe(err) }))
  }

  describe (err) {
    const msg = String(err?.message || err)
    if (/404|HttpError: 404/.test(msg)) return t('Keine Releases gefunden (Release-Repo fehlt oder ist privat).')
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/.test(msg)) return t('Keine Verbindung zum Update-Server.')
    return msg.split('\n')[0].slice(0, 200)
  }

  set (patch) {
    Object.assign(this.state, patch)
    this.send('update:state', { ...this.state })
  }

  start () {
    if (!this.au) return
    clearInterval(this.timer)
    this.timer = setInterval(() => { if (this.getSettings().autoUpdate !== false) this.check() }, CHECK_EVERY)
    if (this.getSettings().autoUpdate !== false) setTimeout(() => this.check(), 15000)
  }

  async check () {
    if (!this.au) {
      this.set({ status: 'error', error: t('Updates gibt es nur in der installierten Version.') })
      return this.state
    }
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.state
    try { await this.au.checkForUpdates() } catch (err) { this.set({ status: 'error', error: this.describe(err) }) }
    return this.state
  }

  install () {
    // still installieren (ohne Installer-Assistent) und Caravel danach wieder starten
    if (this.au && this.state.status === 'ready') this.au.quitAndInstall(true, true)
  }
}

module.exports = { Updater }
