# Caravel – Entdecke das Web

Chromium-Browser (Electron 44) mit Claude-Integration, Werbeblocker auf Basis der uBlock-Origin-Filterlisten,
eingebautem VPN, Chrome-Erweiterungen und Chromecast.

## Installation

`dist/Caravel-Setup-3.0.0.exe` ausführen. Der Installer fragt nach dem Zielordner, legt Verknüpfungen an und
registriert Caravel in den Windows-„Standard-Apps“ als Browser. Das installierte Programm braucht kein Node.js.

## Funktionen

| Funktion | Bedienung |
|---|---|
| **KI-Assistent wählbar** – Claude, ChatGPT oder keiner | Einstellungen › KI-Assistent |
| **KI-Seitenleiste** – claude.ai bzw. chatgpt.com neben jeder Seite (abschaltbar) | `Strg+E`, Knopf „Claude“/„ChatGPT“ |
| **Seite an die KI übergeben / zusammenfassen**, Auswahl erklären/übersetzen | `Strg+Umschalt+L`, Rechtsklick |
| **Claude in Chrome** – offizielle Erweiterung über eine Kompatibilitätsschicht | Einstellungen › KI-Assistent (Claude) |
| **MCP-Server für Claude Code und Codex** – Tabs öffnen, lesen, klicken, ausfüllen, Screenshots | Einstellungen › KI-Assistent |
| **Werbeblocker** mit uBlock-Origin-Listen inkl. YouTube-Werbung | Schild in der Adressleiste |
| **VPN** – Tor mit Länderwahl (kostenlos) oder eigene Server (WireGuard, SOCKS5, HTTP) | „VPN“ oben rechts |
| **Tab-Leiste wählbar** – Caravel (Seitenleiste), Chrome (oben) oder Safari (unter der Adressleiste), Favoritenleiste, kompakte Darstellung | Einstellungen › Darstellung |
| **Websites abdunkeln** – Seiten ohne eigenen Dunkelmodus werden im dunklen Design automatisch dunkel | Einstellungen › Darstellung |
| **Spaces**, **Split View**, **Peek**, **Befehlspalette** | Space-Symbole, `Strg+Umschalt+S`, Umschalt+Klick, `Strg+K` |
| **Fokus-Modus**, **Seiten-Notizen**, **Zeitkapseln**, **Tab-Schlaf** | `Strg+Umschalt+F`, `Strg+Umschalt+N`, Seitenleiste |
| **Leser-Modus mit Vorlesen**, **Seite als Markdown kopieren** | `F9`, Rechtsklick |
| **Chrome-Erweiterungen** aus dem Chrome Web Store | Web Store › „Hinzufügen“ |
| **Chromecast** – YouTube, Videos der Seite, lokale Dateien | Cast-Symbol |

### Claude Code anbinden

Einstellungen › KI-Assistent › Claude › „Caravel als MCP-Server für Claude Code“ einschalten und den angezeigten Befehl einmal ausführen:

```
claude mcp add --transport http --scope user caravel http://127.0.0.1:47823/mcp --header "Authorization: Bearer <Token>"
```

### Codex anbinden

Einstellungen › KI-Assistent › ChatGPT › „Caravel als MCP-Server für Codex“ einschalten und „In Codex eintragen“ klicken.
Caravel ergänzt dann `~/.codex/config.toml` (ein vorhandener Caravel-Eintrag wird ersetzt, alles andere bleibt):

```toml
[mcp_servers.caravel]
url = "http://127.0.0.1:47823/mcp"
http_headers = { "Authorization" = "Bearer <Token>" }
```

Werkzeuge: `list_tabs`, `open_tab`, `select_tab`, `close_tab`, `navigate`, `read_page`, `snapshot`, `click`, `fill`,
`press_key`, `scroll`, `screenshot`, `evaluate`, `wait_for`. Der Server lauscht nur auf 127.0.0.1 und verlangt das Token.

## Entwicklung

```powershell
npm install
npm run vendor     # Tor und wireproxy nach vendor/ laden
npm start          # Browser starten
npm run dist       # Programme laden, Symbole erzeugen, Installer bauen → dist/
```

Aufbau:

- `src/main/` – Hauptprozess: `main.js`, `adblock.js` (Werbeblocker), `vpn.js`, `crx-compat.js`
  (fehlende Chrome-APIs für Erweiterungen), `mcp-server.js` (Claude Code), `focus.js`, `cast.js`, `store.js`
- `src/preload/` – Brücken: Oberfläche, Tabs, Kompatibilitätsschicht (`crx-early.js`, `crx-late.js`)
- `src/ui/` – Browser-Oberfläche (Tabs sind `<webview>`-Elemente)
- `src/pages/` – interne `caravel://`-Seiten
- `scripts/` – `fetch-vendor.js` (Tor, wireproxy), `make-assets.js` (Logo → ICO/PNG/Installer-Grafik)

## Technische Hinweise und Grenzen

- **Werbeblocker:** uBlock Origin als Erweiterung funktioniert in Electron nicht, weil Electron Erweiterungen bei jeder
  Netzwerkanfrage die Tab-ID -1 meldet. Caravel nutzt deshalb `@ghostery/adblocker` mit uBlocks eigenen Listen und führt
  deren Skriptfilter synchron beim Seitenstart aus.
- **Claude in Chrome:** Caravel bildet `sidePanel`, `debugger`, `tabGroups`, `offscreen`, `identity`, `declarativeNetRequest`
  (Header-Regeln) und `runtime.getContexts` nach. Anthropic unterstützt offiziell nur Chrome, Edge und Brave –
  experimentell.
- **VPN:** gilt nur für den Browser. Der erste Tor-Start lädt das Relay-Verzeichnis und kann einige Minuten dauern.
  Tor verbirgt die IP, bietet aber nicht die Anonymität des Tor Browsers.
- **Chromecast:** kein Spiegeln ganzer Tabs, keine DRM-Streams.
- Der Installer ist nicht code-signiert (SmartScreen-Warnung beim ersten Start).
- Lizenz: GPL-3.0 (wegen `electron-chrome-extensions`).
