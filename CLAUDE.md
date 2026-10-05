# Caravel – Hinweise für Claude

Caravel ist ein Electron-Browser (Electron 44 / Chromium 152) für Windows. Sprache des Projekts und der Antworten:
Deutsch (Oberfläche, Kommentare, Commit-Nachrichten). Der Ordner heißt noch `aether-browser` (früherer Name).
GitHub: https://github.com/JonahS51/Caravel (privat, Branch `main`).

## Befehle

```powershell
npm start          # Browser mit dem normalen Profil starten (%APPDATA%\Caravel)
npm run dist       # Installer bauen → dist\Caravel-Setup-<version>.exe (lädt Tor/wireproxy, erzeugt Symbole)
npm run release    # wie dist + Upload als Release nach JonahS51/Caravel-Releases (braucht $env:GH_TOKEN)
node --check <datei>   # schnelle Syntaxprüfung (es gibt keine Testsuite)
```

Updates: Installierte Versionen holen neue Versionen per electron-updater aus dem **öffentlichen** Repo
`JonahS51/Caravel-Releases` (`build.publish` in package.json; Code-Repo bleibt privat). Ein Release braucht
`Caravel-Setup-<v>.exe`, `.blockmap` und `latest.yml`. Nur nach Rückfrage veröffentlichen.

Git ist unter `C:\Program Files\Git\cmd` installiert (evtl. nicht im PATH der Konsole). Push funktioniert über den
gespeicherten Git Credential Manager; falls eine Anmeldung nötig ist, muss sie in einem eigenen, sichtbaren
PowerShell-Fenster ohne `GCM_INTERACTIVE`/`GIT_TERMINAL_PROMPT` laufen.

## Testen

- Zum Testen ein **eigenes Profil** verwenden: `$env:CARAVEL_PROFILE = '<ordner>'`, `$env:CARAVEL_DEBUG = '1'`,
  Start mit `node_modules\electron\dist\electron.exe . --remote-debugging-port=9333 --inspect=9229`.
  Über CDP (Port 9333) lässt sich die Oberfläche (`src/ui/index.html`) steuern und per `Page.captureScreenshot`
  fotografieren; Port 9229 ist der Hauptprozess (`globalThis.__debug` mit adblock, vpn, cast, crx, extensions).
- **Achtung:** Das Beenden von „electron.exe“ aus diesem Ordner beendet auch das Caravel des Nutzers, wenn er es per
  `npm start` offen hat – vorher Bescheid geben und danach wieder starten.
- **Chromecast nie auf die echten Geräte des Nutzers senden** (Sony-Fernseher, Home Mini, Chromecast Audio,
  Gruppe „Disco“), außer er erlaubt es ausdrücklich. Lesende Abfragen (Status, App-Verfügbarkeit) sind in Ordnung.
  Für Tests einen simulierten Empfänger mit `castv2/lib/server.js` auf 127.0.0.1 nutzen und ihn über
  `__debug.cast.discovery.devices` als einziges Gerät eintragen.

## Aufbau

- `src/main/main.js` – Hauptprozess: Fenster, Webview-Tabs, IPC, Kontextmenüs, Downloads, Berechtigungen
- `src/main/cast.js` – Chromecast: mDNS-Erkennung, castv2-Verbindungen, Cast-Apps von Webseiten (Presentation API),
  Tab-/Bildschirmspiegelung als WebM-Live-Stream, Medien/Dateien über den Standard-Medienempfänger
- `src/main/adblock.js`, `vpn.js` (Tor/WireGuard), `crx-compat.js` (Chrome-APIs für Erweiterungen),
  `mcp-server.js` (Claude Code/Codex), `autodark.js` (Websites abdunkeln), `store.js` (JSON-Speicher + Standardwerte),
  `updater.js` (electron-updater), `passwords.js` (Passwörter, DPAPI über safeStorage, `caravel-passwords.json`),
  `importer.js` (Favoriten/Verlauf aus Chrome/Edge/Brave; Verlauf per `node:sqlite` aus einer Kopie)
- **Privater Space** (Inkognito): Partition `caravel-private` (ohne `persist:`), Space mit `private: true`, wird nie
  gespeichert, kein Verlauf, keine Erweiterungen, für MCP-Agenten unsichtbar; der letzte geschlossene Tab löscht die Daten.
  Neue Funktionen, die Sitzungen betreffen (Handler, Proxy, Werbeblocker, Downloads), immer für **beide** Sitzungen einrichten.
- **Vor/Zurück-Verlauf** der Tabs (`tab.nav`) wird gespeichert; `navigationHistory.restore()` geht nur vor dem ersten Laden,
  daher setzt die Oberfläche als Startadresse eine Marke (`about:blank#caravel-restore=…`), die `will-attach-webview` abfängt.
- `view-source:` funktioniert in Webviews nicht → eigene Seite `caravel://source/?url=…`.
- Popup-Blocker: `setWindowOpenHandler` erlaubt neue Fenster nur bis 5 s nach einer Nutzereingabe (`input-event`).
- `src/preload/ui-preload.js` – Brücke der Oberfläche; **neue IPC-Kanäle müssen dort in EVENTS/SENDS/INVOKES**
- `src/preload/tab-preload.js` – Preload jeder Webseite (sandboxed): Adblock-Scriptlets, Peek, Umgebungsfarbe,
  Neuer-Tab-API (`caravelNTP`), Presentation-API-Nachbau für das Cast SDK
- `src/ui/` – Oberfläche (`app.js` ist eine große Datei, gegliedert durch Kommentarblöcke), `styles.css`, `icons.js`
- `src/pages/` – interne `caravel://`-Seiten (Neuer Tab, Fehler, Sperrseite)
- `src/shared/i18n.js` – Übersetzungen Deutsch/Englisch (siehe unten); interne Seiten laden es als `shared/i18n.js`
- `scripts/make-assets.js` – Logo/Symbole aus SVG; `scripts/fetch-vendor.js` – Tor und wireproxy

## Sprachen (Deutsch/Englisch)

- Einstellung `settings.language`: `'auto'` (Windows-Sprache), `'de'` oder `'en'`; wird beim Start festgelegt,
  ein Wechsel wirkt nach dem Neustart (die Oberfläche bietet ihn an).
- Der Quelltext bleibt deutsch, jeder sichtbare Text läuft durch die Übersetzung: in `app.js`, `newtab.js` und
  `status.js` heißt die Funktion `T('…')` (dort ist `t` schon die Tab-Variable), im Hauptprozess `t('…')`.
  Platzhalter: `T('{n} Tabs', { n })`. **Neue Texte immer auch in `EN` in `src/shared/i18n.js` eintragen.**
- Zentral übersetzt (kein `T()` nötig, nur der Eintrag in `EN`): Menüeinträge (`label`, `hint`), Toasts,
  `confirmDialog`, Befehle der Palette, `rowEl`-Aktionen. Tastennamen (Strg, Umschalt) übersetzt `T()` automatisch.
- Statische HTML-Texte (`index.html`, interne Seiten) übersetzt `translateDom()` beim Laden, wenn der Text genau
  einem Eintrag in `EN` entspricht.
- Datum/Zahlen mit `I18N.locale` formatieren, nicht fest mit `'de-DE'`.

## Datenmodell (Auszug)

- Einstellungen in `store.js` → `DEFAULTS.settings` (neue Optionen dort mit Standardwert eintragen).
- `sites` (pro Hostname: `zoom`, `popups`, `sound`), `permissions` (pro Origin; Kamera/Mikrofon getrennt als
  `media-video`/`media-audio`), `downloadHistory`, `pwNever`.
- Favoriten: `bookmarks` = Favoritenleiste; Einträge `{ id, url, title, favicon }` oder Ordner
  `{ id, folder: true, title, children: [...] }` (eine Ebene). Die Oberfläche ist die Quelle der Wahrheit
  (`S.data.bookmarks`, `saveBookmarks()`); die Neuer-Tab-Seite ändert sie über `ntp:bookmark`.

## Nutzer

- Nutzt das Tab-Layout **Safari** mit Favoritenleiste.
- Node.js wird für die Builds gebraucht – nicht deinstallieren, ohne zu fragen.
- Der Installer ist nicht signiert; Lizenz GPL-3.0 (wegen `electron-chrome-extensions`).

## Testen ohne Klicks (Erfahrungen)

- Native Dialoge (`dialog.showMessageBoxSync`, Speichern-Dialoge) blockieren den Hauptprozess – im Test vermeiden.
- Echte Nutzereingaben (Popup-Blocker, Passwort-Menü) über `webContents.sendInputEvent` im Hauptprozess senden,
  vor `mouseDown` ein `mouseMove`.

## Bekannte Grenzen

- Spiegeln per Chromecast hat einige Sekunden Verzögerung (WebM-Live-Stream statt Chromes Cast-Streaming).
- Kein Widevine/DRM. Claude in Chrome läuft nur über die Kompatibilitätsschicht (experimentell).
