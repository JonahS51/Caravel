# Caravel – Hinweise für Claude

Caravel ist ein Electron-Browser (Electron 44 / Chromium 152) für Windows. Sprache des Projekts und der Antworten:
Deutsch (Oberfläche, Kommentare, Commit-Nachrichten). Der Ordner heißt noch `aether-browser` (früherer Name).
GitHub: https://github.com/JonahS51/Caravel (privat, Branch `main`).

## Befehle

```powershell
npm start          # Browser mit dem normalen Profil starten (%APPDATA%\Caravel)
npm run dist       # Installer bauen → dist\Caravel-Setup-3.0.0.exe (lädt Tor/wireproxy, erzeugt Symbole)
node --check <datei>   # schnelle Syntaxprüfung (es gibt keine Testsuite)
```

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
  `mcp-server.js` (Claude Code/Codex), `autodark.js` (Websites abdunkeln), `store.js` (JSON-Speicher + Standardwerte)
- `src/preload/ui-preload.js` – Brücke der Oberfläche; **neue IPC-Kanäle müssen dort in EVENTS/SENDS/INVOKES**
- `src/preload/tab-preload.js` – Preload jeder Webseite (sandboxed): Adblock-Scriptlets, Peek, Umgebungsfarbe,
  Neuer-Tab-API (`caravelNTP`), Presentation-API-Nachbau für das Cast SDK
- `src/ui/` – Oberfläche (`app.js` ist eine große Datei, gegliedert durch Kommentarblöcke), `styles.css`, `icons.js`
- `src/pages/` – interne `caravel://`-Seiten (Neuer Tab, Fehler, Sperrseite)
- `scripts/make-assets.js` – Logo/Symbole aus SVG; `scripts/fetch-vendor.js` – Tor und wireproxy

## Datenmodell (Auszug)

- Einstellungen in `store.js` → `DEFAULTS.settings` (neue Optionen dort mit Standardwert eintragen).
- Favoriten: `bookmarks` = Favoritenleiste; Einträge `{ id, url, title, favicon }` oder Ordner
  `{ id, folder: true, title, children: [...] }` (eine Ebene). Die Oberfläche ist die Quelle der Wahrheit
  (`S.data.bookmarks`, `saveBookmarks()`); die Neuer-Tab-Seite ändert sie über `ntp:bookmark`.

## Nutzer

- Nutzt das Tab-Layout **Safari** mit Favoritenleiste.
- Node.js wird für die Builds gebraucht – nicht deinstallieren, ohne zu fragen.
- Der Installer ist nicht signiert; Lizenz GPL-3.0 (wegen `electron-chrome-extensions`).

## Bekannte Grenzen

- Spiegeln per Chromecast hat einige Sekunden Verzögerung (WebM-Live-Stream statt Chromes Cast-Streaming).
- Kein Widevine/DRM. Claude in Chrome läuft nur über die Kompatibilitätsschicht (experimentell).
